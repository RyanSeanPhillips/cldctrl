/**
 * Git status via execFile (array args, NO shell).
 * Uses cross-spawn for Windows .cmd shim compatibility.
 */

import spawn from 'cross-spawn';
import { log } from './logger.js';
import type { GitStatus, GitCommit, DailyUsage } from '../types.js';

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
    const [branchResult, statusResult, revListResult] = await Promise.allSettled([
      runGit(['-C', projectPath, 'symbolic-ref', '--short', 'HEAD'], projectPath),
      runGit(['-C', projectPath, 'status', '--porcelain'], projectPath),
      runGit(['-C', projectPath, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], projectPath),
    ]);

    // Branch
    let branch = '';
    if (branchResult.status === 'fulfilled') {
      branch = branchResult.value.trim();
    } else {
      // Detached HEAD fallback
      try {
        const hash = await runGit(['-C', projectPath, 'rev-parse', '--short', 'HEAD'], projectPath);
        branch = hash.trim();
      } catch {
        return null; // Not a git repo
      }
    }

    // Dirty count
    let dirty = 0;
    if (statusResult.status === 'fulfilled') {
      dirty = statusResult.value.trim().split('\n').filter((l) => l.trim()).length;
    }

    // Ahead/behind
    let ahead = 0;
    let behind = 0;
    if (revListResult.status === 'fulfilled') {
      const parts = revListResult.value.trim().split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }

    return { branch, dirty, ahead, behind, available: true };
  } catch (err) {
    log('error', { function: 'getGitStatus', message: String(err) });
    return null;
  }
}

/**
 * Get recent commits for a project.
 */
export async function getRecentCommits(projectPath: string, count: number = 10): Promise<GitCommit[]> {
  try {
    const output = await runGit(
      ['-C', projectPath, 'log', `-${count}`, '--format=%H%x00%s%x00%aI', '--shortstat'],
      projectPath
    );

    const commits: GitCommit[] = [];
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Format line: hash\0subject\0date
      const parts = line.split('\0');
      if (parts.length === 3 && parts[0].length >= 7) {
        const commit: GitCommit = {
          hash: parts[0],
          subject: parts[1],
          date: parts[2],
          additions: 0,
          deletions: 0,
        };

        // Find shortstat line — skip blank lines between format and shortstat
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const statLine = lines[j].trim();
          if (!statLine) continue; // skip blank lines
          if (statLine.includes('insertion') || statLine.includes('deletion')) {
            const addMatch = statLine.match(/(\d+) insertion/);
            const delMatch = statLine.match(/(\d+) deletion/);
            if (addMatch) commit.additions = parseInt(addMatch[1], 10);
            if (delMatch) commit.deletions = parseInt(delMatch[1], 10);
            i = j; // skip past shortstat line
          }
          break; // stop after first non-blank line (whether shortstat or next commit)
        }

        commits.push(commit);
      }
    }

    return commits;
  } catch (err) {
    log('error', { function: 'getRecentCommits', message: String(err) });
    return [];
  }
}

/**
 * Get commit daily activity for heatmap display.
 */
export async function getCommitDailyActivity(projectPath: string, days: number = 28): Promise<DailyUsage[]> {
  try {
    const output = await runGit(
      ['-C', projectPath, 'log', `--since=${days} days ago`, '--format=%aI', '--shortstat'],
      projectPath
    );

    const dailyMap = new Map<string, { commits: number; additions: number; deletions: number }>();
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;

      // Date line: 2025-03-09T14:30:00-05:00
      if (trimmed.length >= 10 && trimmed[4] === '-' && trimmed[7] === '-') {
        const dateStr = trimmed.slice(0, 10);
        const entry = dailyMap.get(dateStr) ?? { commits: 0, additions: 0, deletions: 0 };
        entry.commits++;

        // Next non-blank line might be shortstat
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const stat = lines[j].trim();
          if (!stat) continue;
          if (stat.includes('insertion') || stat.includes('deletion')) {
            const addMatch = stat.match(/(\d+) insertion/);
            const delMatch = stat.match(/(\d+) deletion/);
            if (addMatch) entry.additions += parseInt(addMatch[1], 10);
            if (delMatch) entry.deletions += parseInt(delMatch[1], 10);
            i = j;
          }
          break;
        }

        dailyMap.set(dateStr, entry);
      }
    }

    return Array.from(dailyMap.entries())
      .map(([date, d]) => ({
        date, tokens: 0, messages: 0,
        commits: d.commits, additions: d.additions, deletions: d.deletions,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    log('error', { function: 'getCommitDailyActivity', message: String(err) });
    return [];
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
