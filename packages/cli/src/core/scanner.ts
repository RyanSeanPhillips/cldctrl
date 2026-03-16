/**
 * Project scanner: discovers projects by searching for indicator files.
 * Searches smart default directories (home, Dropbox, dev folders) with depth limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPlatform, normalizePathForCompare } from './platform.js';
import { extractProjectName, getProjectSlug } from './projects.js';
import type { Config, Project } from '../types.js';

// ── Types ────────────────────────────────────────────────────

export interface ScanResult {
  path: string;
  name: string;
  indicators: string[];
  hasClaude: boolean;
  hasGit: boolean;
}

export interface ScanProgress {
  phase: 'scanning' | 'done';
  directoriesScanned: number;
  projectsFound: number;
  currentRoot: string;
}

export interface ScanOptions {
  roots?: string[];
  maxDepth?: number;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
}

// ── Constants ────────────────────────────────────────────────

/** Files that indicate a directory is a project root */
const PROJECT_INDICATORS = [
  'CLAUDE.md', '.git', 'package.json', 'pyproject.toml', 'setup.py',
  'Cargo.toml', 'go.mod', 'Makefile', 'CMakeLists.txt',
  'build.gradle', '.sln', 'Gemfile', 'mix.exs', 'dune-project',
  'flake.nix', 'Pipfile', 'requirements.txt',
];

/** Directories to never descend into */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'target', 'build', 'dist', '.next', '.cache', '.tox',
  '.mypy_cache', '.pytest_cache', '.npm', '.yarn', '.pnpm-store',
  'vendor', '$RECYCLE.BIN', 'System Volume Information',
  '.Trash', 'AppData', 'Library', '.local', '.config',
  'Program Files', 'Program Files (x86)', 'Windows',
  '.conda', '.rustup', '.cargo', 'miniconda3', 'anaconda3',
  'OneDrive - SCH', // Skip managed OneDrive synced folders
]);

// ── Default scan roots ───────────────────────────────────────

export function getDefaultScanRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [home];

  // Common developer directories
  const devDirs = [
    'Projects', 'projects', 'repos', 'Repos', 'src', 'dev', 'code',
    'Code', 'workspace', 'Workspace', 'github', 'GitHub', 'work', 'Work',
  ];
  for (const dir of devDirs) {
    const full = path.join(home, dir);
    if (existsQuiet(full)) roots.push(full);
  }

  const platform = getPlatform();
  if (platform === 'windows') {
    const dropbox = path.join(home, 'Dropbox');
    const onedrive = process.env.OneDrive || path.join(home, 'OneDrive');
    if (existsQuiet(dropbox)) roots.push(dropbox);
    if (existsQuiet(onedrive)) roots.push(onedrive);
  } else if (platform === 'macos') {
    const docs = path.join(home, 'Documents');
    if (existsQuiet(docs)) roots.push(docs);
  }

  return deduplicateRoots(roots);
}

function existsQuiet(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Remove roots that are ancestors of other roots (keep the deepest) */
function deduplicateRoots(roots: string[]): string[] {
  const normalized = roots.map(r => ({ orig: r, norm: normalizePathForCompare(r) }));
  return normalized
    .filter(r => !normalized.some(
      other => other.norm !== r.norm && r.norm.startsWith(other.norm + path.sep),
    ))
    .map(r => r.orig);
}

// ── Scanner ──────────────────────────────────────────────────

/**
 * Scan filesystem for projects. Synchronous BFS with depth limit.
 * Returns array of discovered project paths with indicators found.
 */
export function scanForProjects(opts: ScanOptions = {}): ScanResult[] {
  const roots = opts.roots ?? getDefaultScanRoots();
  const maxDepth = opts.maxDepth ?? 5;
  const results: ScanResult[] = [];
  const seenPaths = new Set<string>();
  let dirCount = 0;

  for (const root of roots) {
    if (opts.signal?.aborted) break;

    opts.onProgress?.({
      phase: 'scanning',
      directoriesScanned: dirCount,
      projectsFound: results.length,
      currentRoot: root,
    });

    scanDir(root, 0);
  }

  opts.onProgress?.({
    phase: 'done',
    directoriesScanned: dirCount,
    projectsFound: results.length,
    currentRoot: '',
  });

  return results;

  function scanDir(dirPath: string, depth: number): void {
    if (depth > maxDepth) return;
    if (opts.signal?.aborted) return;

    dirCount++;

    // Report progress every 50 directories
    if (dirCount % 50 === 0) {
      opts.onProgress?.({
        phase: 'scanning',
        directoriesScanned: dirCount,
        projectsFound: results.length,
        currentRoot: dirPath,
      });
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Check for project indicators in this directory
    const entryNames = new Set(entries.map(e => e.name));
    const found = PROJECT_INDICATORS.filter(ind => entryNames.has(ind));

    if (found.length > 0) {
      const key = normalizePathForCompare(dirPath);
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        results.push({
          path: dirPath,
          name: path.basename(dirPath),
          indicators: found,
          hasClaude: found.includes('CLAUDE.md'),
          hasGit: found.includes('.git'),
        });
      }
    }

    // Descend into subdirectories
    for (const entry of entries) {
      // Dropbox/OneDrive cloud reparse points report isDirectory()=false and
      // isSymbolicLink()=true from Dirent, but lstatSync correctly identifies
      // them as directories. Fall through to the lstat check for non-directory
      // entries that claim to be symlinks.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;

      const childPath = path.join(dirPath, entry.name);

      // For entries that aren't plain directories (symlinks or reparse points),
      // verify with lstat: skip true symlinks, allow reparse-point directories
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          const stat = fs.lstatSync(childPath);
          if (stat.isSymbolicLink()) continue; // true symlink
          if (!stat.isDirectory()) continue;   // not a directory after resolving
        } catch { continue; }
      }

      scanDir(childPath, depth + 1);
    }
  }
}

// ── Merge with existing projects ─────────────────────────────

/**
 * Merge scan results into existing project list, deduplicating by path.
 * New projects are appended with discovered=true.
 */
export function mergeScannedProjects(
  existing: Project[],
  scanned: ScanResult[],
  config: Config,
): Project[] {
  const seenPaths = new Set(existing.map(p => normalizePathForCompare(p.path)));
  const hiddenSet = new Set(config.hidden_projects.map(p => normalizePathForCompare(p)));
  const newProjects: Project[] = [...existing];

  for (const s of scanned) {
    const key = normalizePathForCompare(s.path);
    if (seenPaths.has(key)) continue;
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);

    // Try to extract a better name from project metadata
    let name: string;
    try {
      name = extractProjectName(s.path);
    } catch {
      name = s.name;
    }

    newProjects.push({
      name,
      path: s.path,
      slug: getProjectSlug(s.path),
      pinned: false,
      discovered: true,
    });
  }

  return newProjects;
}
