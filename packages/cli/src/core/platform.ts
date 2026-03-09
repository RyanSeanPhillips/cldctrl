/**
 * OS detection, command availability, path safety, terminal detection.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import spawn from 'cross-spawn';

export type Platform = 'windows' | 'macos' | 'linux';

export function getPlatform(): Platform {
  switch (os.platform()) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    default: return 'linux';
  }
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getClaudeProjectsDir(): string {
  return path.join(getHomeDir(), '.claude', 'projects');
}

/**
 * Check if a command is available on PATH.
 * Results are cached for the lifetime of the process.
 */
const cmdCache = new Map<string, boolean>();

export function isCommandAvailable(cmd: string): boolean {
  const cached = cmdCache.get(cmd);
  if (cached !== undefined) return cached;

  let available: boolean;
  try {
    const which = getPlatform() === 'windows' ? 'where' : 'which';
    execFileSync(which, [cmd], { stdio: 'pipe' });
    available = true;
  } catch {
    available = false;
  }
  cmdCache.set(cmd, available);
  return available;
}

/**
 * Validate a path is safe — no traversal, no dangerous shell metacharacters.
 * Only rejects characters that could cause command injection.
 * Allows #, ', and other chars that are valid in filenames.
 */
export function pathIsSafe(p: string): boolean {
  if (!p || typeof p !== 'string') return false;

  // Reject path traversal
  if (p.includes('..')) return false;

  // Reject newlines (can bypass shell escaping)
  if (p.includes('\n') || p.includes('\r')) return false;

  // Only reject characters that enable shell injection
  // (semicolon, pipe, backtick, dollar, angle brackets, parens)
  const dangerousChars = /[;&|`$><(){}]/;
  // On Windows, strip backslashes before testing (they're path separators)
  const testPath = getPlatform() === 'windows' ? p.replace(/\\/g, '') : p;
  if (dangerousChars.test(testPath)) return false;

  return true;
}

/**
 * Normalize a path for case-insensitive comparison.
 * Windows and macOS (default) are case-insensitive; Linux is case-sensitive.
 */
export function normalizePathForCompare(p: string): string {
  const platform = getPlatform();
  // Windows and macOS default to case-insensitive filesystems
  if (platform === 'windows' || platform === 'macos') {
    return p.toLowerCase();
  }
  return p;
}

/**
 * Check if running inside tmux.
 */
export function isInTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Check if stdout is a TTY (interactive terminal).
 */
export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Detect terminal for color capability warnings.
 */
export function getTerminalInfo(): { supportsAnsi: boolean; name: string } {
  const term = process.env.TERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';

  if (termProgram) {
    return { supportsAnsi: true, name: termProgram };
  }

  if (getPlatform() === 'windows' && !term && !process.env.WT_SESSION) {
    return { supportsAnsi: false, name: 'cmd.exe' };
  }

  return { supportsAnsi: true, name: term || 'unknown' };
}

/**
 * Open a path in the system file explorer.
 */
export function openInExplorer(dirPath: string): boolean {
  const platform = getPlatform();
  const resolved = path.resolve(dirPath);

  if (!fs.existsSync(resolved)) return false;

  switch (platform) {
    case 'windows':
      spawn.spawn('explorer', [resolved], { detached: true, stdio: 'ignore' }).unref();
      break;
    case 'macos':
      spawn.spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
      break;
    case 'linux':
      spawn.spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref();
      break;
  }
  return true;
}

/**
 * Detect available terminal emulator on Linux.
 */
export function detectLinuxTerminal(): string | null {
  const candidates = [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'kitty',
    'alacritty',
    'wezterm',
    'foot',
    'xfce4-terminal',
    'xterm',
  ];
  for (const cmd of candidates) {
    if (isCommandAvailable(cmd)) return cmd;
  }
  return null;
}

/**
 * Check if config directory has safe permissions (Unix only).
 * Warns if world-writable.
 */
export function checkConfigDirPermissions(dirPath: string): { safe: boolean; warning?: string } {
  if (getPlatform() === 'windows') return { safe: true };

  try {
    const stat = fs.statSync(dirPath);
    const mode = stat.mode & 0o777;
    if (mode & 0o002) {
      return {
        safe: false,
        warning: `Config directory ${dirPath} is world-writable (mode ${mode.toString(8)}). Run: chmod 700 "${dirPath}"`,
      };
    }
    return { safe: true };
  } catch {
    return { safe: true };
  }
}
