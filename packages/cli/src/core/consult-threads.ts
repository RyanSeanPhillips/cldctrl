/**
 * Consult threads — let the controller hold a MULTI-TURN conversation with another
 * CLI agent (Codex/Claude) instead of one-shot consults. Each thread maps a stable
 * cldctrl handle to the *vendor's* session id (Codex `thread_id` / Claude
 * `session_id`), so a follow-up consult RESUMES that session and the agent keeps
 * the prior turns' context — no need to re-paste the source/prompt/edit history.
 *
 * Persisted to a small json under the config dir so threads survive an MCP-server
 * restart. Bounded (newest 50, drop >14d) so the file can't grow unboundedly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { log } from './logger.js';

export interface ConsultThread {
  id: string;              // cldctrl handle (opaque to the caller)
  agent: string;           // which agent this thread talks to
  vendorSessionId: string; // the agent's own session id we resume
  cwd?: string;            // project the consult runs in (for context)
  turns: number;
  createdTs: number;
  lastTs: number;
}

const MAX_THREADS = 50;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function file(): string { return path.join(getConfigDir(), 'consult-threads.json'); }

function readAll(): Record<string, ConsultThread> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<string, ConsultThread>; }
  catch { return {}; }
}
function writeAll(m: Record<string, ConsultThread>): void {
  try { fs.writeFileSync(file(), JSON.stringify(m, null, 2), 'utf-8'); }
  catch (e) { log('error', { function: 'consult-threads.writeAll', message: String(e) }); }
}

export function getThread(id: string): ConsultThread | null {
  if (!id) return null;
  return readAll()[id] ?? null;
}

/** Insert/update a thread, then prune stale + overflow entries. */
export function saveThread(t: ConsultThread): void {
  const m = readAll();
  m[t.id] = t;
  const now = t.lastTs;
  const kept = Object.values(m)
    .filter((x) => now - x.lastTs <= MAX_AGE_MS)
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, MAX_THREADS);
  const keep = new Set(kept.map((x) => x.id));
  for (const k of Object.keys(m)) if (!keep.has(k)) delete m[k];
  writeAll(m);
}
