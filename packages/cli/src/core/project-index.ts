/**
 * Persistent project index: caches filesystem scan results so discovered
 * projects survive app restarts without re-scanning.
 *
 * Stored in the config directory as project-index.json.
 * Updated when the user triggers a scan (S key) or on first run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { normalizePathForCompare } from './platform.js';
import { log } from './logger.js';
import type { ScanResult } from './scanner.js';

// ── Types ────────────────────────────────────────────────────

export interface IndexEntry {
  path: string;
  name: string;
  indicators: string[];
  hasClaude: boolean;
  hasGit: boolean;
  /** ISO timestamp of when this entry was discovered */
  discoveredAt: string;
}

interface ProjectIndex {
  version: 1;
  /** ISO timestamp of last scan */
  lastScan: string;
  entries: IndexEntry[];
}

// ── Paths ────────────────────────────────────────────────────

function getIndexPath(): string {
  return path.join(getConfigDir(), 'project-index.json');
}

// ── Read / Write ─────────────────────────────────────────────

export function readProjectIndex(): IndexEntry[] {
  try {
    const data = fs.readFileSync(getIndexPath(), 'utf-8');
    const parsed = JSON.parse(data) as ProjectIndex;
    if (parsed.version !== 1) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

export function writeProjectIndex(entries: IndexEntry[]): void {
  const index: ProjectIndex = {
    version: 1,
    lastScan: new Date().toISOString(),
    entries,
  };
  try {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2));
  } catch (err) {
    log('error', { function: 'writeProjectIndex', message: String(err) });
  }
}

/** Returns ISO timestamp of last scan, or null if never scanned */
export function getLastScanTime(): string | null {
  try {
    const data = fs.readFileSync(getIndexPath(), 'utf-8');
    const parsed = JSON.parse(data) as ProjectIndex;
    return parsed.lastScan ?? null;
  } catch {
    return null;
  }
}

// ── Merge scan results into index ────────────────────────────

/**
 * Merge new scan results into the existing index.
 * - New paths are added
 * - Existing paths are updated (indicators may change)
 * - Paths that no longer exist on disk are pruned
 */
export function mergeIntoIndex(scanResults: ScanResult[]): IndexEntry[] {
  const existing = readProjectIndex();
  const now = new Date().toISOString();

  // Build map of existing entries keyed by normalized path
  const byPath = new Map<string, IndexEntry>();
  for (const e of existing) {
    byPath.set(normalizePathForCompare(e.path), e);
  }

  // Upsert scan results
  for (const r of scanResults) {
    const key = normalizePathForCompare(r.path);
    const prev = byPath.get(key);
    byPath.set(key, {
      path: r.path,
      name: r.name,
      indicators: r.indicators,
      hasClaude: r.hasClaude,
      hasGit: r.hasGit,
      discoveredAt: prev?.discoveredAt ?? now,
    });
  }

  // Prune entries whose paths no longer exist
  const pruned: IndexEntry[] = [];
  for (const entry of byPath.values()) {
    try {
      if (fs.existsSync(entry.path)) {
        pruned.push(entry);
      }
    } catch {
      // Skip entries we can't check (permission errors, etc.)
      pruned.push(entry);
    }
  }

  writeProjectIndex(pruned);
  return pruned;
}
