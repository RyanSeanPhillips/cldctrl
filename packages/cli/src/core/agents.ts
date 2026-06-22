/**
 * CLI coding agents cldctrl can drive (vendor-neutral). Each resolves to an
 * executable via, in priority order:
 *   1. config.agent_paths[id]      (explicit, set by the user or set_agent_path)
 *   2. env CLDCTRL_<ID>_PATH        (explicit override)
 *   3. the command on PATH          (normal install)
 *   4. platform app-bundle fallbacks (e.g. the OpenAI Codex app's codex.exe)
 * and a headless invocation used by `consult_agent`. Consults run READ-ONLY.
 */
import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { isCommandAvailable } from './platform.js';
import { getCleanEnv } from './launcher.js';
import { loadConfig, saveConfig } from '../config.js';
import { log } from './logger.js';

export interface AgentDef {
  id: string;
  label: string;
  cmdName: string;                                   // command to look for on PATH
  headless: (prompt: string, cwd?: string) => string[];
  fallbacks: () => string[];                         // candidate full paths off PATH
}

/** The OpenAI Codex app bundles codex.exe in a hashed bin dir, off PATH. */
function codexFallbacks(): string[] {
  const out: string[] = [];
  const la = process.env.LOCALAPPDATA;
  if (la) {
    const binRoot = path.join(la, 'OpenAI', 'Codex', 'bin');
    try {
      const exes = fs.readdirSync(binRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(binRoot, d.name, 'codex.exe'))
        .filter((e) => { try { return fs.statSync(e).isFile(); } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // newest first
      out.push(...exes);
    } catch { /* not installed here */ }
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    out.push(path.join(home, 'Library', 'Application Support', 'OpenAI', 'Codex', 'bin', 'codex')); // macOS
    out.push(path.join(home, '.local', 'share', 'OpenAI', 'Codex', 'bin', 'codex'));                 // Linux
  }
  out.push('/Applications/Codex.app/Contents/MacOS/codex'); // macOS app bundle
  return out;
}

export const AGENTS: AgentDef[] = [
  { id: 'claude', label: 'Claude', cmdName: 'claude', headless: (p) => ['-p', p], fallbacks: () => [] },
  {
    id: 'codex', label: 'Codex', cmdName: 'codex',
    headless: (p, cwd) => ['exec', '--sandbox', 'read-only', ...(cwd ? ['-C', cwd] : []), p],
    fallbacks: codexFallbacks,
  },
  { id: 'gemini', label: 'Gemini', cmdName: 'gemini', headless: (p) => ['-p', p], fallbacks: () => [] },
];

export type AgentSource = 'config' | 'env' | 'path' | 'app';
export interface ResolvedAgent { path: string; source: AgentSource }

const resolveCache = new Map<string, ResolvedAgent | null>();
/** Clear the resolution cache (after a config change). */
export function clearAgentCache(): void { resolveCache.clear(); }

function envKey(id: string): string { return 'CLDCTRL_' + id.toUpperCase() + '_PATH'; }

/** Resolve an agent to an executable + how it was found, or null. */
export function resolveAgent(id: string): ResolvedAgent | null {
  if (resolveCache.has(id)) return resolveCache.get(id)!;
  const a = AGENTS.find((x) => x.id === id);
  let result: ResolvedAgent | null = null;
  if (a) {
    // 1. config override
    try {
      const p = loadConfig().config.agent_paths?.[id];
      if (p && fs.existsSync(p)) result = { path: p, source: 'config' };
    } catch { /* ignore */ }
    // 2. env override
    if (!result) { const ev = process.env[envKey(id)]; if (ev && fs.existsSync(ev)) result = { path: ev, source: 'env' }; }
    // 3. PATH
    if (!result && isCommandAvailable(a.cmdName)) result = { path: a.cmdName, source: 'path' };
    // 4. platform fallbacks
    if (!result) {
      for (const cand of a.fallbacks()) {
        try { if (fs.statSync(cand).isFile()) { result = { path: cand, source: 'app' }; break; } } catch { /* skip */ }
      }
    }
  }
  resolveCache.set(id, result);
  return result;
}

export function listAgents(): Array<{ id: string; label: string; available: boolean; path: string | null; source: AgentSource | null }> {
  return AGENTS.map((a) => {
    const r = resolveAgent(a.id);
    return { id: a.id, label: a.label, available: !!r, path: r?.path ?? null, source: r?.source ?? null };
  });
}

/** Interactive command for a cockpit terminal (defaults to claude). */
export function agentCommand(agentId?: string): string {
  return resolveAgent(agentId ?? 'claude')?.path ?? 'claude';
}

/** Persist an explicit path for an agent (the connect path Claude Code can set). */
export function setAgentPath(id: string, exePath: string): { ok: boolean; error?: string } {
  if (!AGENTS.some((a) => a.id === id)) return { ok: false, error: 'Unknown agent: ' + id };
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'No file at: ' + exePath };
  try {
    const { config } = loadConfig();
    config.agent_paths = { ...(config.agent_paths ?? {}), [id]: exePath };
    saveConfig(config);
    clearAgentCache();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

export interface ConsultResult { ok: boolean; agent: string; output?: string; error?: string }

/** Run `prompt` through another agent non-interactively and return its reply. */
export function consultAgent(agentId: string, prompt: string, cwd?: string, timeoutMs = 240_000): Promise<ConsultResult> {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a) return Promise.resolve({ ok: false, agent: agentId, error: 'Unknown agent: ' + agentId });
  const r = resolveAgent(agentId);
  if (!r) return Promise.resolve({ ok: false, agent: agentId, error: a.label + ' is not installed / could not be located. Set its path with set_agent_path.' });

  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (res: ConsultResult) => { if (!done) { done = true; resolve(res); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(r.path, a.headless(prompt, cwd), { cwd: cwd || undefined, env: getCleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, agent: agentId, error: String(e) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, agent: agentId, error: 'Timed out after ' + Math.round(timeoutMs / 1000) + 's' }); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); if (out.length > 300_000) { try { child.kill(); } catch { /* ignore */ } } });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); log('error', { function: 'consultAgent', message: String(e) }); finish({ ok: false, agent: agentId, error: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (text) finish({ ok: true, agent: agentId, output: text.slice(0, 16_000) });
      else finish({ ok: false, agent: agentId, error: (err.trim() || 'exited ' + code).slice(0, 400) });
    });
  });
}
