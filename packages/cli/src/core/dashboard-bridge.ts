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
const COCKPIT_LAUNCH_FILE = 'cockpit-launch.json';
const COCKPIT_INJECT_FILE = 'cockpit-inject.json';

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

/**
 * Stable per-conversation notepad file (the docked notepad). Keyed by the
 * conversation (sessionId), so leaving and resuming the chat reopens the SAME
 * draft. Lives under the scratch dir so the file read/write API allows it.
 * Created empty on first open; never auto-suffixed (the key IS the identity).
 */
export function notepadFile(key: string): string {
  const safe = (key || 'untitled').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
  const p = path.join(scratchDir(), 'note-' + safe + '.md');
  if (!fs.existsSync(p)) { try { fs.writeFileSync(p, '', 'utf-8'); } catch { /* ignore */ } }
  return p;
}

/**
 * Create a fresh, empty scratchpad file and return its path — for the dashboard's
 * "draft" button (user-initiated, so NO scratch-open signal is written; the client
 * opens the doc tile itself). Appends -2/-3/… if the slug already exists.
 */
export function newScratchFile(title?: string): string {
  let p = scratchPath(title);
  if (fs.existsSync(p)) {
    const ext = path.extname(p);
    const base = p.slice(0, p.length - ext.length);
    for (let i = 2; i < 1000; i++) {
      const cand = `${base}-${i}${ext}`;
      if (!fs.existsSync(cand)) { p = cand; break; }
    }
  }
  fs.writeFileSync(p, '', 'utf-8');
  return p;
}

/** Mint a fresh, empty, uniquely-named notepad file (note-<slug>[-n].md) — for the
 *  notepad's "+ New note". Caller records the conversation/project association. */
export function newNoteFile(title?: string): string {
  const base = (title && title.trim()) ? title.trim() : 'note';
  const slug = base.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
  let p = path.join(scratchDir(), 'note-' + slug + '.md');
  if (fs.existsSync(p)) {
    for (let i = 2; i < 1000; i++) {
      const cand = path.join(scratchDir(), `note-${slug}-${i}.md`);
      if (!fs.existsSync(cand)) { p = cand; break; }
    }
  }
  fs.writeFileSync(p, '', 'utf-8');
  return p;
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

// ── Notes index ──────────────────────────────────────────────
// Notes live as .md files in the scratch dir; this sidecar records which
// conversation/project each belongs to, so the dashboard can surface a project's
// notes (across its conversations) and a conversation's notes. Title/preview/recency
// are derived live from the file (no index drift) — the index only holds association.
const NOTES_INDEX_FILE = 'notes-index.json';
interface NoteMeta { project: string; conversation: string; created: number; }
type NotesIndex = Record<string, NoteMeta>;
const noteKey = (p: string) => normSlash(p);
function readNotesIndex(): NotesIndex { return readJson<NotesIndex>(NOTES_INDEX_FILE) ?? {}; }

/** Associate a note file with a conversation + project (idempotent; upserts). */
export function recordNote(p: string, project: string, conversation: string): void {
  if (!p) return;
  const idx = readNotesIndex();
  const k = noteKey(p);
  if (!idx[k]) idx[k] = { project: project || '', conversation: conversation || '', created: Date.now() };
  else { if (project) idx[k].project = project; if (conversation) idx[k].conversation = conversation; }
  writeJson(NOTES_INDEX_FILE, idx);
}

export interface NoteEntry { path: string; title: string; preview: string; project: string; conversation: string; updated: number; }

/** List notes, optionally scoped to a project and/or conversation, and optionally
 *  full-text filtered by `query` (matches the title AND the note body). Scans the
 *  scratch dir (so pre-existing/orphan notes still surface) and enriches from the
 *  index; when querying, the preview becomes a snippet around the first match. */
export function listNotes(filter?: { project?: string; conversation?: string; query?: string }): NoteEntry[] {
  const idx = readNotesIndex();
  const dir = scratchDir();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { /* ignore */ }
  const q = (filter?.query ?? '').trim().toLowerCase();
  const out: NoteEntry[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const meta = idx[noteKey(full)];
    const project = meta?.project ?? '';
    const conversation = meta?.conversation ?? '';
    if (filter?.project && normSlash(project) !== normSlash(filter.project)) continue;
    if (filter?.conversation && conversation !== filter.conversation) continue;
    let updated = 0, title = f.replace(/\.md$/i, ''), preview = '', body = '';
    try {
      updated = fs.statSync(full).mtimeMs;
      const raw = fs.readFileSync(full, 'utf-8');
      body = raw.length > 200_000 ? raw.slice(0, 200_000) : raw; // cap pathological files
      const firstLine = body.split(/\r?\n/).find((l) => l.trim());
      if (firstLine) title = (firstLine.replace(/^#+\s*/, '').slice(0, 60).trim()) || title;
      preview = body.replace(/\s+/g, ' ').trim().slice(0, 140);
    } catch { /* unreadable — keep filename as title */ }
    if (q) {
      const flat = body.replace(/\s+/g, ' ').trim();
      const at = flat.toLowerCase().indexOf(q);
      const inTitle = title.toLowerCase().includes(q);
      if (at < 0 && !inTitle) continue; // no body/title match → drop
      if (at >= 0) { // snippet around the body match for context
        const start = Math.max(0, at - 40);
        preview = (start > 0 ? '…' : '') + flat.slice(start, at + q.length + 80).trim() + (flat.length > at + q.length + 80 ? '…' : '');
      }
    }
    out.push({ path: full, title, preview, project, conversation, updated });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// ── Cockpit launch (agent/CTRL → dashboard: open a new session as a tile) ─
// sessionId set = RESUME that conversation as a tile (web-first launch_session
// routing); absent = spawn a fresh session tile. agent + handoffBrief set = an
// AGENT HANDOFF: open a NEW tile with that agent, prefilled with the brief
// (handoff_session MCP tool) and backlinked to the source conversation.
export interface CockpitLaunch {
  projectPath: string; project?: string; prompt?: string; sessionId?: string; ts: number;
  agent?: string;
  handoffBrief?: string;
  handoffFrom?: { sessionId: string; vendor: string };
}

/** Ask the dashboard to open a new conversation as a cockpit tile (instead of a
 *  separate terminal window). Used when the launch originates inside the web UI.
 *  A QUEUE (not a single slot) so two launches inside one poll window don't
 *  clobber each other — the dashboard drains all entries newer than it has seen. */
export function writeCockpitLaunch(launch: CockpitLaunch): void {
  const queue = readCockpitLaunches();
  queue.push(launch);
  // keep only recent + bounded so the file can't grow unboundedly
  const cutoff = launch.ts - 5 * 60_000;
  writeJson(COCKPIT_LAUNCH_FILE, queue.filter((l) => l.ts >= cutoff).slice(-20));
}
export function readCockpitLaunches(): CockpitLaunch[] {
  const v = readJson<CockpitLaunch[] | CockpitLaunch>(COCKPIT_LAUNCH_FILE);
  if (!v) return [];
  return Array.isArray(v) ? v : [v]; // tolerate the old single-object format
}

// ── Message-in (agent → dashboard: inject text into a running session) ─
// The coordination primitive (#9): one conversation (or the control-plane agent)
// drops a message into another LIVE cockpit session. By default the dashboard
// PREFILLS the target's compose-box for the user to confirm/edit (autoSend=false);
// autoSend submits immediately. Targeted by sessionId (resume tiles) or the
// sessionId a 'new' tile's agent created (discoveredSessionId).
export interface CockpitInject { sessionId: string; text: string; autoSend?: boolean; note?: string; ts: number; }

export function writeCockpitInject(inject: CockpitInject): void {
  const queue = readCockpitInjects();
  queue.push(inject);
  const cutoff = inject.ts - 5 * 60_000;
  writeJson(COCKPIT_INJECT_FILE, queue.filter((i) => i.ts >= cutoff).slice(-20));
}
export function readCockpitInjects(): CockpitInject[] {
  const v = readJson<CockpitInject[]>(COCKPIT_INJECT_FILE);
  return Array.isArray(v) ? v : [];
}
