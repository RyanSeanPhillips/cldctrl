/**
 * Background data: seen-issues persistence + usage stats aggregation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { log } from './logger.js';
import type { DaemonCache } from '../types.js';

// ── Atomic write helper ─────────────────────────────────────

export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// ── Seen issues (keyed by "repo#number" to avoid cross-repo collisions) ──

let seenIssueKeys: Set<string> = new Set();
let seenIssuesLoaded = false;

function getSeenIssuesPath(): string {
  return path.join(getConfigDir(), 'seen-issues.json');
}

/**
 * Build a unique key for an issue. Uses repo path + issue number
 * to avoid cross-repository collisions (issue #42 in project A ≠ #42 in B).
 */
export function issueKey(repoPath: string, issueNumber: number): string {
  return `${repoPath}#${issueNumber}`;
}

export function loadSeenIssues(): void {
  if (seenIssuesLoaded) return;

  const filePath = getSeenIssuesPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(raw)) {
        // Support both old format (numbers) and new format (strings)
        seenIssueKeys = new Set(
          raw.filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
            .map((id) => String(id))
        );
      }
    }
  } catch (err) {
    log('error', { function: 'loadSeenIssues', message: String(err) });
  }

  seenIssuesLoaded = true;
}

export function markIssueSeen(repoPath: string, issueNumber: number): void {
  seenIssueKeys.add(issueKey(repoPath, issueNumber));
  saveSeenIssues();
}

export function isIssueSeen(repoPath: string, issueNumber: number): boolean {
  loadSeenIssues();
  return seenIssueKeys.has(issueKey(repoPath, issueNumber));
}

function saveSeenIssues(): void {
  try {
    const filePath = getSeenIssuesPath();
    atomicWriteFile(filePath, JSON.stringify([...seenIssueKeys]) + '\n');
  } catch (err) {
    log('error', { function: 'saveSeenIssues', message: String(err) });
  }
}

// ── Daemon cache ────────────────────────────────────────────

export function getCachePath(): string {
  return path.join(getConfigDir(), 'cache.json');
}

export function readDaemonCache(): DaemonCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;

    const stat = fs.statSync(cachePath);
    const ageMs = Date.now() - stat.mtimeMs;
    // Accept cache up to 10 min old (daemon writes every 5 min)
    if (ageMs > 10 * 60 * 1000) return null;

    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.lastUpdated) return null;
    return raw as DaemonCache;
  } catch {
    return null;
  }
}

export function writeDaemonCache(data: Record<string, unknown>): void {
  try {
    const cachePath = getCachePath();
    atomicWriteFile(cachePath, JSON.stringify(data) + '\n');
  } catch (err) {
    log('error', { function: 'writeDaemonCache', message: String(err) });
  }
}
