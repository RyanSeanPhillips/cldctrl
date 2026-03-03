/**
 * JSONL session file parsing, stats caching, preview extraction.
 * PERF: Pre-compiled regexes, streaming reads, bounded cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULTS } from '../constants.js';
import { getSessionDir } from './projects.js';
import { log } from './logger.js';
import { loadSummaryCache } from './summaries.js';
import type { Session, SessionStats, UsageStats } from '../types.js';

// ── Pre-compiled regexes (avoid allocation in hot loops) ────

const TOKEN_REGEXES = [
  /"input_tokens"\s*:\s*(\d+)/g,
  /"output_tokens"\s*:\s*(\d+)/g,
  /"cache_read_input_tokens"\s*:\s*(\d+)/g,
  /"cache_creation_input_tokens"\s*:\s*(\d+)/g,
];

const USER_TYPE_RE = /"type"\s*:\s*"user"/;
const USER_ROLE_RE = /"role"\s*:\s*"user"/;
const CONTENT_RE = /"content"\s*:\s*"([^"]{1,200})/;

// ── Stats cache with LRU eviction ───────────────────────────

const MAX_CACHE_SIZE = 200;
const statsCache = new Map<string, SessionStats>();

function getCacheKey(filePath: string, stat: fs.Stats): string {
  return `${filePath}|${stat.mtimeMs}|${stat.size}`;
}

function cacheSet(key: string, value: SessionStats): void {
  if (statsCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const firstKey = statsCache.keys().next().value;
    if (firstKey) statsCache.delete(firstKey);
  }
  statsCache.set(key, value);
}

// ── Token formatting ────────────────────────────────────────

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

// ── Read first N lines efficiently (not the whole file) ─────

function readFirstLines(filePath: string, maxLines: number): string[] {
  const BUFFER_SIZE = 8192; // 8KB is plenty for first ~20 lines
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(BUFFER_SIZE);
    const bytesRead = fs.readSync(fd, buf, 0, BUFFER_SIZE, 0);
    const text = buf.toString('utf-8', 0, bytesRead);
    return text.split('\n').slice(0, maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

// ── Session stats (streaming, pre-compiled regex) ───────────

export async function getSessionStats(sessionFilePath: string): Promise<SessionStats | null> {
  try {
    const stat = fs.statSync(sessionFilePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return null;

    const cacheKey = getCacheKey(sessionFilePath, stat);
    const cached = statsCache.get(cacheKey);
    if (cached) return cached;

    let messages = 0;
    let tokens = 0;

    const stream = fs.createReadStream(sessionFilePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
          messages++;
        }
        // Use pre-compiled regexes (reset lastIndex before each use)
        for (const re of TOKEN_REGEXES) {
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(line)) !== null) {
            tokens += parseInt(match[1], 10);
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    const stats: SessionStats = { messages, tokens };
    cacheSet(cacheKey, stats);
    return stats;
  } catch (err) {
    log('error', { function: 'getSessionStats', message: String(err) });
    return null;
  }
}

// ── Sessions index (Claude Code's own summaries) ────────────

interface SessionIndexEntry {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
}

/**
 * Load sessions-index.json from a session directory.
 * Returns a map of sessionId → entry for fast lookup.
 */
function loadSessionIndex(sessionDir: string): Map<string, SessionIndexEntry> {
  const indexPath = path.join(sessionDir, 'sessions-index.json');
  const map = new Map<string, SessionIndexEntry>();
  try {
    if (!fs.existsSync(indexPath)) return map;
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (raw?.entries && Array.isArray(raw.entries)) {
      for (const entry of raw.entries) {
        if (entry.sessionId) {
          map.set(entry.sessionId, entry);
        }
      }
    }
  } catch { /* corrupt index — fall back to JSONL parsing */ }
  return map;
}

/**
 * Extract a summary from JSONL (fallback when sessions-index.json missing).
 */
function extractSummaryFromJSONL(filePath: string): string {
  try {
    const lines = readFirstLines(filePath, 10);
    for (const line of lines) {
      if (!line.trim()) continue;
      if (
        (line.includes('"type":"user"') || line.includes('"type": "user"')) &&
        (line.includes('"role":"user"') || line.includes('"role": "user"'))
      ) {
        const match = line.match(CONTENT_RE);
        if (match) {
          let summary = match[1]
            .replace(/\\n/g, ' ')
            .replace(/\\t/g, ' ');
          if (summary.length > 200) summary = summary.substring(0, 197) + '...';
          return summary;
        }
      }
    }
  } catch { /* skip */ }
  return '';
}

// ── Recent sessions ─────────────────────────────────────────

// Session cache to avoid re-reading on rapid navigation
const sessionCache = new Map<string, { sessions: Session[]; fetchedAt: number }>();
const SESSION_CACHE_TTL = 30_000; // 30s

export async function getRecentSessions(
  projectPath: string,
  maxSessions: number = DEFAULTS.maxSessions
): Promise<Session[]> {
  // Check cache first
  const cached = sessionCache.get(projectPath);
  if (cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL) {
    return cached.sessions.slice(0, maxSessions);
  }

  const sessionDir = getSessionDir(projectPath);
  if (!fs.existsSync(sessionDir)) return [];

  try {
    // Load Claude's sessions-index.json for rich summaries
    const index = loadSessionIndex(sessionDir);

    // Load AI-generated rich summaries cache
    const richSummaries = loadSummaryCache(sessionDir);

    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: f,
        path: path.join(sessionDir, f),
        stat: fs.statSync(path.join(sessionDir, f)),
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, maxSessions);

    const sessions: Session[] = [];

    for (const file of files) {
      const sessionId = path.basename(file.name, '.jsonl');
      const modified = file.stat.mtime;

      // Try sessions-index.json summary first, fall back to JSONL parsing
      const indexEntry = index.get(sessionId);
      let summary = indexEntry?.summary || '';
      if (!summary) {
        summary = extractSummaryFromJSONL(file.path);
      }
      if (!summary) {
        summary = modified.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }

      // Use message count from index if available, otherwise stream-count
      const stats = indexEntry?.messageCount
        ? { messages: indexEntry.messageCount, tokens: 0 }
        : null;
      const fullStats = await getSessionStats(file.path);

      const dateLabel = modified.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });

      // Look up rich summary (validate mtime matches)
      const richEntry = richSummaries[sessionId];
      const richSummary = (richEntry && richEntry.mtimeMs === file.stat.mtimeMs)
        ? richEntry.summary
        : undefined;

      sessions.push({
        id: sessionId,
        filePath: file.path,
        modified,
        summary,
        firstPrompt: indexEntry?.firstPrompt || undefined,
        richSummary,
        dateLabel,
        // Prefer full stats (has tokens), but use index messageCount as fallback
        stats: fullStats ?? stats ?? undefined,
      });
    }

    // Cache the result
    sessionCache.set(projectPath, { sessions, fetchedAt: Date.now() });

    return sessions;
  } catch (err) {
    log('error', { function: 'getRecentSessions', message: String(err) });
    return [];
  }
}

// ── Session preview (first N user messages) ─────────────────

export async function getSessionPreview(
  sessionFilePath: string,
  maxMessages = 3
): Promise<string[]> {
  try {
    const stat = fs.statSync(sessionFilePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return [];

    const previews: string[] = [];
    const stream = fs.createReadStream(sessionFilePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (previews.length >= maxMessages) break;
        if (USER_TYPE_RE.test(line) && USER_ROLE_RE.test(line)) {
          const match = line.match(/"content"\s*:\s*"([^"]{1,300})/);
          if (match) {
            let msg = match[1].replace(/\\n/g, ' ').replace(/\\t/g, ' ');
            if (msg.length > 200) msg = msg.substring(0, 197) + '...';
            previews.push(msg);
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return previews;
  } catch {
    return [];
  }
}

// ── Daily usage stats ───────────────────────────────────────

export async function getDailyUsageStats(claudeProjectsDir: string): Promise<UsageStats> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let totalTokens = 0;
  let totalMessages = 0;

  if (!fs.existsSync(claudeProjectsDir)) {
    return { tokens: 0, messages: 0, date: todayStr };
  }

  try {
    const slugDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

    for (const dir of slugDirs) {
      if (!dir.isDirectory()) continue;
      const slugPath = path.join(claudeProjectsDir, dir.name);

      try {
        const files = fs.readdirSync(slugPath)
          .filter((f) => f.endsWith('.jsonl'));

        for (const f of files) {
          const filePath = path.join(slugPath, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtime.toISOString().slice(0, 10) !== todayStr) continue;
            if (stat.size > DEFAULTS.maxSessionFileSize) continue;

            const stats = await getSessionStats(filePath);
            if (stats) {
              totalTokens += stats.tokens;
              totalMessages += stats.messages;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    log('error', { function: 'getDailyUsageStats', message: String(err) });
  }

  return { tokens: totalTokens, messages: totalMessages, date: todayStr };
}
