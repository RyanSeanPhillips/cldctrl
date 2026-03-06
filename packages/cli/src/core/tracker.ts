/**
 * PID-based session tracking for cc-launched Claude sessions.
 * Persists tracked sessions to tracked-sessions.json in the config dir.
 * Allows detection of idle sessions (PID alive but JSONL stale).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigDir } from '../config.js';
import { log } from './logger.js';

export interface TrackedSession {
  pid: number;
  projectPath: string;
  sessionId?: string;
  launchTime: number;
  status: 'running' | 'closed';
}

function getTrackerPath(): string {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'tracked-sessions.json');
}

function readTracker(): TrackedSession[] {
  try {
    const data = fs.readFileSync(getTrackerPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeTracker(sessions: TrackedSession[]): void {
  try {
    fs.writeFileSync(getTrackerPath(), JSON.stringify(sessions, null, 2));
  } catch (err) {
    log('error', { function: 'writeTracker', message: String(err) });
  }
}

/**
 * Check if a process with the given PID is still running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Node built-in: signal 0 checks existence without killing
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'EPERM') {
      // Process exists but we don't have permission (still running)
      return true;
    }
    // ESRCH = no such process
    return false;
  }
}

/**
 * Track a newly launched session by PID.
 */
export function trackSession(pid: number, projectPath: string): void {
  const sessions = readTracker();

  // Avoid duplicates
  if (sessions.some(s => s.pid === pid && s.status === 'running')) return;

  sessions.push({
    pid,
    projectPath,
    launchTime: Date.now(),
    status: 'running',
  });

  writeTracker(sessions);
  log('tracker', { action: 'track', pid, projectPath });
}

/**
 * Get all tracked sessions that are still running.
 */
export function getTrackedSessions(): TrackedSession[] {
  const sessions = readTracker();
  return sessions.filter(s => s.status === 'running');
}

/**
 * Check each tracked session's PID and mark dead ones as closed.
 * Returns the number of sessions pruned.
 */
export function pruneClosedSessions(): number {
  const sessions = readTracker();
  let pruned = 0;

  for (const s of sessions) {
    if (s.status === 'running' && !isProcessRunning(s.pid)) {
      s.status = 'closed';
      pruned++;
    }
  }

  if (pruned > 0) {
    // Keep only running sessions + recent closed ones (last 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept = sessions.filter(
      s => s.status === 'running' || s.launchTime > cutoff
    );
    writeTracker(kept);
    log('tracker', { action: 'prune', pruned });
  }

  return pruned;
}
