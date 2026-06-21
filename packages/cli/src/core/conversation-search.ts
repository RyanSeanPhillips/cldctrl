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
import { loadConfig } from '../config.js';
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

function snippetFor(text: string, terms: string[]): string {
  const low = text.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  const start = Math.max(0, idx - 50);
  let s = text.slice(start, start + 170).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (start + 170 < text.length) s = s + '…';
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

/** Full-text search across every prompt, grouped and ranked by recency. */
export function searchConversations(query: string, limit = 50): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const nameMap = new Map<string, string>();
  for (const p of projects) nameMap.set(normalizePathForCompare(p.path), p.name);

  const grouped = new Map<string, { project: string; projectPath: string; ts: number; snippet: string; count: number }>();
  for (const e of loadHistory().all) {
    const low = e.display.toLowerCase();
    if (!terms.every((t) => low.includes(t))) continue;
    const cur = grouped.get(e.sessionId);
    if (cur) { cur.count++; if (e.timestamp > cur.ts) cur.ts = e.timestamp; }
    else {
      grouped.set(e.sessionId, {
        project: nameMap.get(normalizePathForCompare(e.project)) ?? (path.basename(e.project || '') || '(unknown)'),
        projectPath: e.project,
        ts: e.timestamp,
        snippet: snippetFor(e.display, terms),
        count: 1,
      });
    }
  }
  return [...grouped.entries()]
    .map(([sessionId, v]) => ({ sessionId, project: v.project, projectPath: v.projectPath, date: new Date(v.ts).toISOString(), snippet: v.snippet, count: v.count }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}
