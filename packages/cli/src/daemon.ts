/**
 * Standalone daemon process: polls git/issues/stats, writes cache.json,
 * sends desktop notifications for new GitHub issues.
 * No Ink/TUI — lightweight Node.js process.
 */

import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { loadConfig, getConfigDir } from './config.js';
import { buildProjectList } from './core/projects.js';
import { getGitStatus } from './core/git.js';
import { getIssues, isGhAvailable } from './core/github.js';
import { getDailyUsageStats } from './core/sessions.js';
import { loadSeenIssues, markIssueSeen, isIssueSeen, writeDaemonCache } from './core/background.js';
import { getClaudeProjectsDir } from './core/platform.js';
import { initLogger, log } from './core/logger.js';
import { sanitizeIssueTitle } from './core/github.js';
import { DEFAULTS } from './constants.js';
import type { DaemonCache, GitStatus, Issue } from './types.js';

const limit = pLimit(DEFAULTS.concurrencyLimit);

// ── PID file for single-instance guard ──────────────────────

function getPidPath(): string {
  return path.join(getConfigDir(), 'daemon.pid');
}

function writePidFile(): void {
  const pidPath = getPidPath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
}

function checkExistingDaemon(): boolean {
  const pidPath = getPidPath();
  try {
    if (!fs.existsSync(pidPath)) return false;
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;

    // Check if process is still running
    try {
      process.kill(pid, 0); // Signal 0 = check existence
      return true; // Process exists
    } catch {
      return false; // Process doesn't exist
    }
  } catch {
    return false;
  }
}

function cleanupPidFile(): void {
  try {
    fs.unlinkSync(getPidPath());
  } catch { /* ignore */ }
}

// ── Notification ────────────────────────────────────────────

async function sendNotification(title: string, message: string): Promise<void> {
  try {
    const notifier = await import('node-notifier');
    notifier.default.notify({
      title,
      message,
      sound: true,
    });
  } catch (err) {
    log('notification_error', { message: String(err) });
  }
}

// ── Polling loop ────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const { config } = loadConfig();
  const projects = buildProjectList(config);

  const gitStatuses: Record<string, GitStatus> = {};
  const allIssues: Record<string, Issue[]> = {};

  // Fetch git status (with concurrency limit)
  const gitResults = await Promise.allSettled(
    projects.map((p) =>
      limit(async () => {
        const status = await getGitStatus(p.path);
        return { path: p.path, status };
      })
    )
  );

  for (const result of gitResults) {
    if (result.status === 'fulfilled' && result.value.status) {
      gitStatuses[result.value.path] = result.value.status;
    }
  }

  // Fetch issues (if gh available)
  if (isGhAvailable() && config.notifications.github_issues.enabled) {
    loadSeenIssues();

    const issueResults = await Promise.allSettled(
      projects.slice(0, 10).map((p) =>
        limit(async () => {
          const issues = await getIssues(p.path);
          return { path: p.path, name: p.name, issues };
        })
      )
    );

    for (const result of issueResults) {
      if (result.status !== 'fulfilled') continue;
      const { path: projPath, name, issues } = result.value;
      if (issues.length > 0) {
        allIssues[projPath] = issues;

        // Check for new issues and send notifications
        for (const issue of issues) {
          if (!isIssueSeen(projPath, issue.number)) {
            markIssueSeen(projPath, issue.number);
            const safeTitle = sanitizeIssueTitle(issue.title);
            await sendNotification(
              `New issue in ${name}`,
              `#${issue.number}: ${safeTitle}`
            );
          }
        }
      }
    }
  }

  // Fetch usage stats
  const usageStats = await getDailyUsageStats(getClaudeProjectsDir());

  // Write cache
  const cache: DaemonCache = {
    lastUpdated: new Date().toISOString(),
    gitStatuses,
    issues: allIssues,
    usageStats,
  };
  writeDaemonCache(cache as unknown as Record<string, unknown>);

  log('daemon_poll', {
    projects: projects.length,
    gitStatuses: Object.keys(gitStatuses).length,
    issues: Object.keys(allIssues).length,
  });
}

// ── Main ────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  initLogger({ verbose: process.argv.includes('--verbose') });

  if (checkExistingDaemon()) {
    console.error('Daemon is already running. Kill the existing process first.');
    process.exit(1);
  }

  writePidFile();
  log('daemon_start', { pid: process.pid });
  console.log(`CLD CTRL daemon started (pid ${process.pid})`);

  // Cleanup on exit
  process.on('SIGINT', () => { cleanupPidFile(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupPidFile(); process.exit(0); });
  process.on('exit', cleanupPidFile);

  // Immediate first poll
  try {
    await pollOnce();
  } catch (err) {
    log('daemon_error', { message: String(err) });
  }

  // Self-scheduling polling loop (re-reads interval from config each cycle)
  const scheduleNext = () => {
    const { config } = loadConfig();
    const intervalMs = (config.notifications.github_issues.poll_interval_minutes ?? 5) * 60 * 1000;

    setTimeout(async () => {
      try {
        await pollOnce();
      } catch (err) {
        log('daemon_error', { message: String(err) });
      }
      scheduleNext();
    }, intervalMs);
  };

  scheduleNext();
}
