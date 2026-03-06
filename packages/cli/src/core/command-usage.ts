/**
 * Track slash command usage across sessions.
 * - Scans JSONL transcripts for /command invocations (streamed, first line per user turn)
 * - Caches results keyed by session file + mtime
 * - Provides aggregated counts per command name
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getConfigDir } from '../config.js';
import { getClaudeProjectsDir } from './platform.js';
import { atomicWriteFile } from './background.js';
import { log } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export interface CommandUsageCounts {
  [commandName: string]: number;
}

interface SessionScanEntry {
  mtimeMs: number;
  commands: CommandUsageCounts;
}

interface UsageCache {
  /** Per-session scan results keyed by relative file path */
  sessions: { [filePath: string]: SessionScanEntry };
  /** Aggregated totals (rebuilt from sessions on load) */
  totals: CommandUsageCounts;
}

// ── Cache path ───────────────────────────────────────────────

function getCachePath(): string {
  return path.join(getConfigDir(), 'command-usage.json');
}

function loadCache(): UsageCache {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      sessions: parsed.sessions ?? {},
      totals: parsed.totals ?? {},
    };
  } catch {
    return { sessions: {}, totals: {} };
  }
}

function saveCache(cache: UsageCache): void {
  atomicWriteFile(getCachePath(), JSON.stringify(cache, null, 2) + '\n');
}

// ── Scanning ─────────────────────────────────────────────────

/** Known slash command pattern: starts with / followed by word chars and hyphens */
const SLASH_CMD_RE = /^\/([a-zA-Z][\w-]{1,40})(?:\s|$)/;

/**
 * Stream a JSONL file and extract slash command invocations from user messages.
 * Only checks the first text content of each user message (slash commands are always first).
 */
async function scanSessionFile(filePath: string): Promise<CommandUsageCounts> {
  const counts: CommandUsageCounts = {};

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      // Only look at user messages
      const isUser =
        (parsed.type === 'user' || parsed.message?.type === 'user') &&
        (parsed.role === 'user' || parsed.message?.role === 'user');
      if (!isUser) continue;

      const msg = parsed.message || parsed;
      let text = '';

      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Get first text block only
        const firstText = msg.content.find((b: { type: string }) => b.type === 'text');
        if (firstText) text = firstText.text;
      }

      if (!text) continue;

      // Check first line for slash command
      const firstLine = text.split('\n')[0].trim();
      const match = firstLine.match(SLASH_CMD_RE);
      if (match) {
        const cmd = match[1];
        counts[cmd] = (counts[cmd] || 0) + 1;
      }
    } catch { /* skip unparseable lines */ }
  }

  return counts;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Rebuild aggregate totals from all session entries.
 */
function rebuildTotals(cache: UsageCache): CommandUsageCounts {
  const totals: CommandUsageCounts = {};
  for (const entry of Object.values(cache.sessions)) {
    for (const [cmd, count] of Object.entries(entry.commands)) {
      totals[cmd] = (totals[cmd] || 0) + count;
    }
  }
  return totals;
}

/**
 * Scan all JSONL session files across all projects.
 * Skips files that haven't changed since last scan (by mtime).
 * Returns aggregated command usage counts.
 */
export async function scanAllSessions(
  onProgress?: (scanned: number, total: number) => void,
): Promise<CommandUsageCounts> {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) return {};

  const cache = loadCache();
  let scannedCount = 0;
  let needsSave = false;

  // Collect all JSONL files across all project dirs
  const allFiles: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];

  try {
    for (const projectSlug of fs.readdirSync(projectsDir)) {
      const projectDir = path.join(projectsDir, projectSlug);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(projectDir);
      } catch { continue; }
      if (!stat.isDirectory()) continue;

      try {
        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const absPath = path.join(projectDir, file);
          const relPath = `${projectSlug}/${file}`;
          try {
            const fstat = fs.statSync(absPath);
            allFiles.push({ relPath, absPath, mtimeMs: fstat.mtimeMs });
          } catch { continue; }
        }
      } catch { continue; }
    }
  } catch {
    return cache.totals;
  }

  const totalFiles = allFiles.length;

  for (const file of allFiles) {
    // Skip if already scanned and mtime unchanged
    const cached = cache.sessions[file.relPath];
    if (cached && cached.mtimeMs === file.mtimeMs) {
      scannedCount++;
      continue;
    }

    try {
      const commands = await scanSessionFile(file.absPath);
      cache.sessions[file.relPath] = {
        mtimeMs: file.mtimeMs,
        commands,
      };
      needsSave = true;
    } catch (err) {
      log('error', { function: 'scanAllSessions', file: file.relPath, message: String(err) });
    }

    scannedCount++;
    onProgress?.(scannedCount, totalFiles);
  }

  if (needsSave) {
    cache.totals = rebuildTotals(cache);
    saveCache(cache);
  }

  return cache.totals;
}

/**
 * Get cached usage counts without scanning (instant).
 * Returns empty if no scan has been done yet.
 */
export function getCachedUsage(): CommandUsageCounts {
  return loadCache().totals;
}

/**
 * Record a single command invocation (for forward tracking).
 */
export function recordUsage(commandName: string): void {
  const cache = loadCache();
  // Store forward-tracked usage under a synthetic "live" key
  const liveKey = '__live_tracking__';
  if (!cache.sessions[liveKey]) {
    cache.sessions[liveKey] = { mtimeMs: 0, commands: {} };
  }
  cache.sessions[liveKey].commands[commandName] =
    (cache.sessions[liveKey].commands[commandName] || 0) + 1;
  cache.totals[commandName] = (cache.totals[commandName] || 0) + 1;
  saveCache(cache);
}
