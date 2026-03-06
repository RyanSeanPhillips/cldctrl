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
import { getGitStatus, getRecentCommits, getCommitDailyActivity } from './core/git.js';
import { getIssues, isGhAvailable } from './core/github.js';
import { generateMissingSummaries, generateMissingIssueSummaries } from './core/summaries.js';
import { loadSeenIssues, markIssueSeen, isIssueSeen, writeDaemonCache } from './core/background.js';
import { initLogger, log } from './core/logger.js';
import { sanitizeIssueTitle } from './core/github.js';
import { DEFAULTS } from './constants.js';
import { getDailyUsageByProject } from './core/usage.js';
import { getRollingUsageStats } from './core/sessions.js';
import { getClaudeProjectsDir } from './core/platform.js';
import type { DaemonCache, GitStatus, Issue, GitCommit, DailyUsage } from './types.js';

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

  // Fetch recent commits and commit activity for all projects
  const recentCommits: Record<string, GitCommit[]> = {};
  const commitActivity: Record<string, DailyUsage[]> = {};

  const commitResults = await Promise.allSettled(
    projects.map((p) =>
      limit(async () => {
        const commits = await getRecentCommits(p.path, 10);
        const activity = await getCommitDailyActivity(p.path, 28);
        return { path: p.path, commits, activity };
      })
    )
  );

  for (const result of commitResults) {
    if (result.status === 'fulfilled') {
      if (result.value.commits.length > 0) {
        recentCommits[result.value.path] = result.value.commits;
      }
      if (result.value.activity.length > 0) {
        commitActivity[result.value.path] = result.value.activity;
      }
    }
  }

  // Fetch rolling 5-hour usage stats (matches Claude's rate limit window)
  const usageByProject = await getDailyUsageByProject(28);
  const usageStats = await getRollingUsageStats(getClaudeProjectsDir());

  // Generate rich session summaries for recent sessions
  for (const project of projects.slice(0, 10)) {
    try { await generateMissingSummaries(project.path); } catch {}
  }

  // Generate AI issue summaries for fetched issues
  for (const [projPath, issues] of Object.entries(allIssues)) {
    try { await generateMissingIssueSummaries(projPath, issues); } catch {}
  }

  // Write cache
  const cache: DaemonCache = {
    lastUpdated: new Date().toISOString(),
    gitStatuses,
    issues: allIssues,
    usageStats,
    usageByProject,
    recentCommits,
    commitActivity,
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
