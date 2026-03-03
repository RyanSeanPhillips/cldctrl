/**
 * Root TUI component: split-pane layout, focus management, alternate screen buffer.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { render, Box, Text, useStdout } from 'ink';
import { useAppState } from './hooks/useAppState.js';
import { useGitStatuses, useIssues, useUsageStats } from './hooks/useBackgroundData.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { getRecentSessions } from '../core/sessions.js';
import { ProjectPane } from './components/ProjectPane.js';
import { DetailPane } from './components/DetailPane.js';
import { FilterBar } from './components/FilterBar.js';
import { StatusBar } from './components/StatusBar.js';
import { Welcome } from './components/Welcome.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { DEFAULTS, INK_COLORS, APP_NAME, VERSION } from '../constants.js';
import type { Session } from '../types.js';

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

  // Selected project
  const selectedProject = filteredProjects[state.selectedIndex];

  // Background data
  const leftWidth = Math.floor(dims.cols * DEFAULTS.leftPaneWidth);
  const rightWidth = dims.cols - leftWidth;
  const bodyHeight = dims.rows - 4; // header + filter bar + status bar + 1

  const viewportHeight = Math.max(1, bodyHeight - 2);
  const visibleStart = Math.max(0, state.selectedIndex - viewportHeight);
  const visibleEnd = Math.min(filteredProjects.length - 1, visibleStart + viewportHeight);

  const gitStatuses = useGitStatuses(filteredProjects, visibleStart, visibleEnd);
  const issues = useIssues(selectedProject?.path ?? null);
  const usageStats = useUsageStats();

  // Issue counts per project (for badges)
  const issueCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (selectedProject && issues) {
      map.set(selectedProject.path, issues.length);
    }
    return map;
  }, [selectedProject, issues]);

  // Launch feedback message (auto-clears after 3s)
  const [launchMsg, setLaunchMsg] = useState<string>('');
  const onLaunchFeedback = useCallback((msg: string) => {
    setLaunchMsg(msg);
    setTimeout(() => setLaunchMsg(''), 3000);
  }, []);

  // Recent sessions for selected project
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    if (!selectedProject) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    getRecentSessions(selectedProject.path, 30).then((s) => {
      if (!cancelled) setSessions(s);
    });
    return () => { cancelled = true; };
  }, [selectedProject?.path]);

  // Stable state ref for keyboard handler (avoids new object per render)
  const keyboardState = useMemo(
    () => ({ ...state, projects: filteredProjects }),
    [state, filteredProjects]
  );

  // Keyboard handling
  useKeyboard({
    state: keyboardState,
    dispatch,
    viewportHeight,
    filteredProjects,
    selectedProject,
    recentSessions: sessions,
    issues: issues ?? [],
    onLaunchFeedback,
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

  // ── Welcome screen ──────────────────────────────────────
  if (state.mode === 'welcome') {
    return <Welcome />;
  }

  // ── Help overlay ────────────────────────────────────────
  if (state.mode === 'help') {
    return (
      <Box flexDirection="column" width={dims.cols} height={dims.rows}>
        <HelpOverlay width={dims.cols} height={dims.rows} />
      </Box>
    );
  }

  // ── Main split-pane layout ──────────────────────────────
  return (
    <Box flexDirection="column" width={dims.cols} height={dims.rows}>
      {/* Header */}
      <Box width={dims.cols} paddingX={1} justifyContent="space-between">
        <Text><Text color={INK_COLORS.accent}>▄</Text><Text color="#e6963c">█</Text><Text color={INK_COLORS.blue}>●</Text><Text color="#e6963c">█</Text><Text color={INK_COLORS.accent}>▄</Text>  <Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text></Text>
        <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
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
        />
        <DetailPane
          project={selectedProject}
          width={rightWidth}
          height={bodyHeight}
          gitStatus={selectedProject ? gitStatuses.get(selectedProject.path) : undefined}
          sessions={sessions}
          issues={issues ?? []}
          focused={state.focusPane === 'details'}
          selectedSessionIndex={state.detailSection === 'sessions' ? state.detailIndex : undefined}
          detailSection={state.detailSection}
          selectedIssueIndex={state.detailSection === 'issues' ? state.detailIndex : undefined}
        />
      </Box>

      {/* Filter bar */}
      <FilterBar
        visible={state.mode === 'filter'}
        text={state.filterText}
        resultCount={filteredProjects.length}
      />

      {/* Launch feedback */}
      {launchMsg ? (
        <Box width={dims.cols} paddingX={1}>
          <Text color={INK_COLORS.green}>{launchMsg}</Text>
        </Box>
      ) : (
        /* Status bar */
        <StatusBar
          mode={state.mode}
          stats={usageStats}
          width={dims.cols}
          focusPane={state.focusPane}
        />
      )}
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
