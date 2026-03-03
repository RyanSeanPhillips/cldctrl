/**
 * Background data polling: git status + issues + usage stats.
 * Shared usePolling hook with busy guard, cleanup, error swallowing.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import pLimit from 'p-limit';
import { getGitStatus } from '../../core/git.js';
import { getIssues } from '../../core/github.js';
import { getDailyUsageStats } from '../../core/sessions.js';
import { loadIssueSummaryCache } from '../../core/summaries.js';
import { issueKey } from '../../core/background.js';
import { getClaudeProjectsDir } from '../../core/platform.js';
import { log } from '../../core/logger.js';
import { DEFAULTS } from '../../constants.js';
import type { GitStatus, Issue, UsageStats, Project } from '../../types.js';

const limit = pLimit(DEFAULTS.concurrencyLimit);

// ── usePolling hook ─────────────────────────────────────────

function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = []
): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);
  const busyRef = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const tick = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      try {
        const result = await fnRef.current();
        if (!cancelled) setData(result);
      } catch (err) {
        log('polling_error', { message: String(err) });
      } finally {
        busyRef.current = false;
      }
    };

    // Immediate first invocation
    tick();
    timer = setInterval(tick, intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return data;
}

// ── Git statuses ────────────────────────────────────────────

export function useGitStatuses(
  projects: Project[],
  visibleStart: number,
  visibleEnd: number
): Map<string, GitStatus> {
  const [statuses, setStatuses] = useState<Map<string, GitStatus>>(new Map());
  const busyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable ref for projects to avoid re-triggering on every array identity change
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const rangeRef = useRef({ start: visibleStart, end: visibleEnd });
  rangeRef.current = { start: visibleStart, end: visibleEnd };

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
          for (const { path, status } of results) {
            if (status) next.set(path, status);
          }
          return next;
        });
      } finally {
        busyRef.current = false;
      }
    };

    // Debounce: wait 150ms after last range change before fetching
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchVisible();
    }, 150);

    // Periodic refresh on a longer interval
    const timer = setInterval(fetchVisible, DEFAULTS.gitPollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [visibleStart, visibleEnd]);

  // Also refetch when projects list changes identity (e.g. after refresh)
  useEffect(() => {
    // Reset statuses when projects fundamentally change
    const paths = new Set(projects.map((p) => p.path));
    setStatuses((prev) => {
      const next = new Map<string, GitStatus>();
      for (const [k, v] of prev) {
        if (paths.has(k)) next.set(k, v);
      }
      return next;
    });
  }, [projects.length]);

  return statuses;
}

// ── Issues ──────────────────────────────────────────────────

export function useIssues(projectPath: string | null): Issue[] | undefined {
  return usePolling(
    async () => {
      if (!projectPath) return [];
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
    async () => getDailyUsageStats(getClaudeProjectsDir()),
    DEFAULTS.pollIntervalMs,
    []
  );
}
