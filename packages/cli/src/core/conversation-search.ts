/**
 * Conversation search + prompt-history utilities.
 *
 * Shared by `cc serve` (dashboard search box + session-title gists) and the MCP
 * server (the `search_conversations` tool, so ANY Claude Code session can ask
 * "where did we work on X?"). The corpus is ~/.claude/history.jsonl — every
 * prompt the user has typed, tagged by sessionId/project. It's the cheapest,
 * most reliable signal for what a session was about, with zero index to
 * maintain. (A future enhancement could read a claude-vault SQLite/FTS5 DB for
 * full-content search when present.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, getConfigDir } from '../config.js';
import { buildProjectListFast } from './projects.js';
import { getClaudeProjectsDir, normalizePathForCompare } from './platform.js';

export interface HistoryEntry { display: string; sessionId: string; project: string; timestamp: number; }

const HISTORY_TTL_MS = 30_000;
let historyCache: { at: number; bySession: Map<string, string[]>; all: HistoryEntry[] } | null = null;

export function loadHistory(): { bySession: Map<string, string[]>; all: HistoryEntry[] } {
  if (historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache;
  const file = path.join(path.dirname(getClaudeProjectsDir()), 'history.jsonl');
  const all: HistoryEntry[] = [];
  const bySession = new Map<string, string[]>();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d && typeof d.display === 'string' && d.sessionId) {
          const e: HistoryEntry = { display: d.display, sessionId: d.sessionId, project: d.project ?? '', timestamp: d.timestamp ?? 0 };
          all.push(e);
          const list = bySession.get(e.sessionId) ?? [];
          list.push(e.display);
          bySession.set(e.sessionId, list);
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* no history file */ }
  historyCache = { at: Date.now(), bySession, all };
  return historyCache;
}

// Low-signal prompts that make a poor session title.
const NOISE_PROMPT = /^(please\s+)?(continue|go on|keep going|proceed|yes|ok(ay)?|thanks?|resume|done|next|hi|hello)\b/i;

export function cleanPrompt(p?: string): string {
  if (!p) return '';
  return p
    .replace(/<[^>]+>/g, ' ')         // strip tags / tool-result markup
    .replace(/^\s*\/[\w:-]+\s*/, '')   // leading slash command
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWeak(t: string): boolean {
  return !t || t.length < 10 || NOISE_PROMPT.test(t);
}

/** Trim a verbose AI summary to a single concise line. */
export function condense(text: string): string {
  const t = text.replace(/^#{1,6}\s+.*$/gm, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const sentence = t.split(/(?<=[.!?])\s/)[0] || t;
  return sentence.length > 160 ? sentence.slice(0, 159) + '…' : sentence;
}

/** A concise gist from a session's prompts: the first substantive request. */
export function deriveGist(sessionId: string): string {
  const prompts = loadHistory().bySession.get(sessionId) ?? [];
  const cleaned = prompts.map(cleanPrompt).filter((p) => p && !isWeak(p));
  if (!cleaned.length) return '';
  const first = cleaned.find((p) => p.length >= 20) ?? cleaned[0];
  return first.length > 140 ? first.slice(0, 139) + '…' : first;
}

function snippetFor(text: string, terms: string[], pos?: number): string {
  let idx = pos ?? -1;
  if (idx < 0) {
    const low = text.toLowerCase();
    for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  }
  const start = Math.max(0, idx - 50);
  let s = text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (start + 180 < text.length) s = s + '…';
  return s;
}

export interface SearchResult {
  sessionId: string;
  project: string;
  projectPath: string;
  date: string;
  snippet: string;
  count: number;
}

// ── Content index ────────────────────────────────────────────
// Per-session searchable document built from the JSONL: user + assistant text,
// tool names, and touched file paths (tool RESULTS are skipped — they're huge
// and noisy). So searches match what was *done*, not just what was *asked*.
// Cached per file by (mtime, size) and persisted to search-index.json, so only
// changed sessions re-parse (same discipline as usage-buckets.json).

const DOC_CAP = 40_000;            // max chars of extracted text per session
const READ_CAP = 4 * 1024 * 1024;  // cap huge JSONL reads (50MB files exist)
const INDEX_TTL_MS = 30_000;

interface IndexEntry { sessionId: string; projectPath: string; lastTs: number; mtime: number; size: number; doc: string; }
interface DiskIndex { version: number; files: Record<string, IndexEntry>; }

function indexPath(): string { return path.join(getConfigDir(), 'search-index.json'); }

function walkSessionFiles(): Array<{ sessionId: string; filePath: string }> {
  const root = getClaudeProjectsDir();
  const out: Array<{ sessionId: string; filePath: string }> = [];
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(root, d.name);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ sessionId: e.name.replace(/\.jsonl$/, ''), filePath: path.join(projDir, e.name) });
      } else if (e.isDirectory()) {
        const inner = path.join(projDir, e.name, e.name + '.jsonl'); // newer uuid/uuid.jsonl layout
        if (fs.existsSync(inner)) out.push({ sessionId: e.name, filePath: inner });
      }
    }
  }
  return out;
}

function extractDoc(filePath: string, size: number): { doc: string; projectPath: string; lastTs: number } {
  let buf: string;
  try {
    if (size > READ_CAP) {
      const fd = fs.openSync(filePath, 'r');
      const b = Buffer.alloc(READ_CAP);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      fs.closeSync(fd);
      buf = b.toString('utf-8', 0, n);
    } else {
      buf = fs.readFileSync(filePath, 'utf-8');
    }
  } catch { return { doc: '', projectPath: '', lastTs: 0 }; }

  let projectPath = '';
  let lastTs = 0;
  const parts: string[] = [];
  let len = 0;
  const push = (s?: string) => { if (s && len < DOC_CAP) { parts.push(s); len += s.length; } };

  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    if (len >= DOC_CAP) break;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!projectPath && typeof obj.cwd === 'string') projectPath = obj.cwd;
    if (typeof obj.timestamp === 'string') { const t = Date.parse(obj.timestamp); if (t > lastTs) lastTs = t; }
    const c = obj.message?.content;
    if (typeof c === 'string') {
      if (!c.startsWith('<')) push(c);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type === 'text' && block.text) push(block.text);
        else if (block?.type === 'tool_use' && block.name) {
          const f = block.input?.file_path ?? block.input?.path;
          push(block.name + (f ? ' ' + String(f) : ''));
        }
        // tool_result intentionally skipped
      }
    }
  }
  return { doc: parts.join(' \n ').slice(0, DOC_CAP), projectPath, lastTs };
}

let memIndex: { at: number; entries: Map<string, IndexEntry & { docLower: string }> } | null = null;

function buildIndex(): Map<string, IndexEntry & { docLower: string }> {
  if (memIndex && Date.now() - memIndex.at < INDEX_TTL_MS) return memIndex.entries;

  let disk: DiskIndex = { version: 1, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf-8'));
    if (parsed && parsed.version === 1 && parsed.files) disk = parsed;
  } catch { /* no/invalid index */ }

  const histProj = new Map<string, string>();
  for (const e of loadHistory().all) if (e.project) histProj.set(e.sessionId, e.project);

  const seen = new Set<string>();
  let changed = false;
  for (const { sessionId, filePath } of walkSessionFiles()) {
    seen.add(filePath);
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { continue; }
    const cached = disk.files[filePath];
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) continue;
    const { doc, projectPath, lastTs } = extractDoc(filePath, st.size);
    disk.files[filePath] = {
      sessionId,
      projectPath: projectPath || histProj.get(sessionId) || '',
      lastTs: lastTs || st.mtimeMs,
      mtime: st.mtimeMs,
      size: st.size,
      doc,
    };
    changed = true;
  }
  for (const fp of Object.keys(disk.files)) if (!seen.has(fp)) { delete disk.files[fp]; changed = true; }

  if (changed) {
    try {
      const tmp = indexPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(disk));
      fs.renameSync(tmp, indexPath());
    } catch { /* best-effort */ }
  }

  const entries = new Map<string, IndexEntry & { docLower: string }>();
  for (const fp of Object.keys(disk.files)) {
    const e = disk.files[fp];
    if (e.doc) entries.set(e.sessionId, { ...e, docLower: e.doc.toLowerCase() });
  }
  memIndex = { at: Date.now(), entries };
  return entries;
}

function countOccurrences(haystack: string, needle: string): number {
  let c = 0, p = haystack.indexOf(needle);
  while (p >= 0) { c++; p = haystack.indexOf(needle, p + needle.length); }
  return c;
}

/**
 * Search the full conversation content (not just prompts), ranked by relevance:
 * docs matching MORE distinct query terms rank first (coverage), then by total
 * occurrences, then recency. Terms are ranked-OR'd so extra words refine instead
 * of zeroing out. Optional `project` restricts to a project name or path.
 */
export function searchConversations(query: string, limit = 50, project?: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const nameMap = new Map<string, string>();
  for (const p of projects) nameMap.set(normalizePathForCompare(p.path), p.name);

  const pf = project?.trim().toLowerCase();
  const idx = buildIndex();
  const scored: Array<{ e: IndexEntry & { docLower: string }; score: number; firstPos: number; matches: number }> = [];

  for (const e of idx.values()) {
    if (pf) {
      const name = (nameMap.get(normalizePathForCompare(e.projectPath)) ?? '').toLowerCase();
      const np = normalizePathForCompare(e.projectPath);
      if (!name.includes(pf) && !np.includes(pf.replace(/\\/g, '/'))) continue;
    }
    let distinct = 0, total = 0, firstPos = -1;
    for (const t of terms) {
      const pos = e.docLower.indexOf(t);
      if (pos < 0) continue;
      distinct++;
      total += countOccurrences(e.docLower, t);
      if (firstPos < 0 || pos < firstPos) firstPos = pos;
    }
    if (distinct === 0) continue;
    scored.push({ e, score: distinct * 1000 + Math.min(total, 999), firstPos, matches: total });
  }

  scored.sort((a, b) => b.score - a.score || b.e.lastTs - a.e.lastTs);
  return scored.slice(0, limit).map(({ e, firstPos, matches }) => ({
    sessionId: e.sessionId,
    project: nameMap.get(normalizePathForCompare(e.projectPath)) ?? (path.basename(e.projectPath || '') || '(unknown)'),
    projectPath: e.projectPath,
    date: new Date(e.lastTs).toISOString(),
    snippet: snippetFor(e.doc, terms, firstPos),
    count: matches,
  }));
}
