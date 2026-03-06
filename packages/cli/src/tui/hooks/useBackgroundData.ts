/**
 * Background data polling: git status + issues + usage stats.
 * Shared usePolling hook with busy guard, cleanup, error swallowing.
 *
 * Anti-flicker design:
 * - usePolling preserves previous data across dep changes (no undefined flash)
 * - busyRef resets on cleanup so new effects aren't blocked by stale fetches
 * - Git statuses use a stable ref-based timer (not restarted on every scroll)
 * - useSessionActivity keeps previous value during async transition
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import pLimit from 'p-limit';
import { getGitStatus } from '../../core/git.js';
import { getIssues } from '../../core/github.js';
import { getRollingUsageStats } from '../../core/sessions.js';
import { loadIssueSummaryCache, generateMissingSummaries, generateMissingIssueSummaries } from '../../core/summaries.js';
import { issueKey } from '../../core/background.js';
import { getClaudeProjectsDir } from '../../core/platform.js';
import { log } from '../../core/logger.js';
import { DEFAULTS } from '../../constants.js';
import { getRecentCommits, getCommitDailyActivity } from '../../core/git.js';
import { getActiveClaudeProcesses } from '../../core/processes.js';
import { parseSessionActivity } from '../../core/activity.js';
import { getDailyUsageByProject } from '../../core/usage.js';
import { getActiveSessionFile, tailSessionFile } from '../../core/tailer.js';
import { scanAllSessions, getCachedUsage } from '../../core/command-usage.js';
import type { CommandUsageCounts } from '../../core/command-usage.js';
import type { TailState } from '../../core/tailer.js';
import type { GitStatus, Issue, UsageStats, Project, GitCommit, DailyUsage, ActiveSession, SessionActivity } from '../../types.js';

const limit = pLimit(DEFAULTS.concurrencyLimit);

// ── Stable fallback constants (avoid new refs on every render) ────
const EMPTY_ISSUES: Issue[] = [];
const EMPTY_COMMITS: GitCommit[] = [];
const EMPTY_DAILY: DailyUsage[] = [];
const EMPTY_USAGE_HISTORY: Record<string, DailyUsage[]> = {};
const EMPTY_ACTIVE_SESSIONS = { map: new Map<string, ActiveSession>(), totalCount: 0 };

// ── Shallow equality check ──────────────────────────────────
// Prevents no-op re-renders when polled data hasn't changed.

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  // Arrays: compare length + elements by identity
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Maps: compare size + entries by identity
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || b.get(k) !== v) return false;
    }
    return true;
  }

  // Plain objects: shallow key comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (aObj[key] !== bObj[key]) return false;
    }
    return true;
  }

  return false;
}

// ── usePolling hook ─────────────────────────────────────────
// Keeps previous data during refetch to avoid flicker.
// Resets busyRef on cleanup so dep changes aren't blocked.
// Uses shallowEqual to skip no-op setState calls.

function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = []
): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);
  const busyRef = useRef(false);
  const fnRef = useRef(fn);
  const prevRef = useRef<T | undefined>(undefined);
  fnRef.current = fn;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    // Reset busy on each effect start so stale in-flight fetches don't block us
    busyRef.current = false;
    // Reset equality guard so the next result always commits (bypasses shallowEqual)
    // but keep showing previous data until the new fetch completes (no undefined flash)
    prevRef.current = undefined;

    const tick = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      try {
        const result = await fnRef.current();
        if (!cancelled && !shallowEqual(prevRef.current, result)) {
          prevRef.current = result;
          setData(result);
        }
      } catch (err) {
        log('polling_error', { message: String(err) });
      } finally {
        if (!cancelled) busyRef.current = false;
      }
    };

    // Immediate first invocation
    tick();
    timer = setInterval(tick, intervalMs);

    return () => {
      cancelled = true;
      busyRef.current = false;
      if (timer) clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return data;
}

// ── Git statuses ────────────────────────────────────────────
// Uses refs for scroll range so the timer doesn't restart on every j/k press.

export function useGitStatuses(
  projects: Project[],
  visibleStart: number,
  visibleEnd: number
): Map<string, GitStatus> {
  const [statuses, setStatuses] = useState<Map<string, GitStatus>>(new Map());
  const busyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs — updated on render but don't trigger effects
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const rangeRef = useRef({ start: visibleStart, end: visibleEnd });
  rangeRef.current = { start: visibleStart, end: visibleEnd };

  // Single stable effect — timer never restarts on scroll
  useEffect(() => {
    let cancelled = false;

    const fetchVisible = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      try {
        const { start, end } = rangeRef.current;
        const visible = projectsRef.current.slice(start, end + 1);
        const results = await Promise.all(
          visible.map((p) =>
            limit(async () => {
              const status = await getGitStatus(p.path);
              return { path: p.path, status };
            })
          )
        );

        if (cancelled) return;

        setStatuses((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const { path, status } of results) {
            if (status) {
              const existing = prev.get(path);
              // Only update if actually different to avoid unnecessary re-renders
              if (!existing || existing.branch !== status.branch
                || existing.dirty !== status.dirty
                || existing.ahead !== status.ahead) {
                next.set(path, status);
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      } finally {
        busyRef.current = false;
      }
    };

    // Initial fetch
    fetchVisible();
    // Periodic refresh
    const timer = setInterval(fetchVisible, DEFAULTS.gitPollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []); // stable — uses refs for everything

  // Debounced re-fetch when visible range changes (for newly scrolled-to projects)
  useEffect(() => {
    let cancelled = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const visible = projectsRef.current.slice(visibleStart, visibleEnd + 1);
        // Only fetch projects we don't already have
        const missing = visible.filter(p => !statuses.has(p.path));
        if (missing.length === 0) { busyRef.current = false; return; }

        const results = await Promise.all(
          missing.map((p) =>
            limit(async () => {
              const status = await getGitStatus(p.path);
              return { path: p.path, status };
            })
          )
        );

        if (!cancelled) {
          setStatuses((prev) => {
            const next = new Map(prev);
            for (const { path, status } of results) {
              if (status) next.set(path, status);
            }
            return next;
          });
        }
      } finally {
        busyRef.current = false;
      }
    }, 200);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [visibleStart, visibleEnd]);

  // Prune stale entries when project paths actually change (not on every filter keystroke)
  const projectPathsKey = projects.map(p => p.path).join('\0');
  useEffect(() => {
    const paths = new Set(projects.map((p) => p.path));
    setStatuses((prev) => {
      // Only prune if there are actually stale keys
      let hasStale = false;
      for (const k of prev.keys()) {
        if (!paths.has(k)) { hasStale = true; break; }
      }
      if (!hasStale) return prev; // skip setState entirely
      const next = new Map<string, GitStatus>();
      for (const [k, v] of prev) {
        if (paths.has(k)) next.set(k, v);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPathsKey]);

  return statuses;
}

// ── Issues ──────────────────────────────────────────────────

export function useIssues(projectPath: string | null): Issue[] | undefined {
  return usePolling(
    async () => {
      if (!projectPath) return EMPTY_ISSUES;
      const issues = await getIssues(projectPath);

      // Populate richSummary from cached issue summaries
      try {
        const cache = loadIssueSummaryCache();
        for (const issue of issues) {
          const key = issueKey(projectPath, issue.number);
          const cached = cache[key];
          if (cached) {
            issue.richSummary = cached.summary;
          }
        }
      } catch { /* ignore cache errors */ }

      return issues;
    },
    DEFAULTS.issuePollIntervalMs,
    [projectPath]
  );
}

// ── Usage stats ─────────────────────────────────────────────

export function useUsageStats(): UsageStats | undefined {
  return usePolling(
    async () => getRollingUsageStats(getClaudeProjectsDir()),
    DEFAULTS.pollIntervalMs,
    []
  );
}

// ── Active processes ─────────────────────────────────────────

export function useActiveProcesses(
  projects: Project[]
): { map: Map<string, ActiveSession>; totalCount: number } {
  const pathsRef = useRef(projects.map(p => p.path));
  pathsRef.current = projects.map(p => p.path);

  // Keep a stable reference to the previous result to avoid unnecessary re-renders
  const prevResultRef = useRef<{ map: Map<string, ActiveSession>; totalCount: number } | null>(null);

  const result = usePolling(
    async () => {
      const sessions = await getActiveClaudeProcesses(pathsRef.current);
      const map = new Map<string, ActiveSession>();
      for (const s of sessions) {
        // If multiple sessions on same project, keep the most recently active
        const existing = map.get(s.projectPath);
        if (!existing || s.lastActivity > existing.lastActivity) {
          map.set(s.projectPath, s);
        }
      }
      const next = { map, totalCount: sessions.length };

      // Compare with previous result — reuse if structurally equal to keep refs stable
      const prev = prevResultRef.current;
      if (prev && prev.totalCount === next.totalCount && prev.map.size === next.map.size) {
        let same = true;
        for (const [path, session] of next.map) {
          const old = prev.map.get(path);
          if (!old || old.pid !== session.pid || old.sessionId !== session.sessionId
            || old.currentAction !== session.currentAction
            || old.idle !== session.idle || old.tracked !== session.tracked
            || old.lastActivity.getTime() !== session.lastActivity.getTime()
            || old.stats.tokens !== session.stats.tokens
            || old.stats.messages !== session.stats.messages
            || old.stats.agentSpawns !== session.stats.agentSpawns
            || old.stats.toolCalls.writes !== session.stats.toolCalls.writes
            || old.stats.toolCalls.reads !== session.stats.toolCalls.reads
            || old.stats.toolCalls.bash !== session.stats.toolCalls.bash
            || JSON.stringify(old.stats.mcpCalls) !== JSON.stringify(session.stats.mcpCalls)) {
            same = false;
            break;
          }
        }
        if (same) return prev; // Return same ref — shallowEqual will match
      }
      prevResultRef.current = next;
      return next;
    },
    5000, // every 5 seconds
    [] // no deps — uses ref, polls forever
  );
  return result ?? EMPTY_ACTIVE_SESSIONS;
}

// ── Recent commits ───────────────────────────────────────────

export function useRecentCommits(projectPath: string | null): GitCommit[] {
  const result = usePolling(
    async () => {
      if (!projectPath) return EMPTY_COMMITS;
      return getRecentCommits(projectPath, 10);
    },
    30_000,
    [projectPath]
  );
  return result ?? EMPTY_COMMITS;
}

// ── Commit activity (for heatmap) ────────────────────────────

export function useCommitActivity(projectPath: string | null): DailyUsage[] {
  const result = usePolling(
    async () => {
      if (!projectPath) return EMPTY_DAILY;
      return getCommitDailyActivity(projectPath, 28);
    },
    300_000, // 5 min
    [projectPath]
  );
  return result ?? EMPTY_DAILY;
}

// ── Usage history (per-project daily) ────────────────────────

export function useUsageHistory(): Record<string, DailyUsage[]> {
  const result = usePolling(
    async () => getDailyUsageByProject(28),
    300_000, // 5 min
    []
  );
  return result ?? EMPTY_USAGE_HISTORY;
}

// ── Session activity (rich stats for selected session) ────────
// Preserves previous activity during async transition to avoid flash-to-null.

export function useSessionActivity(sessionFilePath: string | null): SessionActivity | null {
  const [activity, setActivity] = useState<SessionActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!sessionFilePath) { setActivity(null); return; }

    // Don't clear previous activity — keep showing it until new data arrives
    parseSessionActivity(sessionFilePath).then(result => {
      if (!cancelled) setActivity(result);
    }).catch(() => {
      if (!cancelled) setActivity(null);
    });
    return () => { cancelled = true; };
  }, [sessionFilePath]);

  return activity;
}

// ── Live session tailing ─────────────────────────────────────
// Tails the most recent JSONL for an active project.

export function useLiveSession(
  projectPath: string | null,
  isActive: boolean,
): TailState | null {
  const [tailState, setTailState] = useState<TailState | null>(null);

  useEffect(() => {
    if (!projectPath || !isActive) {
      setTailState(null);
      return;
    }

    const sessionFile = getActiveSessionFile(projectPath);
    if (!sessionFile) {
      setTailState(null);
      return;
    }

    const cleanup = tailSessionFile(sessionFile, (state) => {
      setTailState(state);
    });

    return () => {
      cleanup();
    };
  }, [projectPath, isActive]);

  return tailState;
}

// ── Auto-summarize (background) ──────────────────────────────
// At startup, sweeps ALL projects for missing session summaries.
// Also generates issue summaries for the selected project when issues load.
// Returns a revision counter that increments after each batch, triggering
// session list re-fetch so new summaries appear live.

export function useAutoSummarize(
  allProjects: Project[],
  selectedProjectPath: string | null,
  issues: Issue[] | undefined,
): number {
  const [revision, setRevision] = useState(0);
  const startupDoneRef = useRef(false);
  const issueSummarizedRef = useRef(new Set<string>());

  // Startup sweep: summarize sessions across all projects
  useEffect(() => {
    if (startupDoneRef.current || allProjects.length === 0) return;
    startupDoneRef.current = true;

    let cancelled = false;

    (async () => {
      let totalGenerated = 0;
      // Process sequentially so we don't hammer CPU with parallel claude calls
      for (const project of allProjects) {
        if (cancelled) break;
        try {
          const count = await generateMissingSummaries(project.path, 2);
          if (count > 0) {
            totalGenerated += count;
            if (!cancelled) setRevision(r => r + 1);
          }
        } catch {
          // Skip failures, continue with next project
        }
      }
      if (totalGenerated > 0) {
        log('auto-summarize', { action: 'startup', totalGenerated });
      }
    })();

    return () => { cancelled = true; };
  }, [allProjects]);

  // Issue summaries: generate when issues load for a project
  useEffect(() => {
    if (!selectedProjectPath || !issues || issues.length === 0) return;
    if (issueSummarizedRef.current.has(selectedProjectPath)) return;

    let cancelled = false;

    (async () => {
      try {
        const count = await generateMissingIssueSummaries(selectedProjectPath, issues, 2);
        issueSummarizedRef.current.add(selectedProjectPath);
        if (!cancelled && count > 0) {
          log('auto-summarize', { action: 'issues', projectPath: selectedProjectPath, count });
          setRevision(r => r + 1);
        }
      } catch {
        // Ignore errors
      }
    })();

    return () => { cancelled = true; };
  }, [selectedProjectPath, issues]);

  return revision;
}

/**
 * Background scan of all sessions for slash command usage.
 * Returns cached counts instantly, then updates after full scan.
 */
export function useCommandUsage(): CommandUsageCounts {
  const [counts, setCounts] = useState<CommandUsageCounts>(() => getCachedUsage());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const totals = await scanAllSessions();
        if (!cancelled) setCounts(totals);
      } catch {
        // Keep cached counts on failure
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return counts;
}
