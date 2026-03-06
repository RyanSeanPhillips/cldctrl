/**
 * Typed sync wrapper around daemon cache for instant first paint in mini mode.
 * Reads cache.json synchronously — returns null if missing or stale (>5 min).
 */

import fs from 'node:fs';
import { getCachePath } from './background.js';
import type { DaemonCache, GitStatus, Issue, UsageStats } from '../types.js';

export interface CachedData {
  gitStatuses: Record<string, GitStatus>;
  issues: Record<string, Issue[]>;
  usageStats?: UsageStats;
}

export function loadCachedData(): CachedData | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;

    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) return null;

    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DaemonCache;
    if (!raw || typeof raw !== 'object') return null;

    return {
      gitStatuses: raw.gitStatuses ?? {},
      issues: raw.issues ?? {},
      usageStats: raw.usageStats,
    };
  } catch {
    return null;
  }
}
