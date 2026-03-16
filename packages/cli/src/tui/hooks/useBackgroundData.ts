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

import { useState, useEffect, useRef, useMemo } from 'react';
import pLimit from 'p-limit';
import { getGitStatus } from '../../core/git.js';
import { getIssues } from '../../core/github.js';
import { getRollingUsageWindowed } from '../../core/sessions.js';
import type { WindowedUsageStats } from '../../core/sessions.js';
import { loadIssueSummaryCache, generateMissingSummaries, generateMissingIssueSummaries } from '../../core/summaries.js';
import { issueKey, readDaemonCache } from '../../core/background.js';
import { getClaudeProjectsDir } from '../../core/platform.js';
import { log } from '../../core/logger.js';
import { DEFAULTS } from '../../constants.js';
import { getRecentCommits, getCommitDailyActivity } from '../../core/git.js';
import { getActiveClaudeProcesses } from '../../core/processes.js';
import { parseSessionActivity } from '../../core/activity.js';
import { getDailyUsageByProject } from '../../core/usage.js';
import { getActiveSessionFile, tailSessionFile } from '../../core/tailer.js';
import { getActiveSessionInfo } from '../../core/activity.js';
import { scanAllSessions, getCachedUsage } from '../../core/command-usage.js';
import { readClaudeTier, getEffectiveDailyBudget, getTierLabel, probeRateLimits, formatResetEpoch } from '../../core/claude-usage.js';
import { getSessionTasks } from '../../core/tasks.js';
import type { SessionTasks } from '../../core/tasks.js';
import type { ClaudeTier, RateLimitInfo } from '../../core/claude-usage.js';
import type { CommandUsageCounts } from '../../core/command-usage.js';
import type { TailState } from '../../core/tailer.js';
import {
  isDemoMode,
  demoGitStatuses, demoIssues, demoUsageStats, demoActiveSessions,
  demoCommits, demoCommitActivity, demoUsageHistory, demoCommandUsage,
  demoSessions,
  DEMO_SESSION_ACTIVITY,
} from '../../core/demo-data.js';
import type { GitStatus, Issue, UsageStats, UsageBudget, Project, GitCommit, DailyUsage, ActiveSession, SessionActivity, DaemonCache } from '../../types.js';

export type { RateLimitInfo } from '../../core/claude-usage.js';

const limit = pLimit(DEFAULTS.concurrencyLimit);

// ── Daemon cache: read once at module load for instant first paint ──
let _cachedDaemon: DaemonCache | null | undefined; // undefined = not yet read
function getDaemonCache(): DaemonCache | null {
  if (_cachedDaemon === undefined) {
    try {
      _cachedDaemon = readDaemonCache();
    } catch {
      _cachedDaemon = null;
    }
  }
  return _cachedDaemon;
}

// ── Stable fallback constants (avoid new refs on every render) ────
const EMPTY_ISSUES: Issue[] = [];
const EMPTY_COMMITS: GitCommit[] = [];
const EMPTY_DAILY: DailyUsage[] = [];
const EMPTY_USAGE_HISTORY: Record<string, DailyUsage[]> = {};
const EMPTY_ACTIVE_SESSIONS = { map: new Map<string, ActiveSession>(), allSessions: [] as ActiveSession[], totalCount: 0 };

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
  const [statuses, setStatuses] = useState<Map<string, GitStatus>>(
    () => {
      if (isDemoMode()) return demoGitStatuses();
      const cache = getDaemonCache();
      if (cache?.gitStatuses) {
        return new Map(Object.entries(cache.gitStatuses));
      }
      return new Map();
    }
  );
  const demo = isDemoMode();
  const busyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs — updated on render but don't trigger effects
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const rangeRef = useRef({ start: visibleStart, end: visibleEnd });
  rangeRef.current = { start: visibleStart, end: visibleEnd };

  // Single stable effect — timer never restarts on scroll
  useEffect(() => {
    if (demo) return;
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

    fetchVisible();
    const timer = setInterval(fetchVisible, DEFAULTS.gitPollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced re-fetch when visible range changes (for newly scrolled-to projects)
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const visible = projectsRef.current.slice(visibleStart, visibleEnd + 1);
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
  }, [visibleStart, visibleEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prune stale entries when project paths actually change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projectPathsKey = useMemo(() => projects.map(p => p.path).join('\0'), [projects]);
  useEffect(() => {
    if (demo) return;
    const paths = new Set(projects.map((p) => p.path));
    setStatuses((prev) => {
      let hasStale = false;
      for (const k of prev.keys()) {
        if (!paths.has(k)) { hasStale = true; break; }
      }
      if (!hasStale) return prev;
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
  const demo = isDemoMode();
  const result = usePolling(
    async () => {
      if (demo || !projectPath) return EMPTY_ISSUES;
      const issues = await getIssues(projectPath);

      // Populate richSummary from cached issue summaries
      try {
        const summaryCache = loadIssueSummaryCache();
        for (const issue of issues) {
          const key = issueKey(projectPath, issue.number);
          const cached = summaryCache[key];
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
  if (demo) return projectPath ? demoIssues(projectPath) : EMPTY_ISSUES;
  if (result !== undefined) return result;
  if (projectPath) {
    const cached = getDaemonCache()?.issues?.[projectPath];
    if (cached) return cached;
  }
  return undefined;
}

// ── Usage stats ─────────────────────────────────────────────

/**
 * Get both 5h and 7d windowed usage stats in a single pass.
 * Called once in App.tsx; result feeds both usageStats and useUsageBudget.
 */
export function useWindowedUsageStats(): WindowedUsageStats | undefined {
  const demo = isDemoMode();
  const result = usePolling(
    async () => demo ? undefined as any : getRollingUsageWindowed(getClaudeProjectsDir()),
    DEFAULTS.pollIntervalMs,
    []
  );
  if (demo) {
    const stats = demoUsageStats();
    return {
      fiveHour: stats,
      sevenDay: { tokens: stats.tokens * 3, messages: stats.messages * 5, date: new Date().toISOString() },
    };
  }
  return result ?? undefined;
}

/** @deprecated Use useWindowedUsageStats().fiveHour instead. Kept for daemon cache fallback. */
export function useUsageStats(): UsageStats | undefined {
  const cached = getDaemonCache()?.usageStats;
  return cached;
}

// ── Claude tier + usage budget ──────────────────────────────

/**
 * Read Claude Code's subscription tier (cached for process lifetime).
 * Returns null if credentials aren't found.
 */
export function useClaudeTier(): ClaudeTier | null {
  const demo = isDemoMode();
  const [tier] = useState<ClaudeTier | null>(() => {
    if (demo) return { subscription: 'max', rateLimitTier: 'default_claude_max_5x', windowLimit: 25_000_000, dailyDefault: 50_000_000 };
    return readClaudeTier();
  });
  return tier;
}

/**
 * Compute a unified usage budget from stats + tier + config + live rate limits.
 * Combines auto-detected tier limits with user config override.
 *
 * When the API probe succeeds, uses real utilization percentages.
 * When probe fails (e.g. OAuth auth broken), falls back to local JSONL-based
 * estimates for both 5h and 7d windows so both bars are always shown.
 */
export function useUsageBudget(
  usageStats: UsageStats | undefined,
  configBudget: number | undefined,
  windowed?: WindowedUsageStats,
): UsageBudget | null {
  const tier = useClaudeTier();
  const rateLimitInfo = useRateLimits();

  // Memoize return value — prevents defeating React.memo on ProjectPane/StatusBar
  return useMemo(() => {
    if (!usageStats) return null;

    const autoDetected = !configBudget || configBudget <= 0;
    const tierLabel = getTierLabel(tier);

    // Use local JSONL data for basic stats
    const budgetLimit = getEffectiveDailyBudget(configBudget);
    const used = usageStats.tokens;

    // If we have live rate limit data, use the 5h utilization as the percentage
    // (it's the real API-reported usage, more accurate than our local estimate)
    let percent: number;
    let rateLimits: UsageBudget['rateLimits'] = null;

    if (rateLimitInfo && rateLimitInfo.fiveHourUtil >= 0) {
      // API probe succeeded — use real utilization
      percent = rateLimitInfo.fiveHourUtil * 100;
      const usingExtra = rateLimitInfo.overageUtil > 0;

      rateLimits = {
        fiveHourPercent: rateLimitInfo.fiveHourUtil * 100,
        sevenDayPercent: rateLimitInfo.sevenDayUtil * 100,
        fiveHourResetIn: rateLimitInfo.fiveHourReset > 0
          ? formatResetEpoch(rateLimitInfo.fiveHourReset)
          : rateLimitInfo.fiveHourResetIn,
        sevenDayResetIn: rateLimitInfo.sevenDayReset > 0
          ? formatResetEpoch(rateLimitInfo.sevenDayReset)
          : rateLimitInfo.sevenDayResetIn,
        status: rateLimitInfo.overallStatus,
        fallbackAvailable: rateLimitInfo.fallbackAvailable,
        usingExtraTokens: usingExtra,
        fallbackThreshold: rateLimitInfo.fallbackPercentage,
        overagePercent: rateLimitInfo.overageUtil * 100,
        overageEnabled: rateLimitInfo.overageStatus === 'allowed',
        overageResetIn: rateLimitInfo.overageResetIn,
      };
    } else if (windowed && tier) {
      // API probe failed — compute local 5h/7d estimates from JSONL data.
      // Use the tier's 5h window limit for the 5h bar, and scale for 7d.
      const windowLimit = tier.windowLimit;
      // 7d limit: rough estimate — 7d window allows ~(7*24/5) = ~33.6x the 5h window
      // but usage is bursty, so use a more conservative multiplier
      const sevenDayLimit = windowLimit * 20;

      const fiveHourPct = windowLimit > 0 ? (windowed.fiveHour.tokens / windowLimit) * 100 : 0;
      const sevenDayPct = sevenDayLimit > 0 ? (windowed.sevenDay.tokens / sevenDayLimit) * 100 : 0;

      percent = fiveHourPct;
      rateLimits = {
        fiveHourPercent: fiveHourPct,
        sevenDayPercent: sevenDayPct,
        fiveHourResetIn: '~5h rolling',
        sevenDayResetIn: '~7d rolling',
        status: '',
        fallbackAvailable: false,
        usingExtraTokens: false,
        fallbackThreshold: 0,
        overagePercent: 0,
        overageEnabled: false,
        overageResetIn: '',
      };
    } else {
      percent = budgetLimit > 0 ? (used / budgetLimit) * 100 : 0;
    }

    return { limit: budgetLimit, used, percent, tierLabel, autoDetected, rateLimits };
  }, [usageStats, configBudget, tier, rateLimitInfo, windowed]);
}

/**
 * Probe the Anthropic API for live rate limit data.
 * Runs once on mount, then every 5 minutes.
 * Returns: token limit, remaining, used %, reset time.
 */
export function useRateLimits(): RateLimitInfo | null {
  const demo = isDemoMode();
  const result = usePolling(
    async () => {
      if (demo) return null;
      return probeRateLimits();
    },
    300_000, // 5 minutes
    [],
  );
  if (demo) {
    return {
      fiveHourUtil: 0.30,
      fiveHourStatus: 'allowed',
      fiveHourReset: Math.floor(Date.now() / 1000) + 3 * 3600,
      sevenDayUtil: 0.12,
      sevenDayStatus: 'allowed',
      sevenDayReset: Math.floor(Date.now() / 1000) + 72 * 3600,
      fallbackAvailable: true,
      fallbackPercentage: 0.5,
      overageUtil: 0.62,
      overageStatus: 'allowed',
      overageReset: Math.floor(Date.now() / 1000) + 23 * 24 * 3600,
      overageResetIn: '23d (Apr 1)',
      representativeClaim: 'five_hour',
      overallStatus: 'allowed',
      fiveHourResetIn: '3h',
      sevenDayResetIn: '3d',
      fetchedAt: Date.now(),
    };
  }
  return result ?? null;
}

// ── Active processes ─────────────────────────────────────────

export function useActiveProcesses(
  projects: Project[],
  hiddenPaths: string[] = [],
): { map: Map<string, ActiveSession>; allSessions: ActiveSession[]; totalCount: number } {
  const demo = isDemoMode();
  // Include hidden project paths so mtime detection can find externally-launched sessions
  const pathsRef = useRef([...projects.map(p => p.path), ...hiddenPaths]);
  pathsRef.current = [...projects.map(p => p.path), ...hiddenPaths];

  // Keep a stable reference to the previous result to avoid unnecessary re-renders
  const prevResultRef = useRef<{ map: Map<string, ActiveSession>; allSessions: ActiveSession[]; totalCount: number } | null>(null);

  const result = usePolling(
    async () => {
      if (demo) return EMPTY_ACTIVE_SESSIONS;
      const sessions = await getActiveClaudeProcesses(pathsRef.current);

      // Enrich each session with JSONL-parsed stats (cached — only re-parses on file change)
      for (const session of sessions) {
        try {
          // Use session-specific file if available, fall back to newest file for project
          const jsonlFile = session.sessionFilePath ?? getActiveSessionFile(session.projectPath);
          if (jsonlFile) {
            const info = await getActiveSessionInfo(jsonlFile);
            if (info) {
              session.stats = info.stats;
              if (info.currentAction) session.currentAction = info.currentAction;
            }
          }
        } catch { /* skip enrichment on error */ }
      }

      // Per-project map: keeps the most recently active session per project
      // (used for project badges, live tailing target, detail pane)
      const map = new Map<string, ActiveSession>();
      for (const s of sessions) {
        const existing = map.get(s.projectPath);
        if (!existing || s.lastActivity > existing.lastActivity) {
          map.set(s.projectPath, s);
        }
      }
      const next = { map, allSessions: sessions, totalCount: sessions.length };

      // Compare with previous result — reuse if structurally equal to keep refs stable
      const prev = prevResultRef.current;
      if (prev && prev.totalCount === next.totalCount) {
        let same = true;
        // Build lookup map for O(n) comparison (instead of O(n²) .find() loop)
        const prevMap = new Map<string, ActiveSession>();
        for (const s of prev.allSessions) {
          prevMap.set(`${s.sessionId}:${s.projectPath}`, s);
        }
        // Compare all sessions (not just the deduped map) so multi-session changes are detected
        for (let i = 0; i < next.allSessions.length && same; i++) {
          const session = next.allSessions[i];
          const old = prevMap.get(`${session.sessionId}:${session.projectPath}`);
          if (!old || old.sessionId !== session.sessionId
            || old.currentAction !== session.currentAction
            || old.idle !== session.idle || old.tracked !== session.tracked
            || old.lastActivity.getTime() !== session.lastActivity.getTime()
            || old.stats.tokens !== session.stats.tokens
            || old.stats.messages !== session.stats.messages
            || old.stats.agentSpawns !== session.stats.agentSpawns
            || old.stats.toolCalls.writes !== session.stats.toolCalls.writes
            || old.stats.toolCalls.reads !== session.stats.toolCalls.reads
            || old.stats.toolCalls.bash !== session.stats.toolCalls.bash
            || old.stats.assistantTurns !== session.stats.assistantTurns
            || old.stats.toolUseTurns !== session.stats.toolUseTurns
            || !shallowEqual(old.stats.mcpCalls, session.stats.mcpCalls)) {
            same = false;
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
  if (demo) { const m = demoActiveSessions(); return { map: m, allSessions: Array.from(m.values()), totalCount: m.size }; }
  return result ?? EMPTY_ACTIVE_SESSIONS;
}

// ── Recent commits ───────────────────────────────────────────

export function useRecentCommits(projectPath: string | null): GitCommit[] {
  const demo = isDemoMode();
  const result = usePolling(
    async () => {
      if (demo || !projectPath) return EMPTY_COMMITS;
      return getRecentCommits(projectPath, 10);
    },
    30_000,
    [projectPath]
  );
  if (demo) return projectPath ? demoCommits(projectPath) : EMPTY_COMMITS;
  if (result) return result;
  if (projectPath) {
    const cached = getDaemonCache()?.recentCommits?.[projectPath];
    if (cached) return cached;
  }
  return EMPTY_COMMITS;
}

// ── Commit activity (for heatmap) ────────────────────────────

export function useCommitActivity(projectPath: string | null): DailyUsage[] {
  const demo = isDemoMode();
  const result = usePolling(
    async () => {
      if (demo || !projectPath) return EMPTY_DAILY;
      return getCommitDailyActivity(projectPath, 28);
    },
    300_000, // 5 min
    [projectPath]
  );
  if (demo) return projectPath ? demoCommitActivity(projectPath) : EMPTY_DAILY;
  if (result) return result;
  if (projectPath) {
    const cached = getDaemonCache()?.commitActivity?.[projectPath];
    if (cached) return cached;
  }
  return EMPTY_DAILY;
}

// ── Usage history (per-project daily) ────────────────────────

export function useUsageHistory(): Record<string, DailyUsage[]> {
  const demo = isDemoMode();
  const result = usePolling(
    async () => demo ? EMPTY_USAGE_HISTORY : getDailyUsageByProject(28),
    300_000, // 5 min
    []
  );
  if (demo) return demoUsageHistory();
  return result ?? getDaemonCache()?.usageByProject ?? EMPTY_USAGE_HISTORY;
}

// ── Session activity (rich stats for selected session) ────────
// Preserves previous activity during async transition to avoid flash-to-null.

export function useSessionActivity(sessionFilePath: string | null): SessionActivity | null {
  const demo = isDemoMode();
  const [activity, setActivity] = useState<SessionActivity | null>(
    () => demo ? DEMO_SESSION_ACTIVITY : null
  );

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    if (!sessionFilePath) { setActivity(null); return; }

    parseSessionActivity(sessionFilePath).then(result => {
      if (!cancelled) setActivity(result);
    }).catch(() => {
      if (!cancelled) setActivity(null);
    });
    return () => { cancelled = true; };
  }, [sessionFilePath, demo]);

  if (demo) return sessionFilePath ? DEMO_SESSION_ACTIVITY : null;
  return activity;
}

// ── Live session tailing ─────────────────────────────────────
// Tails the most recent JSONL for an active project.

export function useLiveSession(
  projectPath: string | null,
  isActive: boolean,
): TailState | null {
  const demo = isDemoMode();
  const [tailState, setTailState] = useState<TailState | null>(null);

  useEffect(() => {
    if (demo || !projectPath || !isActive) {
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
  }, [projectPath, isActive, demo]);

  if (demo) return null;
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
): { revision: number; isSummarizing: boolean } {
  const demo = isDemoMode();
  const [revision, setRevision] = useState(0);
  const [isSummarizing, setSummarizing] = useState(false);
  const startupDoneRef = useRef(false);
  const issueSummarizedRef = useRef(new Set<string>());
  const sessionSummarizedRef = useRef(new Set<string>());

  // Priority: summarize the SELECTED project immediately on navigation
  useEffect(() => {
    if (demo || !selectedProjectPath) return;
    if (sessionSummarizedRef.current.has(selectedProjectPath)) return;

    let cancelled = false;
    setSummarizing(true);

    (async () => {
      try {
        const count = await generateMissingSummaries(selectedProjectPath, 2);
        sessionSummarizedRef.current.add(selectedProjectPath);
        if (!cancelled && count > 0) {
          log('auto-summarize', { action: 'selected', projectPath: selectedProjectPath, count });
          setRevision(r => r + 1);
        }
      } catch {
        // Ignore errors — startup sweep will retry
      } finally {
        if (!cancelled) setSummarizing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedProjectPath]);

  // Startup sweep: summarize sessions across all projects (lower priority)
  useEffect(() => {
    if (demo || startupDoneRef.current || allProjects.length === 0) return;
    startupDoneRef.current = true;

    let cancelled = false;

    (async () => {
      let totalGenerated = 0;
      for (const project of allProjects) {
        if (cancelled) break;
        // Skip projects already summarized by the priority effect
        if (sessionSummarizedRef.current.has(project.path)) continue;
        try {
          const count = await generateMissingSummaries(project.path, 2);
          sessionSummarizedRef.current.add(project.path);
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
    if (demo || !selectedProjectPath || !issues || issues.length === 0) return;
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
  }, [selectedProjectPath, issues]); // eslint-disable-line react-hooks/exhaustive-deps

  if (demo) return { revision: 0, isSummarizing: false };
  return { revision, isSummarizing };
}

// ── Live session tasks/todos ─────────────────────────────

export type { SessionTasks } from '../../core/tasks.js';

/**
 * Poll for tasks/todos for the given session ID.
 * Only polls when the conversation is expanded (avoids wasted I/O).
 * Polls every 3 seconds since tasks update frequently during active work.
 */
export function useSessionTasks(
  sessionId: string | null,
  enabled: boolean,
): SessionTasks | null {
  const demo = isDemoMode();
  const result = usePolling(
    async () => {
      if (demo || !sessionId || !enabled) return null;
      const tasks = getSessionTasks(sessionId);
      if (tasks.todos.length === 0 && tasks.tasks.length === 0) return null;
      return tasks;
    },
    3000,
    [sessionId, enabled],
  );
  if (demo) {
    // Demo mode: return mock tasks when enabled
    if (!enabled || !sessionId) return null;
    return {
      todos: [
        { content: 'Set up project structure', status: 'completed' },
        { content: 'Implement core logic', status: 'completed' },
        { content: 'Add error handling', status: 'pending', activeForm: 'Adding error handling...' },
        { content: 'Write tests', status: 'pending' },
        { content: 'Update documentation', status: 'pending' },
      ],
      tasks: [],
    };
  }
  return result ?? null;
}

/**
 * Background scan of all sessions for slash command usage.
 * Returns cached counts instantly, then updates after full scan.
 */
export function useCommandUsage(): CommandUsageCounts {
  const demo = isDemoMode();
  const [counts, setCounts] = useState<CommandUsageCounts>(() => getCachedUsage());

  useEffect(() => {
    if (demo) return;
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
  }, [demo]);

  if (demo) return demoCommandUsage();
  return counts;
}
