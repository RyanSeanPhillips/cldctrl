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
import { normalizePathForCompare, pathIsSafe } from './platform.js';
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

// ── Module-level cache ───────────────────────────────────────
// Invalidated on writes and when the file mtime changes.

let _indexCache: { entries: IndexEntry[]; lastScan: string | null; mtime: number } | null = null;

function invalidateCache(): void {
  _indexCache = null;
}

// ── Read / Write ─────────────────────────────────────────────

export function readProjectIndex(): IndexEntry[] {
  const indexPath = getIndexPath();
  try {
    const stat = fs.statSync(indexPath);
    // Return cached result if file hasn't changed
    if (_indexCache && _indexCache.mtime === stat.mtimeMs) {
      return _indexCache.entries;
    }
    const data = fs.readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(data) as ProjectIndex;
    if (parsed.version !== 1) return [];
    // Validate paths on read
    const entries = parsed.entries.filter(e => pathIsSafe(e.path));
    _indexCache = { entries, lastScan: parsed.lastScan ?? null, mtime: stat.mtimeMs };
    return entries;
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
    const indexPath = getIndexPath();
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp file then rename
    const tmpPath = indexPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2));
    try {
      fs.renameSync(tmpPath, indexPath);
    } catch {
      // Rename may fail on Windows if target is locked (Dropbox, antivirus);
      // fall back to copy + delete
      fs.copyFileSync(tmpPath, indexPath);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    invalidateCache();
  } catch (err) {
    log('error', { function: 'writeProjectIndex', message: String(err) });
  }
}

/** Returns ISO timestamp of last scan, or null if never scanned */
export function getLastScanTime(): string | null {
  // Leverage the cache populated by readProjectIndex
  readProjectIndex();
  return _indexCache?.lastScan ?? null;
}

// ── Merge scan results into index ────────────────────────────

/**
 * Merge new scan results into the existing index.
 * - New paths are added
 * - Existing paths are updated (indicators may change)
 * - Stale entries are pruned in a deferred microtask (doesn't block render)
 */
export function mergeIntoIndex(scanResults: ScanResult[]): IndexEntry[] {
  const existing = readProjectIndex();
  const now = new Date().toISOString();

  // Track which paths were just scanned (known-fresh, no existence check needed)
  const scannedPaths = new Set(scanResults.map(r => normalizePathForCompare(r.path)));

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

  const entries = Array.from(byPath.values());
  writeProjectIndex(entries);

  // Defer pruning of stale entries — check existence in background
  // to avoid blocking the event loop during scan completion
  setImmediate(() => {
    let pruned = false;
    const validEntries: IndexEntry[] = [];
    for (const entry of entries) {
      // Skip existence check for entries that were just scanned
      if (scannedPaths.has(normalizePathForCompare(entry.path))) {
        validEntries.push(entry);
        continue;
      }
      try {
        if (fs.existsSync(entry.path)) {
          validEntries.push(entry);
        } else {
          pruned = true;
        }
      } catch {
        // Skip entries we can't check (permission errors, etc.)
        validEntries.push(entry);
      }
    }
    if (pruned) {
      writeProjectIndex(validEntries);
    }
  });

  return entries;
}
