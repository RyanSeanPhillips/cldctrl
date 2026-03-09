/**
 * Active Claude session detection via JSONL file mtime + PID tracking.
 *
 * Two sources:
 * 1. Tracked PIDs — sessions launched from cc. PID alive = open (even if idle).
 * 2. Mtime detection — sessions launched outside cc. JSONL modified < 30s = active.
 *
 * Results are merged and deduplicated by projectPath.
 */

import { getNewestSessionFile } from './projects.js';
import { log } from './logger.js';
import { getTrackedSessions, isProcessRunning } from './tracker.js';
import { normalizePathForCompare } from './platform.js';
import type { ActiveSession, SessionActivity } from '../types.js';

/** How recently a JSONL must have been modified to count as "active" */
const ACTIVE_THRESHOLD_MS = 30_000; // 30 seconds

const EMPTY_ACTIVITY: SessionActivity = {
  messages: 0,
  tokens: 0,
  toolCalls: { reads: 0, writes: 0, bash: 0, other: 0 },
  mcpCalls: {},
  agentSpawns: 0,
  interruptions: 0,
  models: {},
  thinkingTokens: 0,
  duration: 0,
  hourlyActivity: new Array(24).fill(0),
};

/**
 * Detect active Claude sessions by combining PID tracking and JSONL mtime.
 *
 * - Tracked sessions (launched from cc): shown as long as PID is alive.
 *   If JSONL was modified recently → ACTIVE. Otherwise → IDLE.
 * - Untracked sessions: shown only if JSONL modified within 30s (ACTIVE).
 */
export async function getActiveClaudeProcesses(
  knownPaths: string[] = []
): Promise<ActiveSession[]> {
  const sessions: ActiveSession[] = [];
  const now = Date.now();
  const seenPaths = new Set<string>();

  // 1. Tracked sessions (cc-launched, PID-based)
  try {
    const tracked = getTrackedSessions();
    for (const t of tracked) {
      if (!isProcessRunning(t.pid)) continue;

      const normalizedPath = normalizePathForCompare(t.projectPath);
      seenPaths.add(normalizedPath);

      const newest = getNewestSessionFile(t.projectPath);
      const isRecentJsonl = newest && (now - newest.mtimeMs) < ACTIVE_THRESHOLD_MS;

      sessions.push({
        pid: t.pid,
        sessionId: newest?.sessionId ?? '',
        projectPath: t.projectPath,
        startTime: new Date(t.launchTime),
        lastActivity: newest ? new Date(newest.mtimeMs) : new Date(t.launchTime),
        stats: { ...EMPTY_ACTIVITY },
        tracked: true,
        idle: !isRecentJsonl,
      });
    }
  } catch (err) {
    log('error', { function: 'getActiveClaudeProcesses', message: `Tracker: ${err}` });
  }

  // 2. Mtime-based detection (sessions launched outside cc)
  for (const projPath of knownPaths) {
    try {
      const normalizedPath = normalizePathForCompare(projPath);
      if (seenPaths.has(normalizedPath)) continue; // already tracked

      const newest = getNewestSessionFile(projPath);
      if (!newest) continue;

      const age = now - newest.mtimeMs;
      if (age > ACTIVE_THRESHOLD_MS) continue;

      seenPaths.add(normalizedPath);

      sessions.push({
        pid: 0,
        sessionId: newest.sessionId,
        projectPath: projPath,
        startTime: new Date(newest.mtimeMs),
        lastActivity: new Date(newest.mtimeMs),
        stats: { ...EMPTY_ACTIVITY },
      });
    } catch (err) {
      log('error', { function: 'getActiveClaudeProcesses', message: String(err) });
    }
  }

  return sessions;
}
