/**
 * Root TUI component: split-pane layout, focus management, alternate screen buffer.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { render, Box, Text, useStdout } from 'ink';
import { useAppState } from './hooks/useAppState.js';
import {
  useGitStatuses,
  useIssues,
  useUsageStats,
  useActiveProcesses,
  useRecentCommits,
  useCommitActivity,
  useUsageHistory,
  useSessionActivity,
  useLiveSession,
  useAutoSummarize,
  useCommandUsage,
} from './hooks/useBackgroundData.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { getRecentSessions } from '../core/sessions.js';
import { ProjectPane } from './components/ProjectPane.js';
import { DetailPane } from './components/DetailPane.js';
import { FilterBar } from './components/FilterBar.js';
import { PromptBar } from './components/PromptBar.js';
import { StatusBar } from './components/StatusBar.js';
import { Welcome } from './components/Welcome.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { GameScreen } from './games/GameScreen.js';
import { DEFAULTS, INK_COLORS, APP_NAME, VERSION } from '../constants.js';
import { getSkillsSummary } from '../core/skills.js';
import { supportsSixel, getRocketSixel } from '../core/sixel.js';
import type { Session, DailyUsage, Issue, GitCommit, SessionActivity } from '../types.js';

const EMPTY_ISSUES: Issue[] = [];
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_COMMITS: GitCommit[] = [];
const EMPTY_DAILY: DailyUsage[] = [];

/** Cached detail data per project — avoids piecemeal re-renders on scroll. */
interface DetailSnapshot {
  sessions: Session[];
  issues: Issue[];
  commits: GitCommit[];
  commitActivity: DailyUsage[];
  usageHistory: DailyUsage[];
}

function App() {
  const { state, dispatch } = useAppState();

  // Terminal dimensions
  const { stdout } = useStdout();
  const [dims, setDims] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    const onResize = () => {
      if (stdout) {
        setDims({ cols: stdout.columns, rows: stdout.rows });
      }
    };
    stdout?.on('resize', onResize);
    return () => { stdout?.off('resize', onResize); };
  }, [stdout]);


  // Skills/commands discovery (sync FS reads, fast)
  const skillsData = useMemo(() => getSkillsSummary(), []);

  // Filter projects
  const filteredProjects = useMemo(() => {
    if (!state.filterText) return state.projects;
    const lower = state.filterText.toLowerCase();
    return state.projects.filter(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.path.toLowerCase().includes(lower)
    );
  }, [state.projects, state.filterText]);

  // Selected project (immediate — for display in project list)
  const selectedProject = filteredProjects[state.selectedIndex];

  // Debounced selected project path — waits for scrolling to settle before
  // triggering expensive data fetches (issues, commits, sessions, etc.)
  const [settledPath, setSettledPath] = useState<string | null>(selectedProject?.path ?? null);
  const settledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const newPath = selectedProject?.path ?? null;
    if (newPath === settledPath) return; // already settled
    if (settledTimerRef.current) clearTimeout(settledTimerRef.current);
    settledTimerRef.current = setTimeout(() => setSettledPath(newPath), 150);
    return () => { if (settledTimerRef.current) clearTimeout(settledTimerRef.current); };
  }, [selectedProject?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const settledProject = useMemo(
    () => filteredProjects.find(p => p.path === settledPath) ?? null,
    [filteredProjects, settledPath],
  );

  // Background data
  const leftWidth = Math.floor(dims.cols * DEFAULTS.leftPaneWidth);
  const rightWidth = dims.cols - leftWidth;
  const bodyHeight = dims.rows - 4; // header + filter bar + status bar + 1

  const viewportHeight = Math.max(1, bodyHeight - 2);
  const visibleStart = Math.max(0, state.selectedIndex - viewportHeight);
  const visibleEnd = Math.min(filteredProjects.length - 1, visibleStart + viewportHeight);

  const gitStatuses = useGitStatuses(filteredProjects, visibleStart, visibleEnd);
  const issues = useIssues(settledPath);
  const usageStats = useUsageStats();

  // New hooks — use settledPath for expensive per-project data fetching
  const { map: activeProcesses, totalCount: liveSessionCount } = useActiveProcesses(filteredProjects);
  const commits = useRecentCommits(settledPath);
  const commitActivity = useCommitActivity(settledPath);
  const usageHistory = useUsageHistory();
  const commandUsage = useCommandUsage();

  // Live session tailing for the settled project
  const selectedActive = settledProject ? activeProcesses.get(settledProject.path) : undefined;
  const liveSession = useLiveSession(
    settledPath,
    !!selectedActive,
  );

  // Merge live tailing data into activeProcesses for display
  // Uses settledProject (not selectedProject) to avoid creating new Map refs on every scroll
  const enrichedProcesses = useMemo(() => {
    if (!liveSession || !settledProject) return activeProcesses;
    const existing = activeProcesses.get(settledProject.path);
    if (!existing) return activeProcesses;

    const newSessionId = liveSession.sessionId ?? existing.sessionId;
    // Skip allocation if nothing meaningful changed
    if (existing.stats === liveSession.activity
      && existing.currentAction === liveSession.currentAction
      && existing.sessionId === newSessionId) {
      return activeProcesses;
    }

    const enriched = new Map(activeProcesses);
    enriched.set(settledProject.path, {
      ...existing,
      stats: liveSession.activity,
      currentAction: liveSession.currentAction,
      sessionId: newSessionId,
    });
    return enriched;
  }, [activeProcesses, liveSession, settledProject]);

  // Issue counts per project (for badges) — accumulates across selections
  const [issueCounts, setIssueCounts] = useState(new Map<string, number>());
  useEffect(() => {
    if (settledProject && issues) {
      setIssueCounts(prev => {
        if (prev.get(settledProject.path) === issues.length) return prev;
        const next = new Map(prev);
        next.set(settledProject.path, issues.length);
        return next;
      });
    }
  }, [settledProject, issues]);

  // Launch feedback message (auto-clears after 3s)
  const [launchMsg, setLaunchMsg] = useState<string>('');
  const onLaunchFeedback = useCallback((msg: string) => {
    setLaunchMsg(msg);
    setTimeout(() => setLaunchMsg(''), 3000);
  }, []);

  // Auto-summarize: sweep all projects at startup, issues on selection
  const summaryRevision = useAutoSummarize(filteredProjects, settledPath, issues);

  // Recent sessions for settled project (re-fetches when summaries are generated)
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    if (!settledPath) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    getRecentSessions(settledPath, 30).then((s) => {
      if (!cancelled) setSessions(s);
    });
    return () => { cancelled = true; };
  }, [settledPath, summaryRevision]);

  // Per-project usage history — exact slug match (uses settled project)
  const projectUsageHistory = useMemo(() => {
    if (!settledProject) return EMPTY_DAILY;
    const slug = settledProject.path.replace(/[:\\/_ ]/g, '-');
    return usageHistory[slug] ?? EMPTY_DAILY;
  }, [usageHistory, settledProject]);

  // ── Detail snapshot cache ─────────────────────────────────
  // Caches per-project detail data so scrolling swaps to cached views instantly
  // instead of showing piecemeal data as each hook resolves independently.
  const snapshotCacheRef = useRef(new Map<string, DetailSnapshot>());
  const snapshotCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [displaySnapshot, setDisplaySnapshot] = useState<DetailSnapshot>({
    sessions: EMPTY_SESSIONS,
    issues: EMPTY_ISSUES,
    commits: EMPTY_COMMITS,
    commitActivity: EMPTY_DAILY,
    usageHistory: EMPTY_DAILY,
  });

  // When data arrives for settledPath, update cache and debounce a single commit
  useEffect(() => {
    if (!settledPath) return;
    const snapshot: DetailSnapshot = {
      sessions,
      issues: issues ?? EMPTY_ISSUES,
      commits,
      commitActivity,
      usageHistory: projectUsageHistory,
    };
    snapshotCacheRef.current.set(settledPath, snapshot);

    // Debounce: batch multiple data arrivals into one DetailPane re-render
    if (snapshotCommitRef.current) clearTimeout(snapshotCommitRef.current);
    snapshotCommitRef.current = setTimeout(() => {
      // Only commit if still viewing this project (settledPath matches selected)
      setDisplaySnapshot(snapshot);
    }, 32); // ~2 frames — enough to batch, short enough to feel responsive
    return () => {
      if (snapshotCommitRef.current) clearTimeout(snapshotCommitRef.current);
    };
  }, [settledPath, sessions, issues, commits, commitActivity, projectUsageHistory]);

  // On scroll: instantly swap to cached snapshot (or keep current if no cache)
  useEffect(() => {
    if (!selectedProject) return;
    const cached = snapshotCacheRef.current.get(selectedProject.path);
    if (cached) {
      // Cancel any pending debounced commit (old project's data arriving)
      if (snapshotCommitRef.current) clearTimeout(snapshotCommitRef.current);
      setDisplaySnapshot(cached);
    }
    // If no cache for this project, keep showing the previous snapshot
    // until settledPath catches up and new data arrives
  }, [selectedProject?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Session activity for detail preview (uses cached snapshot's sessions)
  const selectedSessionFile = (state.detailSection === 'sessions' && displaySnapshot.sessions[state.detailIndex])
    ? displaySnapshot.sessions[state.detailIndex].filePath
    : null;
  const sessionActivity = useSessionActivity(selectedSessionFile);

  // Aggregate usage history into a flat array for left pane calendar
  const allUsageHistory = useMemo(() => {
    const dailyMap = new Map<string, DailyUsage>();
    for (const projectUsage of Object.values(usageHistory)) {
      for (const day of projectUsage) {
        const existing = dailyMap.get(day.date);
        if (existing) {
          existing.tokens += day.tokens;
          existing.messages += day.messages;
        } else {
          dailyMap.set(day.date, { ...day });
        }
      }
    }
    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [usageHistory]);

  // Keyboard handling — uses cached snapshot data for stable counts
  useKeyboard({
    state,
    dispatch,
    viewportHeight,
    filteredProjects,
    selectedProject,
    recentSessions: displaySnapshot.sessions,
    issues: displaySnapshot.issues,
    commits: displaySnapshot.commits,
    onLaunchFeedback,
    skillsData,
  });

  // ── Minimum terminal size guard ──────────────────────────
  if (dims.cols < 60 || dims.rows < 10) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={INK_COLORS.yellow}>
          Terminal too small ({dims.cols}x{dims.rows}). Need at least 60x10.
        </Text>
      </Box>
    );
  }

  // ── Game screen ────────────────────────────────────────
  if (state.mode === 'game' && state.activeGame) {
    return (
      <GameScreen
        game={state.activeGame}
        width={dims.cols}
        height={dims.rows}
        onExit={() => dispatch({ type: 'SET_GAME', game: null })}
      />
    );
  }

  // ── Welcome screen ──────────────────────────────────────
  if (state.mode === 'welcome') {
    return <Welcome />;
  }

  // ── Help overlay ────────────────────────────────────────
  if (state.mode === 'help') {
    return (
      <Box flexDirection="column" width={dims.cols} height={dims.rows}>
        <HelpOverlay width={dims.cols} height={dims.rows} helpIndex={state.helpIndex} skillsData={skillsData} commandUsage={commandUsage} />
      </Box>
    );
  }

  // ── Main split-pane layout ──────────────────────────────
  return (
    <Box flexDirection="column" width={dims.cols} height={dims.rows}>
      {/* Header */}
      <Box width={dims.cols} paddingX={1} justifyContent="space-between">
        <Text>
          <Text color={INK_COLORS.accent}>▄</Text><Text color="#e6963c">▀</Text><Text color={INK_COLORS.accent} backgroundColor="#e6963c">▄</Text><Text color="#e6963c">▀</Text><Text color={INK_COLORS.accent}>▄</Text>
          {'  '}<Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text>
        </Text>
        <Box>
          {liveSessionCount > 0 && (
            <Text>
              <Text color={INK_COLORS.green} bold>● </Text>
              <Text color={INK_COLORS.text}>{liveSessionCount} live</Text>
              <Text color={INK_COLORS.textDim}>  </Text>
            </Text>
          )}
          <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
        </Box>
      </Box>

      {/* Main body: two panes side by side */}
      <Box flexDirection="row" height={bodyHeight}>
        <ProjectPane
          projects={filteredProjects}
          selectedIndex={state.selectedIndex}
          width={leftWidth}
          height={bodyHeight}
          gitStatuses={gitStatuses}
          issueCounts={issueCounts}
          focused={state.focusPane === 'projects'}
          filterText={state.mode === 'filter' ? state.filterText : undefined}
          activeProcesses={enrichedProcesses}
          usageHistory={allUsageHistory}
          dailyBudget={state.config.daily_budget_tokens}
          usageStats={usageStats}
          skillsData={skillsData}
          commandUsage={commandUsage}
        />
        <DetailPane
          project={selectedProject}
          width={rightWidth}
          height={bodyHeight}
          gitStatus={selectedProject ? gitStatuses.get(selectedProject.path) : undefined}
          sessions={displaySnapshot.sessions}
          issues={displaySnapshot.issues}
          focused={state.focusPane === 'details'}
          selectedSessionIndex={state.detailSection === 'sessions' ? state.detailIndex : undefined}
          detailSection={state.detailSection}
          selectedIssueIndex={state.detailSection === 'issues' ? state.detailIndex : undefined}
          selectedCommitIndex={state.detailSection === 'commits' ? state.detailIndex : undefined}
          commits={displaySnapshot.commits}
          activeProcess={selectedProject ? enrichedProcesses.get(selectedProject.path) : undefined}
          sessionActivity={sessionActivity}
          usageHistory={displaySnapshot.usageHistory}
          commitActivity={displaySnapshot.commitActivity}
        />
      </Box>

      {/* Filter bar / Prompt bar (mutually exclusive) */}
      <FilterBar
        visible={state.mode === 'filter'}
        text={state.filterText}
        resultCount={filteredProjects.length}
      />
      <PromptBar
        visible={state.mode === 'prompt'}
        text={state.promptText}
        projectName={selectedProject?.name}
      />

      {/* Status bar — always mounted to avoid layout shifts from conditional rendering */}
      <StatusBar
        mode={state.mode}
        stats={usageStats}
        width={dims.cols}
        focusPane={state.focusPane}
        launchMsg={launchMsg}
        dailyBudget={state.config.daily_budget_tokens}
      />
    </Box>
  );
}

/**
 * Render the TUI app with alternate screen buffer.
 */
export async function renderApp(): Promise<void> {
  // Enter alternate screen buffer
  process.stdout.write('\x1b[?1049h');

  const instance = render(<App />, {
    exitOnCtrlC: true,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    // Exit alternate screen buffer
    process.stdout.write('\x1b[?1049l');
  }
}
