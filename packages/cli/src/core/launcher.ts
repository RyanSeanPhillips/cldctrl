/**
 * Cross-platform terminal spawning for launching Claude Code.
 * Security: clears CLAUDE* env vars, validates all inputs before shell use,
 * uses temporary script files instead of string interpolation where possible.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import spawn from 'cross-spawn';
import { getPlatform, isCommandAvailable, isInTmux, detectLinuxTerminal, pathIsSafe } from './platform.js';
import { trackSession } from './tracker.js';
import { log } from './logger.js';

// ── Input validation ────────────────────────────────────────

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id) && id.length <= 200;
}

/**
 * Validate all launch inputs before any shell interaction.
 */
function validateLaunchInputs(opts: LaunchOptions): string | null {
  if (!pathIsSafe(opts.projectPath)) {
    return `Unsafe project path: ${opts.projectPath}`;
  }
  if (opts.sessionId && !validateSessionId(opts.sessionId)) {
    return `Invalid session ID: must be alphanumeric/dash/underscore`;
  }
  return null; // valid
}

// ── Clean environment ───────────────────────────────────────

/**
 * Build a clean environment that clears CLAUDE* vars to avoid nesting detection.
 * Preserves CLAUDE_CODE_GIT_BASH_PATH (needed for git-bash on Windows).
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    // Case-insensitive check for Windows compatibility
    if (key.toUpperCase().startsWith('CLAUDE') && key !== 'CLAUDE_CODE_GIT_BASH_PATH') {
      delete env[key];
    }
  }
  return env;
}

// ── Claude args ─────────────────────────────────────────────

function buildClaudeArgs(opts: {
  sessionId?: string;
  isNew?: boolean;
  prompt?: string;
}): string[] {
  const args: string[] = [];

  if (opts.isNew) {
    // No --continue flag = new session
  } else if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--continue');
  }

  if (opts.prompt) {
    args.push('--prompt', opts.prompt);
  }

  return args;
}

// ── Temp script approach (avoids shell string interpolation) ─

/**
 * Write a temporary shell script and return its path.
 * This avoids shell string interpolation entirely.
 */
/**
 * Escape a string for safe use as a batch file argument.
 * Wraps in double quotes. Inside quotes, batch still interprets
 * %, !, and " — so we escape those specifically.
 */
function escapeBatArg(arg: string): string {
  const escaped = arg
    .replace(/%/g, '%%')   // percent must be doubled (caret doesn't work)
    .replace(/"/g, '""')   // double quotes doubled inside quoted string
    .replace(/!/g, '^^!'); // exclamation (delayed expansion) needs ^^
  return `"${escaped}"`;
}

function writeTempScript(projectPath: string, claudeArgs: string[]): string {
  const platform = getPlatform();
  const tmpDir = os.tmpdir();

  if (platform === 'windows') {
    const scriptPath = path.join(tmpDir, `cldctrl-launch-${process.pid}.bat`);
    const lines = [
      '@echo off',
      `cd /d ${escapeBatArg(projectPath)}`,
      `claude ${claudeArgs.map(escapeBatArg).join(' ')}`,
    ];
    fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n');
    return scriptPath;
  } else {
    const scriptPath = path.join(tmpDir, `cldctrl-launch-${process.pid}.sh`);
    const lines = [
      '#!/bin/sh',
      `cd '${projectPath.replace(/'/g, "'\\''")}'`,
      // Shell-escape each arg properly
      `exec claude ${claudeArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
    ];
    fs.writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o755 });
    return scriptPath;
  }
}

function cleanupTempScript(scriptPath: string): void {
  // Delay cleanup to give the terminal time to read the script
  setTimeout(() => {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }, 5000);
}

// ── Public API ──────────────────────────────────────────────

export interface LaunchOptions {
  projectPath: string;
  sessionId?: string;
  isNew?: boolean;
  prompt?: string;
}

export interface LaunchResult {
  success: boolean;
  message: string;
  pid?: number;
}

/**
 * Launch Claude Code in a new terminal window.
 * Security: validates all inputs, uses temp scripts instead of shell interpolation.
 */
export function launchClaude(opts: LaunchOptions): LaunchResult {
  // Validate all inputs at the boundary
  const validationError = validateLaunchInputs(opts);
  if (validationError) {
    return { success: false, message: validationError };
  }

  const platform = getPlatform();
  const env = getCleanEnv();
  const claudeArgs = buildClaudeArgs(opts);

  // Check if claude is available
  if (!isCommandAvailable('claude')) {
    return {
      success: false,
      message: 'Claude Code not found. Install: https://claude.ai/download',
    };
  }

  try {
    const scriptPath = writeTempScript(opts.projectPath, claudeArgs);

    // tmux takes priority if detected
    if (isInTmux()) {
      const child = spawn.spawn('tmux', ['split-window', '-h', scriptPath], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      const pid = child.pid;
      child.unref();
      cleanupTempScript(scriptPath);

      log('launch', { method: 'tmux', path: opts.projectPath });
      return { success: true, message: 'Launched in tmux split', pid };
    }

    switch (platform) {
      case 'windows': {
        const child = spawn.spawn('cmd', ['/k', scriptPath], {
          detached: true,
          stdio: 'ignore',
          env,
        });
        const pid = child.pid;
        child.unref();
        cleanupTempScript(scriptPath);

        log('launch', { method: 'cmd', path: opts.projectPath });
        return { success: true, message: 'Launched in new cmd window', pid };
      }

      case 'macos': {
        // Use osascript to tell Terminal.app to run the script
        // (open -a Terminal --args doesn't support -e for scripts)
        const osaScript = `tell application "Terminal" to do script "${scriptPath.replace(/"/g, '\\"')}"`;
        const child = spawn.spawn('osascript', ['-e', osaScript], {
          detached: true,
          stdio: 'ignore',
          env,
        });
        const pid = child.pid;
        child.unref();
        cleanupTempScript(scriptPath);

        log('launch', { method: 'Terminal.app', path: opts.projectPath });
        return { success: true, message: 'Launched in Terminal.app', pid };
      }

      case 'linux': {
        const terminal = detectLinuxTerminal();
        if (!terminal) {
          cleanupTempScript(scriptPath);
          return {
            success: false,
            message: `No terminal emulator found. Run manually:\n  cd "${opts.projectPath}" && claude`,
          };
        }

        let termArgs: string[];
        if (terminal === 'gnome-terminal') {
          termArgs = ['--', 'bash', scriptPath];
        } else if (terminal === 'konsole') {
          termArgs = ['-e', 'bash', scriptPath];
        } else {
          termArgs = ['-e', `bash ${scriptPath}`];
        }

        const child = spawn.spawn(terminal, termArgs, {
          detached: true,
          stdio: 'ignore',
          env,
        });
        const pid = child.pid;
        child.unref();
        cleanupTempScript(scriptPath);

        log('launch', { method: terminal, path: opts.projectPath });
        return { success: true, message: `Launched in ${terminal}`, pid };
      }

      default: {
        // Exhaustive check
        const _never: never = platform;
        cleanupTempScript(scriptPath);
        return { success: false, message: `Unsupported platform: ${_never}` };
      }
    }
  } catch (err) {
    log('error', { function: 'launchClaude', message: String(err) });
    return {
      success: false,
      message: `Failed to launch: ${err}`,
    };
  }
}

/**
 * Open VS Code for a project.
 */
export function openVSCode(projectPath: string): boolean {
  try {
    spawn.spawn('code', [projectPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the prompt for fixing a GitHub issue.
 */
export function buildIssueFixPrompt(issue: { number: number; title: string }): string {
  return `Please investigate and fix GitHub issue #${issue.number}: ${issue.title}. Use gh issue view ${issue.number} to read the full details.`;
}

/**
 * Launch Claude and track the session PID.
 */
export function launchAndTrack(opts: LaunchOptions): LaunchResult {
  const result = launchClaude(opts);
  if (result.success && result.pid) {
    trackSession(result.pid, opts.projectPath);
  }
  return result;
}
