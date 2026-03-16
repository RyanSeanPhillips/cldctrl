/**
 * Active Claude session detection via marker files + JSONL mtime.
 *
 * Three sources (in priority order):
 * 1. Session markers — files in pids/ created by launch scripts. Exist only
 *    while Claude is running (deleted on exit). Cross-platform, no process
 *    scanning needed.
 * 2. Tracked PIDs — legacy sessions launched before marker support.
 * 3. Mtime detection — JSONL modified recently (catches sessions launched
 *    outside cldctrl).
 *
 * Multiple sessions per project are supported.
 */

import { getRecentSessionFiles } from './projects.js';
import { normalizePathForCompare } from './platform.js';
import { log } from './logger.js';
import { readSessionMarkers } from './launcher.js';
import { getTrackedSessions, isProcessRunning } from './tracker.js';
import type { ActiveSession, SessionActivity } from '../types.js';

/** How recently a JSONL must have been modified to count as "active" (mtime fallback) */
const ACTIVE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

const EMPTY_ACTIVITY: SessionActivity = {
  messages: 0,
  tokens: 0,
  tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  inputPerMessage: [],
  toolCalls: { reads: 0, writes: 0, bash: 0, other: 0 },
  mcpCalls: {},
  agentSpawns: 0,
  interruptions: 0,
  models: {},
  thinkingTokens: 0,
  duration: 0,
  hourlyActivity: new Array(24).fill(0),
  assistantTurns: 0,
  toolUseTurns: 0,
};

// ── Main detection function ──────────────────────────────────

/**
 * Detect active Claude sessions via marker files, PID tracking, and JSONL mtime.
 */
export async function getActiveClaudeProcesses(
  knownPaths: string[] = []
): Promise<ActiveSession[]> {
  const sessions: ActiveSession[] = [];
  const now = Date.now();
  const claimedFiles = new Set<string>();
  const coveredPaths = new Set<string>();

  // 1. Session markers (cross-platform — files exist while Claude is running)
  try {
    const markers = readSessionMarkers();
    for (const m of markers) {
      const np = normalizePathForCompare(m.projectPath);
      coveredPaths.add(np);

      // Find the JSONL file for this session
      const recentFiles = getRecentSessionFiles(m.projectPath, now - m.launchTime + 60_000);
      const sessionFile = recentFiles.find(f => !claimedFiles.has(f.filePath)) ?? recentFiles[0] ?? null;
      const isRecentJsonl = sessionFile && (now - sessionFile.mtimeMs) < ACTIVE_THRESHOLD_MS;

      if (sessionFile) claimedFiles.add(sessionFile.filePath);

      sessions.push({
        pid: 0,
        sessionId: sessionFile?.sessionId ?? '',
        sessionFilePath: sessionFile?.filePath,
        projectPath: m.projectPath,
        startTime: new Date(m.launchTime),
        lastActivity: sessionFile ? new Date(sessionFile.mtimeMs) : new Date(m.launchTime),
        stats: { ...EMPTY_ACTIVITY },
        tracked: true,
        idle: !isRecentJsonl,
      });
    }
  } catch (err) {
    log('error', { function: 'getActiveClaudeProcesses', message: `Markers: ${err}` });
  }

  // 2. Tracked PIDs (legacy — sessions launched before marker support)
  try {
    const tracked = getTrackedSessions();
    for (const t of tracked) {
      if (!isProcessRunning(t.pid)) continue;

      const np = normalizePathForCompare(t.projectPath);
      if (coveredPaths.has(np)) continue; // already found by marker
      coveredPaths.add(np);

      const recentFiles = getRecentSessionFiles(t.projectPath, ACTIVE_THRESHOLD_MS);
      const sessionFile = recentFiles.find(f => !claimedFiles.has(f.filePath)) ?? recentFiles[0] ?? null;
      const isRecentJsonl = sessionFile && (now - sessionFile.mtimeMs) < ACTIVE_THRESHOLD_MS;

      if (sessionFile) claimedFiles.add(sessionFile.filePath);

      sessions.push({
        pid: t.pid,
        sessionId: sessionFile?.sessionId ?? '',
        sessionFilePath: sessionFile?.filePath,
        projectPath: t.projectPath,
        startTime: new Date(t.launchTime),
        lastActivity: sessionFile ? new Date(sessionFile.mtimeMs) : new Date(t.launchTime),
        stats: { ...EMPTY_ACTIVITY },
        tracked: true,
        idle: !isRecentJsonl,
      });
    }
  } catch (err) {
    log('error', { function: 'getActiveClaudeProcesses', message: `Tracker: ${err}` });
  }

  // 3. Mtime-based detection (sessions launched outside cldctrl)
  for (const projPath of knownPaths) {
    try {
      const normalizedPath = normalizePathForCompare(projPath);
      if (coveredPaths.has(normalizedPath)) continue;

      const recentFiles = getRecentSessionFiles(projPath, ACTIVE_THRESHOLD_MS);
      if (recentFiles.length === 0) continue;

      const newest = recentFiles.find(f => !claimedFiles.has(f.filePath)) ?? recentFiles[0];
      if (!newest) continue;

      const age = now - newest.mtimeMs;
      const isIdle = age > 30_000;

      sessions.push({
        pid: 0,
        sessionId: newest.sessionId,
        projectPath: projPath,
        startTime: new Date(newest.mtimeMs),
        lastActivity: new Date(newest.mtimeMs),
        stats: { ...EMPTY_ACTIVITY },
        idle: isIdle,
      });
    } catch (err) {
      log('error', { function: 'getActiveClaudeProcesses', message: String(err) });
    }
  }

  return sessions;
}
