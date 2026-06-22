/**
 * CLI coding agents cldctrl can drive (vendor-neutral). Each resolves to an
 * executable (PATH or a known install location) and a headless invocation used
 * by `consult_agent` — running an idea/plan/draft through another agent and
 * capturing its reply. Codex consults run READ-ONLY: the agent may read repo
 * files for context but cannot modify them — it's a second opinion, not an actor.
 */
import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { isCommandAvailable } from './platform.js';
import { getCleanEnv } from './launcher.js';
import { log } from './logger.js';

/** The OpenAI Codex app bundles codex.exe in a hashed bin dir, off PATH. */
let codexCache: string | null | undefined;
function resolveCodex(): string | null {
  if (codexCache !== undefined) return codexCache;
  if (isCommandAvailable('codex')) return (codexCache = 'codex');
  try {
    const binRoot = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    let best: string | null = null, bestM = 0;
    for (const d of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const exe = path.join(binRoot, d.name, 'codex.exe');
      try { const st = fs.statSync(exe); if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = exe; } } catch { /* skip */ }
    }
    return (codexCache = best);
  } catch { return (codexCache = null); }
}

export interface AgentDef {
  id: string;
  label: string;
  /** Resolved executable (path or PATH name), or null if not installed. */
  resolve: () => string | null;
  /** Args for a one-shot, non-interactive run that prints the reply to stdout. */
  headless: (prompt: string, cwd?: string) => string[];
}

export const AGENTS: AgentDef[] = [
  { id: 'claude', label: 'Claude', resolve: () => (isCommandAvailable('claude') ? 'claude' : null), headless: (p) => ['-p', p] },
  {
    id: 'codex', label: 'Codex', resolve: resolveCodex,
    headless: (p, cwd) => ['exec', '--sandbox', 'read-only', ...(cwd ? ['-C', cwd] : []), p],
  },
  { id: 'gemini', label: 'Gemini', resolve: () => (isCommandAvailable('gemini') ? 'gemini' : null), headless: (p) => ['-p', p] },
];

export function listAgents(): Array<{ id: string; label: string; available: boolean }> {
  return AGENTS.map((a) => ({ id: a.id, label: a.label, available: !!a.resolve() }));
}

/** Interactive command for a cockpit terminal (defaults to claude). */
export function agentCommand(agentId?: string): string {
  return AGENTS.find((a) => a.id === agentId)?.resolve() ?? 'claude';
}

export interface ConsultResult { ok: boolean; agent: string; output?: string; error?: string }

/** Run `prompt` through another agent non-interactively and return its reply. */
export function consultAgent(agentId: string, prompt: string, cwd?: string, timeoutMs = 240_000): Promise<ConsultResult> {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a) return Promise.resolve({ ok: false, agent: agentId, error: 'Unknown agent: ' + agentId });
  const exe = a.resolve();
  if (!exe) return Promise.resolve({ ok: false, agent: agentId, error: a.label + ' is not installed / could not be located.' });

  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r: ConsultResult) => { if (!done) { done = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, a.headless(prompt, cwd), { cwd: cwd || undefined, env: getCleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
