/**
 * A two-way bridge between the browser dashboard and the cldctrl control-plane
 * agent, via two small JSON files in the control workspace:
 *
 *   dashboard-context.json  (dashboard → agent)  what the user is searching /
 *                           viewing right now, so the agent can "see your screen".
 *   agent-search.json       (agent → dashboard)  a search the agent wants to
 *                           surface in the dashboard's search area.
 *
 * Separate files so neither side clobbers the other. Both carry a `ts` so the
 * reader can tell when something is new.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getControlDir, ensureControlWorkspace } from './control.js';
import { getConfigDir } from '../config.js';
import type { SearchResult } from './conversation-search.js';

const CONTEXT_FILE = 'dashboard-context.json';
const AGENT_SEARCH_FILE = 'agent-search.json';
const SCRATCH_OPEN_FILE = 'scratch-open.json';

export interface DashboardContext {
  query: string;
  results: SearchResult[];
  selectedProject: string | null;
  ts: number;
}

export interface AgentSearch {
  query: string;
  results: SearchResult[];
  note?: string;
  ts: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(getControlDir(), file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureControlWorkspace();
  fs.writeFileSync(path.join(getControlDir(), file), JSON.stringify(data), 'utf-8');
}

export function writeDashboardContext(ctx: DashboardContext): void { writeJson(CONTEXT_FILE, ctx); }
export function readDashboardContext(): DashboardContext | null { return readJson<DashboardContext>(CONTEXT_FILE); }

export function writeAgentSearch(s: AgentSearch): void { writeJson(AGENT_SEARCH_FILE, s); }
export function readAgentSearch(): AgentSearch | null { return readJson<AgentSearch>(AGENT_SEARCH_FILE); }

// ── Scratchpad (agent → dashboard: pop open a markdown draft) ─
export interface ScratchOpen { path: string; title: string; ts: number; }
const normSlash = (s: string) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

export function scratchDir(): string {
  const d = path.join(getConfigDir(), 'scratch');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

/** Absolute path for a scratchpad markdown file (slugified title). */
export function scratchPath(title?: string): string {
  const base = (title || 'scratchpad').replace(/\.md$/i, '');
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scratchpad';
  return path.join(scratchDir(), slug + '.md');
}

export function isScratchPath(p: string): boolean {
  return normSlash(p).startsWith(normSlash(scratchDir()) + '/');
}

/** Seed/ensure a scratchpad and signal the dashboard to open it. Returns the path. */
export function openScratchpad(content: string | undefined, title: string | undefined): string {
  const p = scratchPath(title);
  if (content != null) fs.writeFileSync(p, content, 'utf-8');
  else if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8');
  writeJson(SCRATCH_OPEN_FILE, { path: p, title: title || 'Scratchpad', ts: Date.now() });
  return p;
}

export function readScratchOpen(): ScratchOpen | null { return readJson<ScratchOpen>(SCRATCH_OPEN_FILE); }
