/**
 * Project slug generation, discovery from ~/.claude/projects, list building.
 * CRITICAL: slug uses global regex to match PowerShell .Replace() behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getClaudeProjectsDir } from './platform.js';
import { log } from './logger.js';
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

    // Derive a display name from the path (last directory segment)
    const name = path.basename(projectPath);

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

  // Add configured (pinned) projects
  for (const p of config.projects) {
    const key = p.path.toLowerCase();
    if (hiddenSet.has(key)) continue;
    seenPaths.add(key);

    projects.push({
      name: p.name,
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
