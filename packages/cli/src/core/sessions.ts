/**
 * JSONL session file parsing, stats caching, preview extraction.
 * PERF: Pre-compiled regexes, streaming reads, bounded cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULTS } from '../constants.js';
import { getSessionDir, findChildSlugDirs } from './projects.js';
import { getConfigDir } from '../config.js';
import { log } from './logger.js';
import { loadSummaryCache } from './summaries.js';
import { getProjectLastCost } from './claude-usage.js';
import type { Session, SessionStats, UsageStats } from '../types.js';

// ── Pre-compiled regexes (avoid allocation in hot loops) ────

/** All token types — used for full session stats display. */
const TOKEN_REGEXES = [
  /"input_tokens"\s*:\s*(\d+)/g,
  /"output_tokens"\s*:\s*(\d+)/g,
  /"cache_read_input_tokens"\s*:\s*(\d+)/g,
  /"cache_creation_input_tokens"\s*:\s*(\d+)/g,
];

/**
 * Rate-limit-weighted token regexes and weights.
 * Anthropic's unified rate limit counts different token types at different weights.
 * These match Anthropic's documented cost ratios (cache_read = 10% of input,
 * cache_creation = 25% of input). Since rate limit utilization is compute-based,
 * the cost ratios approximate the actual capacity weights well.
 *
 * Without weighting, cache_read (100M+) massively inflates the total (458%),
 * while input+output alone (392K) undercounts (2%).
 *
 * NOTE: This is an approximation. The /usage dialog in Claude Code reads exact
 * utilization from API response headers, which we can't access (OAuth tokens
 * don't work for direct API calls). Local estimates will drift ±10%.
 */
const RATE_LIMIT_TOKEN_REGEXES: Array<{ re: RegExp; weight: number }> = [
  { re: /"input_tokens"\s*:\s*(\d+)/g, weight: 1.0 },
  { re: /"output_tokens"\s*:\s*(\d+)/g, weight: 1.0 },
  { re: /"cache_read_input_tokens"\s*:\s*(\d+)/g, weight: 0.1 },
  { re: /"cache_creation_input_tokens"\s*:\s*(\d+)/g, weight: 0.25 },
];

const USER_TYPE_RE = /"type"\s*:\s*"user"/;
const USER_ROLE_RE = /"role"\s*:\s*"user"/;
const CONTENT_RE = /"content"\s*:\s*"([^"]{1,200})/;

// ── Stats cache with LRU eviction + disk persistence ────────

const MAX_CACHE_SIZE = 500;
const statsCache = new Map<string, SessionStats>();
let statsCacheDirty = false;
let statsCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
const STATS_CACHE_FLUSH_DELAY = 5000; // 5s debounce

function getStatsCachePath(): string {
  return path.join(getConfigDir(), 'stats-cache.json');
}

function loadStatsCache(): void {
  try {
    const cachePath = getStatsCachePath();
    if (!fs.existsSync(cachePath)) return;
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (typeof raw !== 'object' || raw === null) return;
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (count >= MAX_CACHE_SIZE) break;
      const v = value as Record<string, unknown>;
      if (typeof v.messages === 'number' && typeof v.tokens === 'number') {
        statsCache.set(key, { messages: v.messages, tokens: v.tokens });
        count++;
      }
    }
    log('stats_cache_loaded', { entries: count });
  } catch (err) {
    log('stats_cache_load_error', { message: String(err) });
  }
}

function saveStatsCache(): void {
  try {
    const cachePath = getStatsCachePath();
    const obj: Record<string, SessionStats> = {};
    // Keep only most recent MAX_CACHE_SIZE entries (Map preserves insertion order)
    const entries = [...statsCache.entries()];
    const start = Math.max(0, entries.length - MAX_CACHE_SIZE);
    for (let i = start; i < entries.length; i++) {
      obj[entries[i][0]] = entries[i][1];
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    fs.renameSync(tmpPath, cachePath);
    statsCacheDirty = false;
    log('stats_cache_saved', { entries: Object.keys(obj).length });
  } catch (err) {
    log('stats_cache_save_error', { message: String(err) });
  }
}

function scheduleCacheFlush(): void {
  if (statsCacheFlushTimer) clearTimeout(statsCacheFlushTimer);
  statsCacheFlushTimer = setTimeout(() => {
    if (statsCacheDirty) saveStatsCache();
  }, STATS_CACHE_FLUSH_DELAY);
  statsCacheFlushTimer.unref();
}

// Lazy hydration — avoid disk I/O at import time
let statsCacheLoaded = false;
function ensureStatsCacheLoaded(): void {
  if (statsCacheLoaded) return;
  statsCacheLoaded = true;
  loadStatsCache();
}

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
  statsCacheDirty = true;
  scheduleCacheFlush();
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
  ensureStatsCacheLoaded();
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
  fullPath?: string;
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
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
    // Only trust known version — fall back gracefully on unknown versions
    if (raw?.version === 1 && Array.isArray(raw?.entries)) {
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

    // Find .jsonl files at root level AND inside UUID subdirectories
    // (newer Claude Code stores sessions as uuid/uuid.jsonl instead of uuid.jsonl)
    const jsonlFiles: Array<{ name: string; path: string }> = [];
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (entry.name === 'memory' || entry.name === 'sessions-index.json') continue;
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        jsonlFiles.push({ name: entry.name, path: path.join(sessionDir, entry.name) });
      } else if (entry.isDirectory()) {
        // Check for uuid.jsonl inside the subdirectory
        const subJsonl = path.join(sessionDir, entry.name, `${entry.name}.jsonl`);
        try {
          if (fs.existsSync(subJsonl)) {
            jsonlFiles.push({ name: `${entry.name}.jsonl`, path: subJsonl });
          }
        } catch { /* ignore */ }
      }
    }

    const files = jsonlFiles
      .map((f) => ({
        name: f.name,
        path: f.path,
        stat: fs.statSync(f.path),
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, maxSessions);

    const sessions: Session[] = [];

    if (files.length === 0 && index.size > 0) {
      // No JSONL files found but sessions-index.json has entries —
      // newer Claude Code may store conversation data differently.
      // Build sessions from index metadata alone.
      const indexEntries = [...index.values()]
        .filter(e => e.modified || e.created)
        .sort((a, b) => {
          const aTime = new Date(a.modified ?? a.created ?? 0).getTime();
          const bTime = new Date(b.modified ?? b.created ?? 0).getTime();
          return bTime - aTime;
        })
        .slice(0, maxSessions);

      for (const entry of indexEntries) {
        const modified = new Date(entry.modified ?? entry.created ?? 0);
        const dateLabel = modified.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        sessions.push({
          id: entry.sessionId,
          filePath: entry.fullPath || '',
          modified,
          summary: entry.summary || entry.firstPrompt?.slice(0, 80) || dateLabel,
          firstPrompt: entry.firstPrompt || undefined,
          dateLabel,
          stats: entry.messageCount ? { messages: entry.messageCount, tokens: 0 } : undefined,
          gitBranch: entry.gitBranch,
        });
      }
    } else {
      // Standard path: build sessions from JSONL files
      for (const file of files) {
        const sessionId = path.basename(file.name, '.jsonl');
        const indexEntry = index.get(sessionId);

        // Use created/modified from index when available (avoids statSync per file)
        const modified = indexEntry?.modified
          ? new Date(indexEntry.modified)
          : file.stat.mtime;

        // Try sessions-index.json summary first, fall back to JSONL parsing
        let summary = indexEntry?.summary || '';
        if (!summary) {
          summary = extractSummaryFromJSONL(file.path);
        }
        if (!summary) {
          summary = modified.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        // When index has messageCount, skip expensive JSONL streaming entirely
        let stats: SessionStats | undefined;
        if (indexEntry?.messageCount) {
          stats = { messages: indexEntry.messageCount, tokens: 0 };
        } else {
          // No index entry — fall back to JSONL parsing
          const fullStats = await getSessionStats(file.path);
          stats = fullStats ?? undefined;
        }

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
          stats,
          gitBranch: indexEntry?.gitBranch,
        });
      }
    }

    // Attach actual cost from ~/.claude.json to the most recent session
    if (sessions.length > 0) {
      const costInfo = getProjectLastCost(projectPath);
      if (costInfo) {
        sessions[0].cost = costInfo.cost;
      }
    }

    // Cache the result
    sessionCache.set(projectPath, { sessions, fetchedAt: Date.now() });

    return sessions;
  } catch (err) {
    log('error', { function: 'getRecentSessions', message: String(err) });
    return [];
  }
}

// ── Merged sessions (parent + child subfolders) ──────────────

// Separate cache for merged sessions (different key semantics than sessionCache)
const mergedSessionCache = new Map<string, { sessions: Session[]; fetchedAt: number }>();

/**
 * Get recent sessions for a project plus all its child subfolders, merged chronologically.
 * Child sessions are tagged with subfolder and projectPath for display and resume.
 */
export async function getRecentSessionsWithChildren(
  projectPath: string,
  maxSessions: number = DEFAULTS.maxSessions,
  excludeChildPaths?: Set<string>,
): Promise<Session[]> {
  const cacheKey = projectPath;
  const cached = mergedSessionCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL) {
    return cached.sessions.slice(0, maxSessions);
  }

  try {
    // Get parent sessions (uses its own 30s cache)
    const parentSessions = await getRecentSessions(projectPath, maxSessions);

    // Find child slug directories (cap at 8 to bound I/O)
    const allChildren = findChildSlugDirs(projectPath, excludeChildPaths);
    const children = allChildren.slice(0, 8);
    if (children.length === 0) {
      // No children — cache and return parent sessions as-is
      mergedSessionCache.set(cacheKey, { sessions: parentSessions, fetchedAt: Date.now() });
      return parentSessions.slice(0, maxSessions);
    }

    // Fetch child sessions in parallel, loading only a few per child.
    // We only need enough to fill the merged list (maxSessions total).
    const perChild = Math.max(5, Math.ceil(maxSessions / (children.length + 1)));
    const childResults = await Promise.all(
      children.map(async (child) => {
        const sessions = await getRecentSessions(child.childPath, perChild);
        return sessions.map(s => ({
          ...s,
          subfolder: child.relativePath,
          projectPath: child.childPath,
        }));
      }),
    );

    // Merge all into one array, sort by modified descending, cap at maxSessions
    const allSessions = [...parentSessions, ...childResults.flat()];
    allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const result = allSessions.slice(0, maxSessions);

    mergedSessionCache.set(cacheKey, { sessions: result, fetchedAt: Date.now() });
    return result;
  } catch (err) {
    log('error', { function: 'getRecentSessionsWithChildren', message: String(err) });
    // Fall back to parent-only sessions
    return getRecentSessions(projectPath, maxSessions);
  }
}

// ── Session preview (first N user messages) ─────────────────

// ── Rolling usage stats (5-hour window) ─────────────────────

const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

/**
 * Count weighted tokens/messages only from JSONL lines whose timestamp >= cutoffMs.
 * Lines without a parseable timestamp inherit the last seen timestamp.
 * Uses RATE_LIMIT_TOKEN_REGEXES with weights that match Anthropic's unified rate limit
 * calculation (cache_read at 5%, cache_creation at 25%, others at 100%).
 */
async function getSessionStatsSince(
  sessionFilePath: string,
  cutoffMs: number,
): Promise<SessionStats | null> {
  ensureStatsCacheLoaded();
  try {
    const stat = fs.statSync(sessionFilePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return null;

    let messages = 0;
    let tokens = 0;
    let lastTs = 0; // track most recent timestamp

    const stream = fs.createReadStream(sessionFilePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        // Extract timestamp from this line
        const tsMatch = TIMESTAMP_RE.exec(line);
        if (tsMatch) {
          const ts = new Date(tsMatch[1]).getTime();
          if (!isNaN(ts)) lastTs = ts;
        }

        // Skip lines before the cutoff
        if (lastTs < cutoffMs) continue;

        if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
          messages++;
        }
        for (const { re, weight } of RATE_LIMIT_TOKEN_REGEXES) {
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(line)) !== null) {
            tokens += parseInt(match[1], 10) * weight;
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return { messages, tokens: Math.round(tokens) };
  } catch (err) {
    log('error', { function: 'getSessionStatsSince', message: String(err) });
    return null;
  }
}

export async function getRollingUsageStats(claudeProjectsDir: string): Promise<UsageStats> {
  const now = Date.now();
  const cutoff = now - ROLLING_WINDOW_MS;
  let totalTokens = 0;
  let totalMessages = 0;

  if (!fs.existsSync(claudeProjectsDir)) {
    return { tokens: 0, messages: 0, date: new Date().toISOString() };
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
            if (stat.mtimeMs < cutoff) continue;
            if (stat.size > DEFAULTS.maxSessionFileSize) continue;

            const stats = await getSessionStatsSince(filePath, cutoff);
            if (stats) {
              totalTokens += stats.tokens;
              totalMessages += stats.messages;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    log('error', { function: 'getRollingUsageStats', message: String(err) });
  }

  return { tokens: totalTokens, messages: totalMessages, date: new Date().toISOString() };
}

/** 7-day rolling window (for local 7d estimate when API probe unavailable). */
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface WindowedUsageStats {
  fiveHour: UsageStats;
  sevenDay: UsageStats;
}

/**
 * Get both 5h and 7d rolling usage stats in a single pass.
 * Used to provide local 5h/7d estimates when the API rate limit probe is unavailable.
 */
export async function getRollingUsageWindowed(claudeProjectsDir: string): Promise<WindowedUsageStats> {
  const now = Date.now();
  const cutoff5h = now - ROLLING_WINDOW_MS;
  const cutoff7d = now - SEVEN_DAY_WINDOW_MS;
  const date = new Date().toISOString();
  let tok5h = 0, msg5h = 0, tok7d = 0, msg7d = 0;

  if (!fs.existsSync(claudeProjectsDir)) {
    return {
      fiveHour: { tokens: 0, messages: 0, date },
      sevenDay: { tokens: 0, messages: 0, date },
    };
  }

  try {
    const slugDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

    for (const dir of slugDirs) {
      if (!dir.isDirectory()) continue;
      const slugPath = path.join(claudeProjectsDir, dir.name);

      try {
        const files = fs.readdirSync(slugPath).filter((f) => f.endsWith('.jsonl'));

        for (const f of files) {
          const filePath = path.join(slugPath, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff7d) continue; // Skip files untouched in 7d
            if (stat.size > DEFAULTS.maxSessionFileSize) continue;

            // Parse the file once but bucket tokens into both windows
            const stats7d = await getSessionStatsSince(filePath, cutoff7d);
            if (stats7d) {
              tok7d += stats7d.tokens;
              msg7d += stats7d.messages;
            }

            // Only parse for 5h if file was touched in the 5h window
            if (stat.mtimeMs >= cutoff5h) {
              const stats5h = await getSessionStatsSince(filePath, cutoff5h);
              if (stats5h) {
                tok5h += stats5h.tokens;
                msg5h += stats5h.messages;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    log('error', { function: 'getRollingUsageWindowed', message: String(err) });
  }

  return {
    fiveHour: { tokens: tok5h, messages: msg5h, date },
    sevenDay: { tokens: tok7d, messages: msg7d, date },
  };
}
