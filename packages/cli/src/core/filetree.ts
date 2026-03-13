/**
 * File tree utilities: lazy directory reading, gitignore parsing, file type detection.
 * Pure Node.js — no React dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { getPlatform, isCommandAvailable } from './platform.js';

// ── Types ────────────────────────────────────────────────────

export interface FileNode {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: Date;
  childCount?: number;
  isClaude?: boolean;
  fileIcon: string;
  iconColor?: string;
}

// ── Gitignore parsing ────────────────────────────────────────

/** Directories always skipped (regardless of .gitignore) */
const BUILTIN_IGNORE = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'target', 'build', 'dist', '.next', '.cache', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.npm', '.yarn', '.pnpm-store', 'vendor',
  '$RECYCLE.BIN', 'System Volume Information',
  '.Trash', '.DS_Store', 'Thumbs.db',
]);

/** Convert a gitignore glob pattern to a regex */
function gitignoreToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip trailing /
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) { re += '\\['; i++; }
      else { re += pattern.slice(i, end + 1); i = end + 1; }
    } else if ('.+^${}()|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Parse .gitignore + built-in patterns. Returns a test function.
 */
export function parseGitignore(
  projectRoot: string,
): (relativePath: string, isDirectory: boolean) => boolean {
  const rules: Array<{ regex: RegExp; nameOnly: boolean; negate: boolean; dirOnly: boolean }> = [];

  let lines: string[] = [];
  try {
    const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    lines = content.split('\n');
  } catch { /* no .gitignore */ }

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let pattern = trimmed;
    let negate = false;
    if (pattern.startsWith('!')) { negate = true; pattern = pattern.slice(1); }
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    // If pattern has no slash, it matches against basename only
    const nameOnly = !pattern.includes('/');
    if (pattern.startsWith('/')) pattern = pattern.slice(1);

    try {
      rules.push({ regex: gitignoreToRegex(pattern), nameOnly, negate, dirOnly });
    } catch { /* skip bad patterns */ }
  }

  return (relativePath: string, isDirectory: boolean): boolean => {
    const name = path.basename(relativePath);

    // Built-in always-skip
    if (BUILTIN_IGNORE.has(name)) return true;
    // Hidden files/dirs (dotfiles) except .github, .vscode, .claude
    if (name.startsWith('.') && !['', '.github', '.vscode', '.claude'].includes(name)) return true;

    let ignored = false;
    const normalized = relativePath.replace(/\\/g, '/');
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      const testStr = rule.nameOnly ? name : normalized;
      if (rule.regex.test(testStr)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}

// ── File type detection ──────────────────────────────────────

const EXT_ICONS: Record<string, [string, string?]> = {
  // Code
  '.ts': ['TS', '#3178c6'], '.tsx': ['TX', '#3178c6'], '.js': ['JS', '#f7df1e'],
  '.jsx': ['JX', '#61dafb'], '.py': ['PY', '#3776ab'], '.rs': ['RS', '#dea584'],
  '.go': ['GO', '#00add8'], '.java': ['JV', '#ed8b00'], '.c': ['C ', '#a8b9cc'],
  '.cpp': ['C+', '#00599c'], '.h': ['H ', '#a8b9cc'], '.cs': ['C#', '#239120'],
  '.rb': ['RB', '#cc342d'], '.php': ['PH', '#777bb4'], '.swift': ['SW', '#fa7343'],
  '.kt': ['KT', '#7f52ff'], '.scala': ['SC', '#dc322f'], '.r': ['R ', '#276dc3'],
  '.m': ['ML', '#e4a62e'], '.lua': ['LU', '#000080'], '.sh': ['SH', '#4eaa25'],
  '.ps1': ['PS', '#012456'], '.bat': ['BA'], '.sql': ['SQ', '#e38c00'],
  '.html': ['HT', '#e34c26'], '.css': ['CS', '#563d7c'], '.scss': ['SC', '#c6538c'],
  '.vue': ['VU', '#42b883'], '.svelte': ['SV', '#ff3e00'],
  // Config
  '.json': ['{}'], '.toml': ['TM'], '.yaml': ['YM'], '.yml': ['YM'],
  '.xml': ['XM'], '.ini': ['IN'], '.env': ['EN'],
  // Docs
  '.md': ['MD', '#083fa1'], '.txt': ['TX'], '.rst': ['RS'],
  '.pdf': ['PD', '#ee3f24'], '.doc': ['DO'], '.docx': ['DO'],
  // Data
  '.csv': ['CV'], '.tsv': ['TV'], '.parquet': ['PQ'],
  // Media
  '.png': ['IM'], '.jpg': ['IM'], '.jpeg': ['IM'], '.gif': ['IM'],
  '.svg': ['SV'], '.ico': ['IC'],
  // Build
  '.lock': ['LK'], '.log': ['LG'],
};

const NAME_ICONS: Record<string, [string, string?]> = {
  'CLAUDE.md': ['◆ ', '#e87632'],
  'package.json': ['NP', '#cb3837'],
  'tsconfig.json': ['TS', '#3178c6'],
  'pyproject.toml': ['PY', '#3776ab'],
  'Cargo.toml': ['RS', '#dea584'],
  'go.mod': ['GO', '#00add8'],
  'Dockerfile': ['DK', '#2496ed'],
  'docker-compose.yml': ['DK', '#2496ed'],
  'Makefile': ['MK'],
  '.gitignore': ['GI'],
  'LICENSE': ['LI'],
  'README.md': ['RM', '#083fa1'],
};

export function getFileIcon(name: string): { icon: string; color?: string } {
  const nameMatch = NAME_ICONS[name];
  if (nameMatch) return { icon: nameMatch[0], color: nameMatch[1] };

  const ext = path.extname(name).toLowerCase();
  const extMatch = EXT_ICONS[ext];
  if (extMatch) return { icon: extMatch[0], color: extMatch[1] };

  return { icon: '  ' };
}

// ── Directory reading ────────────────────────────────────────

/**
 * Read a single directory level (lazy). Returns sorted nodes:
 * directories first, then files, alphabetical within each group.
 */
export function readDirectory(
  dirPath: string,
  projectRoot: string,
  isIgnored: ReturnType<typeof parseGitignore>,
): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    // Skip symlinks to avoid infinite loops
    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(projectRoot, fullPath);
    const isDir = entry.isDirectory();

    if (isIgnored(relativePath, isDir)) continue;

    const { icon, color } = getFileIcon(entry.name);

    const node: FileNode = {
      name: entry.name,
      path: fullPath,
      relativePath,
      type: isDir ? 'directory' : 'file',
      isClaude: entry.name === 'CLAUDE.md',
      fileIcon: icon,
      iconColor: color,
    };

    // Get metadata for files (cheap stat)
    if (!isDir) {
      try {
        const stat = fs.statSync(fullPath);
        node.size = stat.size;
        node.modified = stat.mtime;
      } catch { /* skip */ }
    } else {
      // Count immediate children for directory display
      try {
        const children = fs.readdirSync(fullPath);
        node.childCount = children.length;
      } catch {
        node.childCount = 0;
      }
    }

    nodes.push(node);
  }

  // Sort: directories first, then alphabetical (case-insensitive)
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return nodes;
}

// ── File opening ─────────────────────────────────────────────

/**
 * Open a file in the user's editor. Tries VS Code first, falls back to platform default.
 */
export function openFileInEditor(filePath: string): boolean {
  const platform = getPlatform();

  try {
    if (isCommandAvailable('code')) {
      spawn.spawn('code', [filePath], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }

    switch (platform) {
      case 'windows':
        spawn.spawn('notepad', [filePath], { detached: true, stdio: 'ignore' }).unref();
        return true;
      case 'macos':
        spawn.spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
        return true;
      case 'linux': {
        const editor = process.env.EDITOR || process.env.VISUAL || 'xdg-open';
        spawn.spawn(editor, [filePath], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
    }
  } catch {
    return false;
  }
}

// ── File preview ─────────────────────────────────────────────

/** Read first N lines of a text file for preview. Returns null for binary/huge files. */
export function readFilePreview(filePath: string, maxLines = 20): string[] | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 200_000) return ['(file too large to preview)'];
    if (stat.size === 0) return ['(empty file)'];
  } catch {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Quick binary check: look for null bytes in first 512 chars
    if (content.slice(0, 512).includes('\0')) return ['(binary file)'];
    return content.split('\n').slice(0, maxLines);
  } catch {
    return null;
  }
}

// ── Size formatting ──────────────────────────────────────────

export function formatFileSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
