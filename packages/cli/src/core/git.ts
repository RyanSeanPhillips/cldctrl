/**
 * Git status via execFile (array args, NO shell).
 * Uses cross-spawn for Windows .cmd shim compatibility.
 */

import spawn from 'cross-spawn';
import { log } from './logger.js';
import type { GitStatus } from '../types.js';

/**
 * Run a git command and return stdout.
 * Always uses array args — never shell: true.
 */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`));
    });

    // 10s timeout
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out`));
    }, 10_000);
  });
}

/**
 * Get git status for a project directory.
 * Returns null if git is not available or directory is not a repo.
 */
export async function getGitStatus(projectPath: string): Promise<GitStatus | null> {
  try {
    // Get branch name
    let branch = '';
    try {
      const ref = await runGit(
        ['-C', projectPath, 'symbolic-ref', '--short', 'HEAD'],
        projectPath
      );
      branch = ref.trim();
    } catch {
      // Detached HEAD or not a repo
      try {
        const hash = await runGit(
          ['-C', projectPath, 'rev-parse', '--short', 'HEAD'],
          projectPath
        );
        branch = hash.trim();
      } catch {
        return null; // Not a git repo
      }
    }

    // Get porcelain status (dirty file count)
    let dirty = 0;
    try {
      const status = await runGit(
        ['-C', projectPath, 'status', '--porcelain'],
        projectPath
      );
      dirty = status.trim().split('\n').filter((l) => l.trim()).length;
    } catch { /* ignore */ }

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const revList = await runGit(
        ['-C', projectPath, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        projectPath
      );
      const parts = revList.trim().split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // No upstream configured — that's fine
    }

    return { branch, dirty, ahead, behind, available: true };
  } catch (err) {
    log('error', { function: 'getGitStatus', message: String(err) });
    return null;
  }
}

/**
 * Format git status for display.
 */
export function formatGitStatus(status: GitStatus | null | undefined): string {
  if (!status) return '[no git]';

  let display = status.branch;
  if (status.dirty > 0) display += ` ●${status.dirty}`;
  else display += ' ✓';
  if (status.ahead > 0) display += ` ↑${status.ahead}`;
  if (status.behind > 0) display += ` ↓${status.behind}`;
  return display;
}
