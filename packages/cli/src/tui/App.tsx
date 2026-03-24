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
  useUsageBudget,
  useClaudeTier,
  useActiveProcesses,
  useRecentCommits,
  useCommitActivity,
  useUsageHistory,
  useSessionActivity,
  useLiveSession,
  useAutoSummarize,
  useCommandUsage,
  useSessionTasks,
  useWindowedUsageStats,
} from './hooks/useBackgroundData.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useFileTree } from './hooks/useFileTree.js';
import { getRecentSessionsWithChildren } from '../core/sessions.js';
import { buildProjectList, extractProjectName, getProjectSlug } from '../core/projects.js';
import { normalizePathForCompare } from '../core/platform.js';
import { scanForProjects, mergeScannedProjects } from '../core/scanner.js';
import { mergeIntoIndex, getLastScanTime } from '../core/project-index.js';
import { readDaemonCache } from '../core/background.js';
import { isDemoMode, demoSessions, demoIssueCounts, DEMO_SKILLS_DATA } from '../core/demo-data.js';
import { ProjectPane } from './components/ProjectPane.js';
import { DetailPane } from './components/DetailPane.js';
import { ConversationDetail } from './components/ConversationDetail.js';
import { FilterBar } from './components/FilterBar.js';
import { PromptBar } from './components/PromptBar.js';
import { StatusBar } from './components/StatusBar.js';
import { Welcome } from './components/Welcome.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { SettingsPane } from './components/SettingsPane.js';
import { MatrixGlitch, useMatrixGlitch } from './components/MatrixGlitch.js';
import { useClock, usePulse } from './hooks/useAnimations.js';

/** Tiny component: 1s re-render scoped to clock text only */
const ClockDisplay = React.memo(function ClockDisplay() {
  const clock = useClock();
  return <Text color={INK_COLORS.textDim}>{clock}  v{VERSION}</Text>;
});
import { GameScreen } from './games/GameScreen.js';
import { isFeatureEnabled } from '../config.js';
import { focusWindowByTitle } from '../core/platform.js';
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

export function App() {
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


  // Background refresh: run full project list (with git name extraction)
  // after initial fast paint, then update state once
  useEffect(() => {
    if (isDemoMode()) return;
    let cancelled = false;
    // Use setTimeout to defer past first render cycle
    const timer = setTimeout(() => {
      if (cancelled) return;
      const full = buildProjectList(state.config);
      dispatch({ type: 'SET_PROJECTS', projects: full });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Skills/commands discovery (deferred — sync FS reads, not needed for first paint)
  const [skillsData, setSkillsData] = useState(() =>
    isDemoMode() ? DEMO_SKILLS_DATA : { commands: [] as any[], skills: [] as any[] }
  );
  useEffect(() => {
    if (isDemoMode()) return;
    const timer = setTimeout(() => setSkillsData(getSkillsSummary()), 2000);
    return () => clearTimeout(timer);
  }, []);

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

  // Layout: single-pane mode for narrow terminals
  const narrowMode = dims.cols < 80;
  const leftWidth = narrowMode ? dims.cols - 1 : Math.floor(dims.cols * DEFAULTS.leftPaneWidth);
  const rightWidth = narrowMode ? dims.cols - 1 : dims.cols - leftWidth;
  const showLeft = !narrowMode || state.focusPane === 'projects';
  const showRight = !narrowMode || state.focusPane === 'details';
  const bodyHeight = dims.rows - 4; // header + filter bar + status bar + 1

  const viewportHeight = Math.max(1, bodyHeight - 2);
  const visibleStart = Math.max(0, state.selectedIndex - viewportHeight);
  const visibleEnd = Math.min(filteredProjects.length - 1, visibleStart + viewportHeight);

  const gitStatuses = useGitStatuses(filteredProjects, visibleStart, visibleEnd);
  const issues = useIssues(settledPath);
  const windowedUsage = useWindowedUsageStats();
  const cachedUsageStats = useUsageStats(); // daemon cache fallback (always called)
  const usageStats = windowedUsage?.fiveHour ?? cachedUsageStats;
  const usageBudget = useUsageBudget(usageStats, state.config.daily_budget_tokens, windowedUsage);

  // New hooks — use settledPath for expensive per-project data fetching
  const { map: activeProcesses, allSessions, totalCount: totalSessionCount } = useActiveProcesses(filteredProjects, state.config.hidden_projects);
  const liveSessionCount = useMemo(() => allSessions.filter(s => !s.idle).length, [allSessions]);
  const commits = useRecentCommits(settledPath);
  const commitActivity = useCommitActivity(settledPath);
  const usageHistory = useUsageHistory();
  const commandUsage = useCommandUsage();

  // Live session tailing for the settled project
  const liveTailingEnabled = isFeatureEnabled(state.config, 'live_session_tailing');
  const selectedActive = settledProject ? activeProcesses.get(settledProject.path) : undefined;
  const liveSession = useLiveSession(
    settledPath,
    liveTailingEnabled && !!selectedActive,
  );

  // Merge live tailing data into activeProcesses for display
  // Uses settledProject (not selectedProject) to avoid creating new Map refs on every scroll
  const enrichedProcesses = useMemo(() => {
    if (!liveSession || !settledProject) return activeProcesses;
    const existing = activeProcesses.get(settledProject.path);
    if (!existing) return activeProcesses;

    // Keep the filename-based sessionId (matches session list IDs).
    // The tailer's sessionId is the internal UUID from JSONL content, which differs.
    const newSessionId = existing.sessionId;
    // Skip allocation if nothing meaningful changed (compare values, not refs)
    if (existing.currentAction === liveSession.currentAction
      && existing.sessionId === newSessionId
      && existing.stats.tokens === liveSession.activity.tokens
      && existing.stats.messages === liveSession.activity.messages
      && existing.stats.toolCalls.writes === liveSession.activity.toolCalls.writes
      && existing.stats.toolCalls.reads === liveSession.activity.toolCalls.reads
      && existing.stats.toolCalls.bash === liveSession.activity.toolCalls.bash) {
      return activeProcesses;
    }

    const enriched = new Map(activeProcesses);
    enriched.set(settledProject.path, {
      ...existing,
      stats: liveSession.activity,
      currentAction: liveSession.currentAction,
      sessionId: newSessionId,
      roundSummaries: liveSession.roundSummaries,
    });
    return enriched;
  }, [activeProcesses, liveSession, settledProject]);

  // Auto-add projects when a new active session appears for an unknown path.
  // This ensures projects launched outside cldctrl show up in real-time.
  // Also auto-unhides hidden projects that have active sessions.
  // Uses projectsRef to avoid stale closure over state.projects.
  useEffect(() => {
    if (isDemoMode() || allSessions.length === 0) return;
    const currentProjects = projectsRef.current;
    const knownPaths = new Set(currentProjects.map(p => normalizePathForCompare(p.path)));
    const hiddenSet = new Set(configRef.current.hidden_projects.map(p => normalizePathForCompare(p)));
    const newProjects: typeof currentProjects = [];
    const unhidePaths: string[] = [];
    for (const s of allSessions) {
      const key = normalizePathForCompare(s.projectPath);
      // Auto-unhide: active session for a hidden project
      if (hiddenSet.has(key)) {
        unhidePaths.push(s.projectPath);
        hiddenSet.delete(key); // avoid duplicates
      }
      if (knownPaths.has(key)) continue;
      knownPaths.add(key); // avoid duplicates within the batch
      let name: string;
      try { name = extractProjectName(s.projectPath); } catch { name = s.projectPath.split(/[/\\]/).pop() ?? ''; }
      newProjects.push({
        name,
        path: s.projectPath,
        slug: getProjectSlug(s.projectPath),
        pinned: false,
        discovered: true,
      });
    }
    if (unhidePaths.length > 0) {
      dispatch({ type: 'UNHIDE_PATHS', paths: unhidePaths });
    }
    if (newProjects.length > 0) {
      dispatch({ type: 'SET_PROJECTS', projects: [...currentProjects, ...newProjects] });
    }
  }, [allSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Issue counts per project (for badges) — accumulates across selections
  const [issueCounts, setIssueCounts] = useState(() =>
    isDemoMode() ? demoIssueCounts() : new Map<string, number>()
  );
  useEffect(() => {
    if (isDemoMode()) return;
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
  const { revision: summaryRevision, isSummarizing } = useAutoSummarize(state.projects, settledPath, issues);

  // Pinned project paths — child subfolders that are pinned stay standalone
  const pinnedPaths = useMemo(
    () => new Set(state.config.projects.map(p => normalizePathForCompare(p.path))),
    [state.config.projects],
  );

  // Recent sessions for settled project (re-fetches when summaries are generated)
  // Uses merged sessions: parent + child subfolder sessions in one chronological list
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    if (isDemoMode()) {
      setSessions(settledPath ? demoSessions(settledPath) : []);
      return;
    }
    if (!settledPath) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    getRecentSessionsWithChildren(settledPath, 30, pinnedPaths).then((s) => {
      if (!cancelled) setSessions(s);
    });
    return () => { cancelled = true; };
  }, [settledPath, summaryRevision, pinnedPaths]);

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

  // Read daemon commit activity once on mount (avoids sync file I/O inside useMemo)
  const [daemonCommitActivity] = useState(() => {
    try { return readDaemonCache()?.commitActivity; } catch { return undefined; }
  });

  // Aggregate usage history into a flat array for left pane calendar
  const allUsageHistory = useMemo(() => {
    const dailyMap = new Map<string, DailyUsage>();
    // Merge session usage (tokens/messages)
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
    // Merge commit activity (additions/deletions/commits) from daemon cache
    if (daemonCommitActivity) {
      for (const days of Object.values(daemonCommitActivity)) {
        for (const day of days) {
          const existing = dailyMap.get(day.date);
          if (existing) {
            existing.commits = (existing.commits ?? 0) + (day.commits ?? 0);
            existing.additions = (existing.additions ?? 0) + (day.additions ?? 0);
            existing.deletions = (existing.deletions ?? 0) + (day.deletions ?? 0);
          } else {
            dailyMap.set(day.date, { ...day });
          }
        }
      }
    }
    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [usageHistory, daemonCommitActivity]);

  // File tree for settled project
  const fileTree = useFileTree(settledPath);
  const filePreview = useMemo(
    () => state.detailSection === 'files' ? fileTree.getPreview(state.detailIndex) : null,
    [state.detailSection, state.detailIndex, fileTree],
  );

  // Stable refs for values used in callbacks (avoids recreating callbacks on every state change)
  const projectsRef = useRef(state.projects);
  projectsRef.current = state.projects;
  const configRef = useRef(state.config);
  configRef.current = state.config;
  const detailIndexRef = useRef(state.detailIndex);
  detailIndexRef.current = state.detailIndex;
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  // Stable file tree callbacks (never change identity)
  const onFileExpand = useCallback(() => fileTreeRef.current.expand(detailIndexRef.current), []);
  const onFileCollapse = useCallback(() => fileTreeRef.current.collapse(detailIndexRef.current), []);
  const onFileOpen = useCallback(() => fileTreeRef.current.openFile(detailIndexRef.current), []);

  // Project scanner
  const scanControllerRef = useRef<AbortController | null>(null);
  const startScan = useCallback(() => {
    if (isDemoMode()) return;
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    dispatch({ type: 'SCAN_START' });
    onLaunchFeedback('Scanning for projects...');

    // Run scan in a microtask to not block render
    Promise.resolve().then(() => {
      try {
        const results = scanForProjects({ signal: controller.signal });
        if (!controller.signal.aborted) {
          // Persist scan results to the project index
          mergeIntoIndex(results);
          const merged = mergeScannedProjects(projectsRef.current, results, configRef.current);
          dispatch({ type: 'SCAN_COMPLETE', projects: merged });
          const newCount = merged.length - projectsRef.current.length;
          onLaunchFeedback(newCount > 0 ? `Found ${newCount} new project${newCount === 1 ? '' : 's'}` : 'No new projects found');
        }
      } catch {
        dispatch({ type: 'SCAN_CANCEL' });
      }
    });
  }, [dispatch, onLaunchFeedback]);

  // Auto-scan on first run (no previous index exists)
  const autoScannedRef = useRef(false);
  useEffect(() => {
    if (isDemoMode() || autoScannedRef.current) return;
    autoScannedRef.current = true;
    if (!getLastScanTime()) {
      // Defer to let first paint complete
      const timer = setTimeout(() => startScan(), 1000);
      return () => clearTimeout(timer);
    }
  }, [startScan]);

  // Sorted conversations — ALL active sessions (not deduplicated by project).
  // Enriches the settled project's map-winner with live-tailed stats.
  const sortedConversations = useMemo(() => {
    const mapWinner = settledProject ? enrichedProcesses.get(settledProject.path) : undefined;
    const enriched = allSessions.map(s => {
      // Replace the session that matches the map winner with enriched version.
      // Match on sessionId (not pid — mtime-detected sessions all have pid=0)
      if (mapWinner && s.sessionId === mapWinner.sessionId && s.projectPath === mapWinner.projectPath) {
        return mapWinner;
      }
      return s;
    });
    // Sort: active first, then by most recent activity
    return enriched.sort((a, b) => {
      const aIdle = a.idle ? 1 : 0;
      const bIdle = b.idle ? 1 : 0;
      if (aIdle !== bIdle) return aIdle - bIdle; // active before idle
      return b.lastActivity.getTime() - a.lastActivity.getTime(); // most recent first
    });
  }, [allSessions, enrichedProcesses, settledProject]);

  // Live tasks/todos for expanded conversation
  const expandedSession = state.expandedConversation
    ? sortedConversations[state.conversationIndex]
    : null;
  const sessionTasks = useSessionTasks(
    expandedSession?.sessionId ?? null,
    state.expandedConversation,
  );

  // Focus a conversation's terminal window
  const onFocusConversation = useCallback(() => {
    const sorted = sortedConversations;
    const session = sorted[state.conversationIndex];
    if (!session) return;
    const name = session.projectPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    // Try multiple title patterns: "CLD | name" (launched from cc) or just the project name
    const focused = focusWindowByTitle(`CLD | ${name}`) || focusWindowByTitle(name);
    onLaunchFeedback(focused ? `Focused: ${name}` : `Could not focus window for ${name}`);
  }, [sortedConversations, state.conversationIndex, onLaunchFeedback]);

  // Animations (clock extracted to ClockDisplay component to avoid full-tree re-renders)
  const pulse = usePulse(800);
  const matrixGlitch = useMatrixGlitch();

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
    fileTreeNodeCount: fileTree.flatNodes.length,
    fileTreeNodes: fileTree.flatNodes,
    onFileExpand,
    onFileCollapse,
    onFileOpen,
    onStartScan: startScan,
    conversationCount: sortedConversations.length,
    onFocusConversation: onFocusConversation,
  });

  // ── Minimum terminal size guard ──────────────────────────
  if (dims.cols < 40 || dims.rows < 10) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={INK_COLORS.yellow}>
          Terminal too small ({dims.cols}x{dims.rows}). Need at least 40x10.
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

  // ── Settings editor ─────────────────────────────────────
  if (state.mode === 'settings') {
    return (
      <Box flexDirection="column" width={dims.cols} height={dims.rows}>
        <SettingsPane
          config={state.config}
          selectedIndex={state.settingsIndex}
          width={dims.cols}
          height={dims.rows}
          onConfigChange={(c) => dispatch({ type: 'SET_CONFIG', config: c })}
          settingsTab={state.settingsTab}
          permissionsIndex={state.permissionsIndex}
        />
      </Box>
    );
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
          {totalSessionCount > 0 && (
            <Text>
              <Text color={pulse ? INK_COLORS.green : INK_COLORS.textDim} bold>● </Text>
              {liveSessionCount > 0 && <Text color={INK_COLORS.text}>{liveSessionCount} live</Text>}
              {liveSessionCount > 0 && totalSessionCount > liveSessionCount && <Text color={INK_COLORS.textDim}> · </Text>}
              {totalSessionCount > liveSessionCount && <Text color={INK_COLORS.textDim}>{totalSessionCount - liveSessionCount} idle</Text>}
              <Text color={INK_COLORS.textDim}>  </Text>
            </Text>
          )}
          <ClockDisplay />
        </Box>
      </Box>

      {/* Main body: two panes side by side (single pane in narrow mode) */}
      <Box flexDirection="row" height={bodyHeight}>
        {showLeft && (
          <ProjectPane
            projects={filteredProjects}
            selectedIndex={state.selectedIndex}
            width={leftWidth}
            height={bodyHeight}
            gitStatuses={gitStatuses}
            issueCounts={issueCounts}
            focused={narrowMode || state.focusPane === 'projects'}
            filterText={state.mode === 'filter' ? state.filterText : undefined}
            activeProcesses={enrichedProcesses}
            usageHistory={allUsageHistory}
            usageStats={usageStats}
            usageBudget={usageBudget}
            skillsData={skillsData}
            commandUsage={commandUsage}
            config={state.config}
            conversations={sortedConversations}
            conversationIndex={state.conversationIndex}
            leftSection={state.leftSection}
          />
        )}
        {showRight && (state.leftSection === 'conversations' ? (
          <ConversationDetail
            conversations={sortedConversations}
            selectedIndex={state.conversationIndex}
            expanded={state.expandedConversation}
            width={rightWidth}
            height={bodyHeight}
            usageBudget={usageBudget}
            sessionTasks={sessionTasks}
          />
        ) : (
          <DetailPane
            project={selectedProject}
            width={rightWidth}
            height={bodyHeight}
            gitStatus={selectedProject ? gitStatuses.get(selectedProject.path) : undefined}
            sessions={displaySnapshot.sessions}
            issues={displaySnapshot.issues}
            focused={narrowMode || state.focusPane === 'details'}
            selectedSessionIndex={state.detailSection === 'sessions' ? state.detailIndex : undefined}
            detailSection={state.detailSection}
            selectedIssueIndex={state.detailSection === 'issues' ? state.detailIndex : undefined}
            selectedCommitIndex={state.detailSection === 'commits' ? state.detailIndex : undefined}
            commits={displaySnapshot.commits}
            activeProcess={selectedProject ? enrichedProcesses.get(selectedProject.path) : undefined}
            sessionActivity={sessionActivity}
            usageHistory={displaySnapshot.usageHistory}
            commitActivity={displaySnapshot.commitActivity}
            isSummarizing={isSummarizing}
            fileTreeNodes={fileTree.flatNodes}
            filePreview={filePreview}
            selectedFileIndex={state.detailSection === 'files' ? state.detailIndex : undefined}
            config={state.config}
          />
        ))}
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
        usageBudget={usageBudget}
        scanning={state.scanning}
        leftPaneMode={state.leftSection}
      />

      {/* Matrix glitch Easter egg — rare, brief, subtle */}
      <MatrixGlitch width={dims.cols} height={dims.rows} active={matrixGlitch} />
    </Box>
  );
}

/**
 * Render the TUI app with alternate screen buffer.
 */
export async function renderApp(): Promise<void> {
  const { isSafeMode } = await import('../core/platform.js');
  let disableDiff: (() => void) | null = null;

  // Enable differential rendering FIRST — it patches stdout.write and
  // detects \x1b[?1049h to activate. Writing alt screen before the patch
  // means the diff renderer never sees it, stays inactive, and all Ink
  // writes pass through raw → flicker.
  // Safe mode skips this entirely — Ink renders directly (more flicker, zero corruption).
  if (!isSafeMode()) {
    const { enableDiffRendering } = await import('./diffRenderer.js');
    disableDiff = enableDiffRendering();
  }

  // Now set tab title and enter alternate screen through the patched write
  // so the diff renderer detects alt screen entry and activates.
  process.stdout.write('\x1b]0;CLD CTRL\x07');
  process.stdout.write('\x1b[?1049h');

  // Terminal cleanup: discard buffered frames, show cursor, exit alt screen, reset attrs
  function cleanupTerminal() {
    try {
      disableDiff?.(); // discards pending buffer so it doesn't dump onto normal screen
      process.stdout.write(
        '\x1b[?25h'    // show cursor
        + '\x1b[?1049l' // exit alternate screen buffer (restores previous screen)
        + '\x1b]0;\x07' // reset window title
        + '\x1b[0m'     // reset text attributes
        + '\n'           // newline so shell prompt appears cleanly
      );
    } catch { /* stdout may be closed */ }
  }

  // Safety net: clean up on unexpected termination
  process.on('exit', cleanupTerminal);

  const instance = render(<App />, {
    exitOnCtrlC: true,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    process.off('exit', cleanupTerminal);
    cleanupTerminal();
  }
}
