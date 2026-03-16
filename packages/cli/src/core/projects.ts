/**
 * Project slug generation, discovery from ~/.claude/projects, list building.
 * CRITICAL: slug uses global regex to match PowerShell .Replace() behavior.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getClaudeProjectsDir, normalizePathForCompare } from './platform.js';
import { isFeatureEnabled } from '../config.js';
import { log } from './logger.js';
import { readProjectNameCache, writeProjectNameCache } from './project-cache.js';
import { readProjectIndex } from './project-index.js';
import type { Config, Project } from '../types.js';

// ── Slug generation (MUST match PowerShell Get-ProjectSlug) ─

/**
 * Convert a filesystem path to the Claude session slug.
 * PowerShell uses chained .Replace() which is globally replacing.
 * JavaScript .replace(string) only replaces first occurrence — MUST use regex /g.
 */
export function getProjectSlug(projectPath: string): string {
  return projectPath.replace(/[:\\/_ ]/g, '-');
}

/**
 * Attempt to reconstruct the original path from a slug directory name.
 * Slug format on Windows: C-Users-name-path-to-project
 * First segment is the drive letter, rest are path separators.
 */
export function pathFromSlug(slug: string): string | null {
  const parts = slug.split('-');
  if (parts.length < 2) return null;

  // Detect if first part looks like a Windows drive letter (single uppercase char)
  if (parts[0].length === 1 && /^[A-Z]$/i.test(parts[0])) {
    const driveLetter = parts[0];
    const remaining = parts.slice(1).join(path.sep);
    return `${driveLetter}:${path.sep}${remaining}`;
  }

  // Unix-style: slug segments become path segments
  return path.sep + parts.join(path.sep);
}

/**
 * Get the session directory for a project.
 */
export function getSessionDir(projectPath: string): string {
  return path.join(getClaudeProjectsDir(), getProjectSlug(projectPath));
}

// ── Project name extraction ──────────────────────────────────

/**
 * Try to extract a human-readable project name from metadata files.
 * Checks package.json, pyproject.toml, Cargo.toml, go.mod, etc.
 * Falls back to the directory basename.
 */
export function extractProjectName(projectPath: string): string {
  const basename = path.basename(projectPath);

  try {
    // package.json (Node/JS)
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      // Use displayName if available, otherwise name (skip scoped prefixes)
      const name = pkg.displayName ?? pkg.name;
      if (name && typeof name === 'string') {
        // Strip npm scope (@org/name → name)
        const clean = name.replace(/^@[^/]+\//, '');
        if (clean) return clean;
      }
    }
  } catch { /* ignore */ }

  try {
    // pyproject.toml (Python)
    const pyPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyPath)) {
      const content = fs.readFileSync(pyPath, 'utf-8');
      const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
  } catch { /* ignore */ }

  try {
    // setup.py (Python legacy)
    const setupPath = path.join(projectPath, 'setup.py');
    if (fs.existsSync(setupPath)) {
      const content = fs.readFileSync(setupPath, 'utf-8');
      const match = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
      if (match) return match[1];
    }
  } catch { /* ignore */ }

  try {
    // Cargo.toml (Rust)
    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      const content = fs.readFileSync(cargoPath, 'utf-8');
      const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
  } catch { /* ignore */ }

  try {
    // Git remote: extract repo name from origin URL
    // e.g. "git@github.com:user/PhysioMetrics.git" → "PhysioMetrics"
    // e.g. "https://github.com/user/PhysioMetrics.git" → "PhysioMetrics"
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().trim();

    if (remoteUrl) {
      // Strip .git suffix and extract last path segment
      const cleaned = remoteUrl.replace(/\.git$/, '');
      const repoName = cleaned.split('/').pop()?.split(':').pop();
      if (repoName && repoName !== basename) return repoName;
    }
  } catch { /* not a git repo or no remote */ }

  return basename;
}

// ── Discovery ───────────────────────────────────────────────

/**
 * Discover projects from ~/.claude/projects by finding slug directories
 * that contain at least one .jsonl session file.
 */
export function discoverProjects(): Array<{ name: string; path: string; slug: string; lastActivity: Date }> {
  const claudeDir = getClaudeProjectsDir();
  if (!fs.existsSync(claudeDir)) return [];

  const discovered: Array<{ name: string; path: string; slug: string; lastActivity: Date }> = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const slugDir = path.join(claudeDir, entry.name);

    // Check for .jsonl session files
    let hasSession = false;
    let latestMtime = new Date(0);
    try {
      const files = fs.readdirSync(slugDir);
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          hasSession = true;
          try {
            const stat = fs.statSync(path.join(slugDir, f));
            if (stat.mtime > latestMtime) latestMtime = stat.mtime;
          } catch { /* skip */ }
        }
      }
    } catch { continue; }

    if (!hasSession) continue;

    // Try to get the project path from the first session file
    const projectPath = getProjectPathFromSlug(slugDir);
    if (!projectPath) continue;

    // Skip common non-project directories (Documents, Desktop, home root, etc.)
    const basename = path.basename(projectPath).toLowerCase();
    const parent = path.dirname(projectPath);
    const isUserRoot = normalizePathForCompare(projectPath) === normalizePathForCompare(os.homedir());
    const isShellFolder = ['documents', 'desktop', 'downloads', 'pictures', 'music', 'videos'].includes(basename)
      && (parent === os.homedir() || parent.includes('OneDrive'));
    if (isUserRoot || isShellFolder) continue;

    // Derive a display name from project metadata, falling back to folder name
    const name = extractProjectName(projectPath);

    discovered.push({
      name,
      path: projectPath,
      slug: entry.name,
      lastActivity: latestMtime,
    });
  }

  return discovered;
}

/**
 * Read the first session file in a slug directory to extract the project path.
 * Mirrors PowerShell Get-ProjectPathFromSlug.
 * Results (including null) are cached to avoid redundant 32KB reads.
 */
const slugToPathCache = new Map<string, string | null>();

function getProjectPathFromSlug(slugDir: string): string | null {
  const cached = slugToPathCache.get(slugDir);
  if (cached !== undefined) return cached;

  let result: string | null = null;
  try {
    const files = fs.readdirSync(slugDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first by name

    if (files.length === 0) {
      slugToPathCache.set(slugDir, null);
      return null;
    }

    // Read first 32KB chunk to find cwd. We use a regex scan on raw text
    // so it works even when JSON lines are truncated by the chunk boundary.
    const filePath = path.join(slugDir, files[0]);
    const CHUNK_SIZE = 32768;
    const buf = Buffer.alloc(CHUNK_SIZE);
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      slugToPathCache.set(slugDir, null);
      return null;
    }
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, 0);
    } finally {
      fs.closeSync(fd);
    }
    const chunk = buf.toString('utf-8', 0, bytesRead);

    // First try: parse complete JSON lines for cwd
    const lines = chunk.split('\n').slice(0, 20);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) { result = parsed.cwd; break; }
        if (parsed.message?.cwd) { result = parsed.message.cwd; break; }
      } catch { /* line may be truncated by chunk boundary */ }
    }

    // Fallback: regex scan for "cwd" field in raw text (handles truncated lines)
    if (!result) {
      const cwdMatch = chunk.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cwdMatch) {
        // Unescape JSON string (backslash sequences)
        result = cwdMatch[1].replace(/\\(.)/g, (_: string, c: string) =>
          c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c,
        );
      }
    }
  } catch {
    // result stays null
  }

  slugToPathCache.set(slugDir, result);
  return result;
}

// ── List building ───────────────────────────────────────────

/**
 * Build the unified project list: pinned first, then discovered.
 * Deduplicates by path (case-insensitive on Windows).
 */
export function buildProjectList(config: Config): Project[] {
  const projects: Project[] = [];
  const seenPaths = new Set<string>();
  const hiddenSet = new Set(config.hidden_projects.map((p) => normalizePathForCompare(p)));
  const nameCache: Record<string, string> = {};

  // Add configured (pinned) projects
  for (const p of config.projects) {
    const key = normalizePathForCompare(p.path);
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);

    // Use config name if customized, otherwise try to extract from project metadata
    const isDefaultName = p.name === path.basename(p.path);
    const displayName = isDefaultName ? extractProjectName(p.path) : p.name;
    nameCache[p.path] = displayName;

    projects.push({
      name: displayName,
      path: p.path,
      slug: getProjectSlug(p.path),
      pinned: true,
      discovered: false,
    });
  }

  // Add discovered projects (not already in config) — skip if auto_discovery disabled
  const discovered = isFeatureEnabled(config, 'auto_discovery') ? discoverProjects() : [];
  discovered.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  for (const d of discovered) {
    const key = normalizePathForCompare(d.path);
    if (seenPaths.has(key)) continue;
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);
    nameCache[d.path] = d.name;

    projects.push({
      name: d.name,
      path: d.path,
      slug: d.slug,
      pinned: false,
      discovered: true,
      lastActivity: d.lastActivity,
    });
  }

  // Add indexed projects (from previous filesystem scans) — these may not have Claude sessions yet
  // Skip entries that are subdirectories of already-seen projects (stale index data)
  const indexed = readProjectIndex();
  for (const entry of indexed) {
    const key = normalizePathForCompare(entry.path);
    if (seenPaths.has(key)) continue;
    if (hiddenSet.has(key)) continue;
    // Skip if this path is a child of an already-seen project
    let isSubdir = false;
    for (const seen of seenPaths) {
      if (key.startsWith(seen + path.sep.toLowerCase())) { isSubdir = true; break; }
    }
    if (isSubdir) continue;
    seenPaths.add(key);

    let displayName: string;
    try { displayName = extractProjectName(entry.path); } catch { displayName = entry.name; }
    nameCache[entry.path] = displayName;

    projects.push({
      name: displayName,
      path: entry.path,
      slug: getProjectSlug(entry.path),
      pinned: false,
      discovered: true,
    });
  }

  // Persist name cache for fast mini TUI lookups
  try { writeProjectNameCache(nameCache); } catch {}

  return projects;
}

/**
 * Fast project list builder for mini TUI.
 * Uses cached names (no git spawns, no metadata reads).
 * Falls back to path.basename() for uncached projects.
 * Also populates the cache for future runs.
 */
export function buildProjectListFast(config: Config): Project[] {
  const nameCache = readProjectNameCache();
  const projects: Project[] = [];
  const seenPaths = new Set<string>();
  const hiddenSet = new Set(config.hidden_projects.map((p) => normalizePathForCompare(p)));
  let cacheUpdated = false;

  // Add configured (pinned) projects
  for (const p of config.projects) {
    const key = normalizePathForCompare(p.path);
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);

    const isDefaultName = p.name === path.basename(p.path);
    const displayName = isDefaultName
      ? (nameCache[p.path] ?? path.basename(p.path))
      : p.name;

    projects.push({
      name: displayName,
      path: p.path,
      slug: getProjectSlug(p.path),
      pinned: true,
      discovered: false,
    });
  }

  // Add discovered projects using cached names — skip if auto_discovery disabled
  const discovered = isFeatureEnabled(config, 'auto_discovery') ? discoverProjectsFast(nameCache) : [];
  discovered.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  for (const d of discovered) {
    const key = normalizePathForCompare(d.path);
    if (seenPaths.has(key)) continue;
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);

    projects.push({
      name: d.name,
      path: d.path,
      slug: d.slug,
      pinned: false,
      discovered: true,
      lastActivity: d.lastActivity,
    });
  }

  // Add indexed projects (from previous filesystem scans)
  // Skip entries that are subdirectories of already-seen projects
  const indexed = readProjectIndex();
  for (const entry of indexed) {
    const key = normalizePathForCompare(entry.path);
    if (seenPaths.has(key)) continue;
    if (hiddenSet.has(key)) continue;
    let isSubdir = false;
    for (const seen of seenPaths) {
      if (key.startsWith(seen + path.sep.toLowerCase())) { isSubdir = true; break; }
    }
    if (isSubdir) continue;
    seenPaths.add(key);

    const displayName = nameCache[entry.path] ?? entry.name;
    if (!nameCache[entry.path]) {
      nameCache[entry.path] = displayName;
      cacheUpdated = true;
    }

    projects.push({
      name: displayName,
      path: entry.path,
      slug: getProjectSlug(entry.path),
      pinned: false,
      discovered: true,
    });
  }

  if (cacheUpdated) {
    try { writeProjectNameCache(nameCache); } catch {}
  }

  return projects;
}

/**
 * Discover projects WITHOUT expensive name extraction.
 * Uses cache for names, falls back to basename.
 */
function discoverProjectsFast(
  nameCache: Record<string, string>,
): Array<{ name: string; path: string; slug: string; lastActivity: Date }> {
  const claudeDir = getClaudeProjectsDir();
  if (!fs.existsSync(claudeDir)) return [];

  const discovered: Array<{ name: string; path: string; slug: string; lastActivity: Date }> = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const slugDir = path.join(claudeDir, entry.name);

    let hasSession = false;
    let latestMtime = new Date(0);
    try {
      const files = fs.readdirSync(slugDir);
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          hasSession = true;
          try {
            const stat = fs.statSync(path.join(slugDir, f));
            if (stat.mtime > latestMtime) latestMtime = stat.mtime;
          } catch { /* skip */ }
        }
      }
    } catch { continue; }

    if (!hasSession) continue;

    const projectPath = getProjectPathFromSlug(slugDir);
    if (!projectPath) continue;

    // Skip common non-project directories (Documents, Desktop, home root, etc.)
    const basename = path.basename(projectPath).toLowerCase();
    const parent = path.dirname(projectPath);
    const isUserRoot = normalizePathForCompare(projectPath) === normalizePathForCompare(os.homedir());
    const isShellFolder = ['documents', 'desktop', 'downloads', 'pictures', 'music', 'videos'].includes(basename)
      && (parent === os.homedir() || parent.includes('OneDrive'));
    if (isUserRoot || isShellFolder) continue;

    // Use cached name or basename (NO git, NO metadata reads)
    const name = nameCache[projectPath] ?? path.basename(projectPath);

    discovered.push({
      name,
      path: projectPath,
      slug: entry.name,
      lastActivity: latestMtime,
    });
  }

  return discovered;
}

/**
 * Find the newest .jsonl file in a project's session directory.
 * Shared by processes.ts and tailer.ts.
 */
export function getNewestSessionFile(projectPath: string): {
  filePath: string;
  mtimeMs: number;
  sessionId: string;
} | null {
  const all = getRecentSessionFiles(projectPath, Infinity);
  return all.length > 0 ? all[0] : null;
}

/**
 * Get all .jsonl session files modified within maxAgeMs, sorted newest-first.
 * Pass Infinity for maxAgeMs to get all files regardless of age.
 */
export function getRecentSessionFiles(projectPath: string, maxAgeMs: number): Array<{
  filePath: string;
  mtimeMs: number;
  sessionId: string;
}> {
  try {
    const sessionDir = getSessionDir(projectPath);
    if (!fs.existsSync(sessionDir)) return [];

    const now = Date.now();
    const results: Array<{ filePath: string; mtimeMs: number; sessionId: string }> = [];
    const files = fs.readdirSync(sessionDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fullPath = path.join(sessionDir, f);
      try {
        const stat = fs.statSync(fullPath);
        if (maxAgeMs === Infinity || (now - stat.mtimeMs) <= maxAgeMs) {
          results.push({
            filePath: fullPath,
            mtimeMs: stat.mtimeMs,
            sessionId: path.basename(f, '.jsonl'),
          });
        }
      } catch { /* skip unreadable files */ }
    }
    // Sort newest first
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results;
  } catch {
    return [];
  }
}
