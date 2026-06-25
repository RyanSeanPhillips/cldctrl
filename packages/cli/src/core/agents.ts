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
  // ── threaded consult (optional) ──
  // When an agent supports resuming a headless session, these let consult_agent
  // hold a multi-turn conversation: startJson begins one (and its output carries
  // a vendor session id), resumeJson continues that SAME session, and parseConsult
  // extracts both the reply text and the session id from the (JSON/JSONL) output.
  // Agents without these run one-shot/stateless (each consult starts cold).
  startJson?: (prompt: string, cwd?: string) => string[];
  resumeJson?: (sessionId: string, prompt: string, cwd?: string) => string[];
  parseConsult?: (stdout: string) => { text: string; sessionId?: string };
}

/** Parse Codex `exec --json` JSONL: the session id rides on `thread.started`,
 *  the reply on `item.completed` items of type `agent_message`. */
function parseCodexJsonl(stdout: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined;
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev: any;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') parts.push(ev.item.text);
  }
  return { text: parts.join('\n').trim(), sessionId };
}

/** Parse Claude `-p --output-format json`: a single object with `result` + `session_id`. */
function parseClaudeJson(stdout: string): { text: string; sessionId?: string } {
  try {
    const j = JSON.parse(stdout.trim());
    return { text: typeof j.result === 'string' ? j.result : stdout.trim(), sessionId: typeof j.session_id === 'string' ? j.session_id : undefined };
  } catch { return { text: stdout.trim() }; }
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
  {
    id: 'claude', label: 'Claude', cmdName: 'claude',
    headless: (p) => ['-p', p],
    startJson: (p) => ['-p', '--output-format', 'json', p],          // cwd via spawn cwd
    resumeJson: (sid, p) => ['-p', '--resume', sid, '--output-format', 'json', p],
    parseConsult: parseClaudeJson,
    fallbacks: () => [],
  },
  {
    id: 'codex', label: 'Codex', cmdName: 'codex',
    // --skip-git-repo-check lets exec run outside a git repo (control plane /
    // non-repo dirs); safe since the sandbox is already read-only.
    headless: (p, cwd) => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...(cwd ? ['-C', cwd] : []), p],
    startJson: (p, cwd) => ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...(cwd ? ['-C', cwd] : []), p],
    // `exec resume` keeps the original session's cwd/sandbox; it takes neither -C
    // nor --sandbox, so we pass only the id + --json (read-only is its default).
    resumeJson: (sid, p) => ['exec', 'resume', sid, '--json', '--skip-git-repo-check', p],
    parseConsult: parseCodexJsonl,
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
  const def = AGENTS.find((a) => a.id === id);
  if (!def) return { ok: false, error: 'Unknown agent: ' + id };
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'No file at: ' + exePath };
  // The connect-path must point at the agent's OWN binary — not an arbitrary
  // executable. This blocks a prompt-injected MCP caller from registering, say,
  // cmd.exe/powershell as the "agent" that consult_agent later spawns headless.
  const base = path.basename(exePath).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
  if (base !== def.cmdName) {
    return { ok: false, error: `Path must point at the "${def.cmdName}" binary (got "${base}")` };
  }
  try {
    const { config } = loadConfig();
    config.agent_paths = { ...(config.agent_paths ?? {}), [id]: exePath };
    saveConfig(config);
    clearAgentCache();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** Turn raw agent stderr into a shorter, clearer message for common failures. */
function friendlyError(raw: string): string {
  const low = raw.toLowerCase();
  if (low.includes('trusted directory') || low.includes('git-repo-check')) {
    return 'The agent refused the directory (git trust check). cldctrl passes --skip-git-repo-check; if this persists, update the agent CLI.';
  }
  if (low.includes('not logged in') || low.includes('unauthorized') || low.includes('auth')) {
    return 'The agent appears unauthenticated — sign in to its CLI, then retry. (' + raw.slice(0, 160) + ')';
  }
  return raw.slice(0, 400);
}

export interface ConsultResult { ok: boolean; agent: string; output?: string; error?: string; sessionId?: string; threaded?: boolean }
export interface ConsultOpts {
  cwd?: string;
  /** Vendor session id to RESUME (continue a prior consult) — from a previous result's sessionId. */
  resumeId?: string;
  timeoutMs?: number;
}

/**
 * Run `prompt` through another agent non-interactively and return its reply.
 * When the agent supports threaded consult (parseConsult defined), uses its
 * JSON output to capture a vendor `sessionId`, and — if `resumeId` is given —
 * RESUMES that session so the agent keeps the prior turns' context.
 */
export function consultAgent(agentId: string, prompt: string, opts: ConsultOpts = {}): Promise<ConsultResult> {
  const { cwd, resumeId, timeoutMs = 240_000 } = opts;
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a) return Promise.resolve({ ok: false, agent: agentId, error: 'Unknown agent: ' + agentId });
  const r = resolveAgent(agentId);
  if (!r) return Promise.resolve({ ok: false, agent: agentId, error: a.label + ' is not installed / could not be located. Set its path with set_agent_path.' });

  const threaded = !!a.parseConsult && !!a.startJson;
  const args = !threaded
    ? a.headless(prompt, cwd)
    : (resumeId && a.resumeJson ? a.resumeJson(resumeId, prompt, cwd) : a.startJson!(prompt, cwd));

  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (res: ConsultResult) => { if (!done) { done = true; resolve(res); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(r.path, args, { cwd: cwd || undefined, env: getCleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, agent: agentId, error: String(e) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, agent: agentId, error: 'Timed out after ' + Math.round(timeoutMs / 1000) + 's' }); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); if (out.length > 2_000_000) { try { child.kill(); } catch { /* ignore */ } } });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); log('error', { function: 'consultAgent', message: String(e) }); finish({ ok: false, agent: agentId, error: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (threaded && a.parseConsult) {
        const parsed = a.parseConsult(out);
        if (parsed.text) finish({ ok: true, agent: agentId, output: parsed.text.slice(0, 16_000), sessionId: parsed.sessionId, threaded: true });
        else finish({ ok: false, agent: agentId, error: friendlyError(err.trim() || 'no reply (exited ' + code + ')'), threaded: true });
        return;
      }
      const text = out.trim();
      if (text) finish({ ok: true, agent: agentId, output: text.slice(0, 16_000) });
      else finish({ ok: false, agent: agentId, error: friendlyError(err.trim() || 'exited ' + code) });
    });
  });
}
