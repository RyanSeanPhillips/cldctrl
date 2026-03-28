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

import fs from 'node:fs';
import { getRecentSessionFiles } from './projects.js';
import { normalizePathForCompare } from './platform.js';
import { log } from './logger.js';
import { readSessionMarkers, getMarkerPath } from './launcher.js';
import { getTrackedSessions, isProcessRunning } from './tracker.js';
import type { ActiveSession, SessionActivity } from '../types.js';

/** How recently a JSONL must have been modified to appear in conversations list */
const ACTIVE_THRESHOLD_MS = 5 * 60 * 60_000; // 5 hours (matches rate limit window)

/** Threshold for marking a session as "idle" (still shown, but dimmed) */
const IDLE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

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
  lastContextSize: 0,
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
  //    Dedup by project path (keep newest marker), auto-clean stale markers.
  try {
    const allMarkers = readSessionMarkers();

    // Group markers by normalized project path, keep only the newest per project
    const markersByProject = new Map<string, typeof allMarkers[0]>();
    const staleMarkerIds: string[] = [];
    for (const m of allMarkers) {
      const np = normalizePathForCompare(m.projectPath);
      const existing = markersByProject.get(np);
      if (existing) {
        // Keep newer, mark older for cleanup
        if (m.launchTime > existing.launchTime) {
          staleMarkerIds.push(existing.launchId);
          markersByProject.set(np, m);
        } else {
          staleMarkerIds.push(m.launchId);
        }
      } else {
        markersByProject.set(np, m);
      }
    }

    // Clean up duplicate markers (best-effort, don't block on errors)
    for (const id of staleMarkerIds) {
      try { fs.unlinkSync(getMarkerPath(id)); } catch { /* ignore */ }
    }

    for (const m of markersByProject.values()) {
      const np = normalizePathForCompare(m.projectPath);

      // Find the JSONL file for this session
      const recentFiles = getRecentSessionFiles(m.projectPath, now - m.launchTime + 60_000);
      const sessionFile = recentFiles.find(f => !claimedFiles.has(f.filePath)) ?? recentFiles[0] ?? null;
      const isRecentJsonl = sessionFile && (now - sessionFile.mtimeMs) < IDLE_THRESHOLD_MS;

      // Auto-clean stale markers: marker is old AND JSONL is idle (not actively being written).
      // A marker >5h old with >5min JSONL silence is almost certainly a dead session whose
      // cleanup script didn't run (terminal closed, crash, etc.). The session will reappear
      // via mtime detection if activity resumes.
      const markerAge = now - m.launchTime;
      if (markerAge > ACTIVE_THRESHOLD_MS && !isRecentJsonl) {
        try { fs.unlinkSync(getMarkerPath(m.launchId)); } catch { /* ignore */ }
        log('info', { function: 'getActiveClaudeProcesses', message: `Cleaned stale marker: ${m.launchId} (${m.projectPath})` });
        continue; // Don't create a session for a stale marker
      }

      coveredPaths.add(np);
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
      const isRecentJsonl = sessionFile && (now - sessionFile.mtimeMs) < IDLE_THRESHOLD_MS;

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

      for (const file of recentFiles) {
        if (claimedFiles.has(file.filePath)) continue;
        claimedFiles.add(file.filePath);

        const age = now - file.mtimeMs;
        const isIdle = age > IDLE_THRESHOLD_MS;

        sessions.push({
          pid: 0,
          sessionId: file.sessionId,
          sessionFilePath: file.filePath,
          projectPath: projPath,
          startTime: new Date(file.mtimeMs),
          lastActivity: new Date(file.mtimeMs),
          stats: { ...EMPTY_ACTIVITY },
          idle: isIdle,
        });
      }
    } catch (err) {
      log('error', { function: 'getActiveClaudeProcesses', message: String(err) });
    }
  }

  return sessions;
}
