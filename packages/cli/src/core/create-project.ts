/**
 * Project creation and registration — the "stand up a new project end-to-end"
 * capability requested in NEEDED-UPGRADES.md.
 *
 * Two operations, both safe to call from the MCP server (no TUI/Ink):
 * - rescanProjects(): re-run the filesystem scan + index merge that the TUI's
 *   `S` key performs, so freshly-created folders become discoverable.
 * - createProject(): create the folder, seed CLAUDE.md from supplied context,
 *   `git init`, register in config.json (the authoritative source), and refresh
 *   the index — all in one call, leaving the project ready for launch_session.
 *
 * The authoritative project list is the `projects` array in config.json plus
 * scanner.ts discovery; project-index.json / project-names.json are caches.
 * So registration is done through saveConfig() (pinned project), and the index
 * is updated only as an optimization so the project shows up before any scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, saveConfig } from '../config.js';
import { isCommandAvailable, normalizePathForCompare, pathIsSafe } from './platform.js';
import { buildProjectList, extractProjectName, getProjectSlug } from './projects.js';
import { mergeIntoIndex } from './project-index.js';
import { scanForProjects } from './scanner.js';
import { log } from './logger.js';

// ── Rescan ───────────────────────────────────────────────────

export interface RescanResult {
  /** Number of project roots found by the filesystem scan. */
  scanned: number;
  /** Total projects known after the scan (config + discovered + indexed). */
  total: number;
  /** Projects that are newly known compared to before the scan. */
  newProjects: Array<{ name: string; path: string }>;
}

/**
 * Re-run filesystem discovery and merge results into the project index,
 * mirroring the TUI `S`-key scan. Returns what became newly known so callers
 * can report it. Synchronous (BFS scan) — fine for an occasional tool call.
 */
export function rescanProjects(opts: { roots?: string[]; maxDepth?: number } = {}): RescanResult {
  const { config } = loadConfig();

  const before = buildProjectList(config);
  const beforePaths = new Set(before.map((p) => normalizePathForCompare(p.path)));

  const results = scanForProjects({ roots: opts.roots, maxDepth: opts.maxDepth });
  mergeIntoIndex(results); // invalidates the index cache so buildProjectList sees fresh entries

  const after = buildProjectList(config);
  const newProjects = after
    .filter((p) => !beforePaths.has(normalizePathForCompare(p.path)))
    .map((p) => ({ name: p.name, path: p.path }));

  return { scanned: results.length, total: after.length, newProjects };
}

// ── Create ───────────────────────────────────────────────────

export interface CreateProjectOptions {
  /** Absolute path where the project should live. Created if missing. */
  path: string;
  /** Display name. Defaults to metadata-derived name or the folder basename. */
  name?: string;
  /** Seed content for CLAUDE.md (background + starter instructions). */
  context?: string;
}

export interface CreateProjectResult {
  success: boolean;
  message: string;
  project?: { name: string; path: string; slug: string };
  steps: {
    folderCreated: boolean;
    claudeMdSeeded: boolean;
    gitInitialized: boolean;
    registered: boolean;
  };
}

/** Build a starter CLAUDE.md body from the supplied context. */
function buildStarterClaudeMd(name: string, context?: string): string {
  const lines = [`# ${name}`, ''];
  if (context && context.trim()) {
    lines.push(context.trim(), '');
  } else {
    lines.push('_Project created via cldctrl. Add background and instructions here._', '');
  }
  return lines.join('\n');
}

/**
 * Create and register a new project in one shot. Idempotent: re-running against
 * an existing folder/registered project succeeds without clobbering CLAUDE.md or
 * re-initializing git. Returns the project ready for launch_session.
 */
export function createProject(opts: CreateProjectOptions): CreateProjectResult {
  const steps = {
    folderCreated: false,
    claudeMdSeeded: false,
    gitInitialized: false,
    registered: false,
  };

  const rawPath = (opts.path || '').trim();
  if (!rawPath) {
    return { success: false, message: 'A target path is required.', steps };
  }
  if (!pathIsSafe(rawPath)) {
    return { success: false, message: `Unsafe project path: ${rawPath}`, steps };
  }

  const projectPath = path.resolve(rawPath);

  // 1. Create the folder (recursive) if missing; reject non-directories.
  try {
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
      steps.folderCreated = true;
    } else if (!fs.statSync(projectPath).isDirectory()) {
      return {
        success: false,
        message: `Path exists but is not a directory: ${projectPath}`,
        steps,
      };
    }
  } catch (err) {
    return { success: false, message: `Failed to create folder: ${err}`, steps };
  }

  const name = (opts.name && opts.name.trim()) || safeExtractName(projectPath);

  // 2. Seed CLAUDE.md (a PROJECT_INDICATOR) — only if absent, never overwrite.
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    try {
      fs.writeFileSync(claudeMdPath, buildStarterClaudeMd(name, opts.context));
      steps.claudeMdSeeded = true;
    } catch (err) {
      log('error', { function: 'createProject.claudeMd', message: String(err) });
    }
  }

  // 3. git init (best-effort) — also a PROJECT_INDICATOR.
  if (!fs.existsSync(path.join(projectPath, '.git'))) {
    if (isCommandAvailable('git')) {
      try {
        execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore', timeout: 10000 });
        steps.gitInitialized = true;
      } catch (err) {
        log('error', { function: 'createProject.gitInit', message: String(err) });
      }
    }
  }

  // 4. Register in config.json — the authoritative project source.
  try {
    const { config } = loadConfig();
    const key = normalizePathForCompare(projectPath);
    const already = config.projects.some((p) => normalizePathForCompare(p.path) === key);
    if (!already) {
      config.projects.push({ name, path: projectPath });
      saveConfig(config);
    }
    steps.registered = true;
  } catch (err) {
    return {
      success: false,
      message: `Created project files but failed to register in config: ${err}`,
      project: { name, path: projectPath, slug: getProjectSlug(projectPath) },
      steps,
    };
  }

  // 5. Refresh the index cache so the project is known immediately, without
  //    waiting for a full scan. The index is a cache; config already registered it.
  try {
    const indicators: string[] = [];
    const hasClaude = fs.existsSync(claudeMdPath);
    const hasGit = fs.existsSync(path.join(projectPath, '.git'));
    if (hasClaude) indicators.push('CLAUDE.md');
    if (hasGit) indicators.push('.git');
    mergeIntoIndex([
      {
        path: projectPath,
        name: path.basename(projectPath),
        indicators,
        hasClaude,
        hasGit,
      },
    ]);
  } catch {
    /* index is only a cache — config registration is what matters */
  }

  return {
    success: true,
    message: `Project "${name}" is ready at ${projectPath}.`,
    project: { name, path: projectPath, slug: getProjectSlug(projectPath) },
    steps,
  };
}

function safeExtractName(projectPath: string): string {
  try {
    return extractProjectName(projectPath);
  } catch {
    return path.basename(projectPath);
  }
}

// ── Add (register existing) or create ───────────────────────

/**
 * TUI/agent "Add project" entry point. If the folder already exists, register
 * it as-is (no CLAUDE.md/git seeding — we don't touch an existing project's
 * files). If it doesn't exist, fall through to createProject() which scaffolds
 * it. Either way the project ends up registered in config and ready to launch.
 */
export function addOrCreateProject(rawPath: string): CreateProjectResult {
  const steps = {
    folderCreated: false,
    claudeMdSeeded: false,
    gitInitialized: false,
    registered: false,
  };

  const trimmed = (rawPath || '').trim();
  if (!trimmed) {
    return { success: false, message: 'A path is required.', steps };
  }
  if (!pathIsSafe(trimmed)) {
    return { success: false, message: `Unsafe path: ${trimmed}`, steps };
  }

  const projectPath = path.resolve(trimmed);

  let exists = false;
  try {
    exists = fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory();
  } catch {
    exists = false;
  }

  // Non-existent (or not a dir): scaffold a fresh project.
  if (!exists) {
    if (fs.existsSync(projectPath)) {
      return { success: false, message: `Path exists but is not a directory: ${projectPath}`, steps };
    }
    return createProject({ path: projectPath });
  }

  // Existing folder: register only, leave its files untouched.
  const name = safeExtractName(projectPath);
  try {
    const { config } = loadConfig();
    const key = normalizePathForCompare(projectPath);
    const already = config.projects.some((p) => normalizePathForCompare(p.path) === key);
    const wasHidden = config.hidden_projects.some((p) => normalizePathForCompare(p) === key);
    if (wasHidden) {
      config.hidden_projects = config.hidden_projects.filter(
        (p) => normalizePathForCompare(p) !== key,
      );
    }
    if (!already) config.projects.push({ name, path: projectPath });
    if (!already || wasHidden) saveConfig(config);
    steps.registered = true;
  } catch (err) {
    return { success: false, message: `Failed to register: ${err}`, steps };
  }

  // Refresh the index cache so it shows up immediately.
  try {
    const indicators: string[] = [];
    const hasClaude = fs.existsSync(path.join(projectPath, 'CLAUDE.md'));
    const hasGit = fs.existsSync(path.join(projectPath, '.git'));
    if (hasClaude) indicators.push('CLAUDE.md');
    if (hasGit) indicators.push('.git');
    mergeIntoIndex([{ path: projectPath, name: path.basename(projectPath), indicators, hasClaude, hasGit }]);
  } catch { /* cache only */ }

  return {
    success: true,
    message: `Added "${name}".`,
    project: { name, path: projectPath, slug: getProjectSlug(projectPath) },
    steps,
  };
}

// ── Hide / unhide (noise management) ─────────────────────────

export interface HiddenChangeResult {
  success: boolean;
  message: string;
  /** The full hidden_projects list after the change. */
  hidden: string[];
}

/**
 * Hide a project path from every view by adding it to config.hidden_projects.
 * hidden_projects is honored across all list sources (config/discovered/indexed)
 * and survives rescans, so this is the durable way to silence noise — whether
 * the entry came from a scan, a Claude session, or an explicit registration.
 */
export function hideProjectPath(projectPath: string): HiddenChangeResult {
  const raw = (projectPath || '').trim();
  if (!raw) {
    return { success: false, message: 'A project path is required.', hidden: [] };
  }

  const resolved = path.resolve(raw);
  const { config } = loadConfig();
  const key = normalizePathForCompare(resolved);
  const already = config.hidden_projects.some((p) => normalizePathForCompare(p) === key);

  if (!already) {
    config.hidden_projects.push(resolved);
    saveConfig(config);
  }

  return {
    success: true,
    message: already ? `Already hidden: ${resolved}` : `Hidden: ${resolved}`,
    hidden: config.hidden_projects,
  };
}

/**
 * Unhide a project. Accepts a full path (matched exactly) or, when the
 * identifier has no path separator, a folder basename (matches any hidden
 * entry with that basename).
 */
export function unhideProjectPath(identifier: string): HiddenChangeResult {
  const raw = (identifier || '').trim();
  if (!raw) {
    const { config } = loadConfig();
    return { success: false, message: 'A project path or name is required.', hidden: config.hidden_projects };
  }

  const { config } = loadConfig();
  const looksLikePath = raw.includes('/') || raw.includes('\\');
  const resolvedKey = normalizePathForCompare(path.resolve(raw));
  const rawKey = normalizePathForCompare(raw);
  const baseLower = path.basename(raw).toLowerCase();

  const before = config.hidden_projects.length;
  config.hidden_projects = config.hidden_projects.filter((p) => {
    if (looksLikePath) {
      const k = normalizePathForCompare(p);
      return k !== resolvedKey && k !== rawKey;
    }
    return path.basename(p).toLowerCase() !== baseLower;
  });

  const removed = before - config.hidden_projects.length;
  if (removed > 0) saveConfig(config);

  return {
    success: removed > 0,
    message: removed > 0 ? `Unhidden ${removed} project(s).` : `No hidden project matched: ${raw}`,
    hidden: config.hidden_projects,
  };
}

/** The current hidden_projects list (paths). */
export function listHiddenProjects(): string[] {
  const { config } = loadConfig();
  return config.hidden_projects;
}
