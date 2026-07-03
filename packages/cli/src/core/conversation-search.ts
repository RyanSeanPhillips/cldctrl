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
import os from 'node:os';
import { loadConfig, getConfigDir } from '../config.js';
import { buildProjectListFast } from './projects.js';
import { getClaudeProjectsDir, normalizePathForCompare } from './platform.js';

export type Vendor = 'claude' | 'codex';

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
  vendor: Vendor;
  /**
   * How hybrid search found this result (set only by the semantic layer):
   * 'keyword' = text match, 'vector' = semantic-only (keyword missed it —
   * snippet is the matched passage), 'both' = found by both signals.
   */
  matched?: 'keyword' | 'vector' | 'both';
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

interface IndexEntry { sessionId: string; projectPath: string; lastTs: number; mtime: number; size: number; doc: string; vendor: Vendor; }
interface DiskIndex { version: number; files: Record<string, IndexEntry>; }
const INDEX_VERSION = 3; // v2 added `vendor`; v3 corrected lastTs (max with file mtime) — older caches ignored

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

// ── Codex source (vendor-neutral) ────────────────────────────
// Read OpenAI Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
// into the SAME index so search spans Claude + Codex. Schema verified against a
// real machine (and with Codex itself): clean transcript text lives in `event_msg`
// user_message/agent_message; project assoc is `session_meta.payload.cwd`. Tolerant
// by design — Codex owns this format and may change it (skip unknown event types).
const CODEX_READ_CAP = 12 * 1024 * 1024; // a resumed rollout can hit ~6MB; read more than Claude's cap
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function codexSessionsRoot(): string { return path.join(os.homedir(), '.codex', 'sessions'); }

function walkCodexSessionFiles(): Array<{ sessionId: string; filePath: string }> {
  const root = codexSessionsRoot();
  const out: Array<{ sessionId: string; filePath: string }> = [];
  const kids = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const y of kids(root)) {                              // YYYY
    if (!y.isDirectory()) continue;
    for (const m of kids(path.join(root, y.name))) {         // MM
      if (!m.isDirectory()) continue;
      for (const d of kids(path.join(root, y.name, m.name))) { // DD
        if (!d.isDirectory()) continue;
        const dayDir = path.join(root, y.name, m.name, d.name);
        for (const f of kids(dayDir)) {
          if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
          const uuid = f.name.match(UUID_RE);
          out.push({ sessionId: uuid ? uuid[1] : f.name.replace(/\.jsonl$/, ''), filePath: path.join(dayDir, f.name) });
        }
      }
    }
  }
  return out;
}

function extractCodexDoc(filePath: string, size: number): { doc: string; projectPath: string; lastTs: number; sessionId: string } {
  let buf: string;
  try {
    if (size > CODEX_READ_CAP) {
      const fd = fs.openSync(filePath, 'r');
      const b = Buffer.alloc(CODEX_READ_CAP);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      fs.closeSync(fd);
      buf = b.toString('utf-8', 0, n);
    } else {
      buf = fs.readFileSync(filePath, 'utf-8');
    }
  } catch { return { doc: '', projectPath: '', lastTs: 0, sessionId: '' }; }

  let projectPath = '', rootsFallback = '', lastTs = 0, sessionId = '';
  const parts: string[] = [];
  let len = 0;
  const push = (s?: string) => { if (s && len < DOC_CAP) { const v = s.length > 4000 ? s.slice(0, 4000) : s; parts.push(v); len += v.length; } };

  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    if (len >= DOC_CAP) break;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : 0;
    if (ts > lastTs) lastTs = ts;
    const p = obj.payload;
    switch (obj.type) {
      case 'session_meta':
        // Multiple session_meta lines can appear after resume — first one is canonical.
        if (p) {
          if (!sessionId && typeof p.id === 'string') sessionId = p.id;
          if (!projectPath && typeof p.cwd === 'string') projectPath = p.cwd;
        }
        break;
      case 'turn_context':
        if (p) {
          if (!projectPath && typeof p.cwd === 'string') projectPath = p.cwd;        // fallback cwd
          if (!rootsFallback && Array.isArray(p.workspace_roots) && p.workspace_roots[0]) rootsFallback = String(p.workspace_roots[0]);
        }
        break;
      case 'event_msg':
        if (p?.type === 'user_message' || p?.type === 'agent_message') push(typeof p.message === 'string' ? p.message : '');
        else if (p?.type === 'mcp_tool_call_end' && p.invocation?.tool) push('tool ' + String(p.invocation.tool)); // "what was done"
        break;
      case 'response_item':
        // index small tool-call metadata (name + a file path if present); skip the
        // huge function_call_output and the duplicate `message` records (dev/env noise).
        if (p?.type === 'function_call' && p.name) {
          const args = typeof p.arguments === 'string' ? p.arguments : '';
          const file = args.match(/"(?:file_path|path|cwd)"\s*:\s*"([^"]+)"/)?.[1];
          push(String(p.name) + (file ? ' ' + file : ''));
        }
        break;
    }
  }
  return { doc: parts.join(' \n ').slice(0, DOC_CAP), projectPath: projectPath || rootsFallback, lastTs, sessionId };
}

let memIndex: { at: number; entries: Map<string, IndexEntry & { docLower: string }> } | null = null;

function buildIndex(): Map<string, IndexEntry & { docLower: string }> {
  if (memIndex && Date.now() - memIndex.at < INDEX_TTL_MS) return memIndex.entries;

  let disk: DiskIndex = { version: INDEX_VERSION, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf-8'));
    if (parsed && parsed.version === INDEX_VERSION && parsed.files) disk = parsed;
  } catch { /* no/invalid index */ }

  const histProj = new Map<string, string>();
  for (const e of loadHistory().all) if (e.project) histProj.set(e.sessionId, e.project);

  const sources: Array<{ sessionId: string; filePath: string; vendor: Vendor }> = [
    ...walkSessionFiles().map((f) => ({ ...f, vendor: 'claude' as const })),
    ...walkCodexSessionFiles().map((f) => ({ ...f, vendor: 'codex' as const })),
  ];

  const seen = new Set<string>();
  let changed = false;
  for (const { sessionId, filePath, vendor } of sources) {
    seen.add(filePath);
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { continue; }
    const cached = disk.files[filePath];
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) continue;
    const ext = vendor === 'codex' ? extractCodexDoc(filePath, st.size) : { ...extractDoc(filePath, st.size), sessionId: '' };
    disk.files[filePath] = {
      sessionId: ext.sessionId || sessionId,
      projectPath: ext.projectPath || histProj.get(ext.sessionId || sessionId) || '',
      // Recency = max(parsed content ts, file mtime). The parsed ts only covers
      // lines read before the doc cap, so for long/resumed sessions it's stale;
      // the file mtime is the true last-write (last-turn) time. (Codex review.)
      lastTs: Math.max(ext.lastTs || 0, st.mtimeMs),
      mtime: st.mtimeMs,
      size: st.size,
      doc: ext.doc,
      vendor,
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

/**
 * Indexed doc text for a session (empty string if unknown). Wiring point for the
 * optional semantic re-rank layer (semantic-rerank.ts) — additive, no behavior
 * change to keyword search.
 */
export function getSessionDoc(sessionId: string): string {
  return buildIndex().get(sessionId)?.doc ?? '';
}

/**
 * Every indexed session doc, for corpus-wide consumers (the Tier-1 vector
 * index in vector-index.ts). Same freshness/caching as keyword search.
 */
export function listSessionDocs(): Array<{ sessionId: string; doc: string; projectPath: string; vendor: Vendor; lastTs: number }> {
  const out: Array<{ sessionId: string; doc: string; projectPath: string; vendor: Vendor; lastTs: number }> = [];
  for (const e of buildIndex().values()) {
    out.push({ sessionId: e.sessionId, doc: e.doc, projectPath: e.projectPath, vendor: e.vendor, lastTs: e.lastTs });
  }
  return out;
}

/**
 * Vendor-neutral session lookup for the handoff feature: given ANY session id
 * (Claude JSONL or Codex rollout), return its indexed doc + resolved project cwd
 * + vendor. Backs cross-vendor handoff (hand off FROM a Codex conversation).
 * Returns null if the session isn't in the index yet.
 */
export function getSessionArtifact(sessionId: string): { doc: string; projectPath: string; vendor: string; lastTs: number } | null {
  const e = buildIndex().get(sessionId);
  if (!e) return null;
  return { doc: e.doc, projectPath: e.projectPath, vendor: e.vendor, lastTs: e.lastTs };
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
    vendor: e.vendor,
  }));
}
