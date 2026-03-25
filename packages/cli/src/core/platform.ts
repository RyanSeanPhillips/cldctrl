/**
 * OS detection, command availability, path safety, terminal detection.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import spawn from 'cross-spawn';

let _safeMode = false;
export function setSafeMode(v: boolean) { _safeMode = v; }
export function isSafeMode(): boolean { return _safeMode; }

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
 * Copy text to the system clipboard. Cross-platform.
 */
export function copyToClipboard(text: string): boolean {
  try {
    switch (getPlatform()) {
      case 'windows':
        execFileSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
        return true;
      case 'macos':
        execFileSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
        return true;
      default:
        execFileSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
        return true;
    }
  } catch { return false; }
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
 * Focus a terminal window by title substring. Cross-platform.
 * Returns true if a window was found and focused.
 */
export function focusWindowByTitle(title: string): boolean {
  const platform = getPlatform();
  try {
    switch (platform) {
      case 'windows':
        // PowerShell: find window by title and bring to front
        execFileSync('powershell', ['-NoProfile', '-Command', `
          Add-Type @"
          using System; using System.Runtime.InteropServices;
          public class WinFocus {
            [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
            delegate bool EnumProc(IntPtr h, IntPtr l);
            [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
            [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
            [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
            public static IntPtr Find(string title) {
              IntPtr found = IntPtr.Zero;
              EnumWindows((h, l) => {
                if (!IsWindowVisible(h)) return true;
                var sb = new System.Text.StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString().Contains(title)) { found = h; return false; }
                return true;
              }, IntPtr.Zero);
              return found;
            }
          }
"@
          $h = [WinFocus]::Find("${title}")
          if ($h -ne [IntPtr]::Zero) { [WinFocus]::ShowWindow($h, 9); [WinFocus]::SetForegroundWindow($h); exit 0 }
          exit 1
        `], { stdio: 'pipe', timeout: 3000 });
        return true;

      case 'macos':
        // AppleScript: search Terminal and iTerm2
        execFileSync('osascript', ['-e', `
          tell application "System Events"
            set allProcs to every process whose visible is true
            repeat with p in allProcs
              try
                set wins to every window of p
                repeat with w in wins
                  if name of w contains "${title}" then
                    set frontmost of p to true
                    perform action "AXRaise" of w
                    return
                  end if
                end repeat
              end try
            end repeat
          end tell
        `], { stdio: 'pipe', timeout: 3000 });
        return true;

      case 'linux':
        // Try wmctrl first, then xdotool
        try {
          execFileSync('wmctrl', ['-a', title], { stdio: 'pipe', timeout: 2000 });
          return true;
        } catch {
          try {
            const wid = execFileSync('xdotool', ['search', '--name', title], { stdio: 'pipe', timeout: 2000 }).toString().trim().split('\n')[0];
            if (wid) {
              execFileSync('xdotool', ['windowactivate', wid], { stdio: 'pipe', timeout: 2000 });
              return true;
            }
          } catch { /* fallthrough */ }
        }
        return false;
    }
  } catch {
    return false;
  }
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
