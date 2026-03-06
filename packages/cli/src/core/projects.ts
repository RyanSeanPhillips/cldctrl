/**
 * Project slug generation, discovery from ~/.claude/projects, list building.
 * CRITICAL: slug uses global regex to match PowerShell .Replace() behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getClaudeProjectsDir } from './platform.js';
import { log } from './logger.js';
import { readProjectNameCache, writeProjectNameCache } from './project-cache.js';
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
 */
function getProjectPathFromSlug(slugDir: string): string | null {
  try {
    const files = fs.readdirSync(slugDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first by name

    if (files.length === 0) return null;

    // Read first ~20 lines to find cwd
    const filePath = path.join(slugDir, files[0]);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, 20);

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
        // Check for nested message content with cwd
        if (parsed.message?.cwd) return parsed.message.cwd;
      } catch { /* skip unparseable lines */ }
    }

    return null;
  } catch {
    return null;
  }
}

// ── List building ───────────────────────────────────────────

/**
 * Build the unified project list: pinned first, then discovered.
 * Deduplicates by path (case-insensitive on Windows).
 */
export function buildProjectList(config: Config): Project[] {
  const projects: Project[] = [];
  const seenPaths = new Set<string>();
  const hiddenSet = new Set(config.hidden_projects.map((p) => p.toLowerCase()));
  const nameCache: Record<string, string> = {};

  // Add configured (pinned) projects
  for (const p of config.projects) {
    const key = p.path.toLowerCase();
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

  // Add discovered projects (not already in config)
  const discovered = discoverProjects();
  discovered.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  for (const d of discovered) {
    const key = d.path.toLowerCase();
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
  const hiddenSet = new Set(config.hidden_projects.map((p) => p.toLowerCase()));
  let cacheUpdated = false;

  // Add configured (pinned) projects
  for (const p of config.projects) {
    const key = p.path.toLowerCase();
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

  // Add discovered projects using cached names
  const discovered = discoverProjectsFast(nameCache);
  discovered.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  for (const d of discovered) {
    const key = d.path.toLowerCase();
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
