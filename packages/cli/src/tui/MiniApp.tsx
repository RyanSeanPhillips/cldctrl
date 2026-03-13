/**
 * Mini TUI: fast 3-phase wizard for quick project launching.
 * `cc --mini` or Ctrl+Up hotkey. Reads daemon cache for instant first paint.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { render, Box, Text, useStdout } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useMiniState } from './hooks/useMiniState.js';
import { useMiniKeyboard } from './hooks/useMiniKeyboard.js';
import { getRecentSessions } from '../core/sessions.js';
import { isDemoMode, demoSessions } from '../core/demo-data.js';
import { MiniProjectList } from './components/MiniProjectList.js';
import { MiniActionMenu, MiniSessionList, buildActions } from './components/MiniActionMenu.js';
import { PromptBar } from './components/PromptBar.js';
import { INK_COLORS, CHARS, APP_NAME, VERSION } from '../constants.js';
import type { Session } from '../types.js';

const popupId = process.env.CLDCTRL_POPUP_ID ?? 'default';
const READY_SIGNAL_PATH = path.join(os.tmpdir(), `cldctrl-ready-${popupId}`);

// Performance timing (injected by mini-entry.ts)
const mark: ((label: string) => void) = (globalThis as any).__cldctrl_mark ?? (() => {});
const writeTimings: (() => void) = (globalThis as any).__cldctrl_writeTimings ?? (() => {});

const EMPTY_SESSIONS: Session[] = [];

// Mini TUI target dimensions
const MINI_COLS = 48;
const MINI_MAX_ROWS = 22;

// Rocket logo color
const ROCKET_BODY = '#e6963c';

/**
 * Resolve the "expand to full TUI" callback.
 * Set externally by renderMiniApp to allow unmount + remount as full TUI.
 */
let expandToFullCallback: (() => void) | null = null;

function MiniApp() {
  mark('MiniApp render start');
  const { state, dispatch } = useMiniState();
  mark('useMiniState done');
  const { stdout } = useStdout();
  const [dims, setDims] = useState({
    cols: Math.max(stdout?.columns ?? 0, MINI_COLS),
    rows: Math.max(stdout?.rows ?? 0, 20),
  });

  useEffect(() => {
    const onResize = () => {
      if (stdout) {
        const newCols = Math.max(stdout.columns, MINI_COLS);
        const newRows = Math.max(stdout.rows, 10);
        setDims(prev => (prev.cols === newCols && prev.rows === newRows) ? prev : { cols: newCols, rows: newRows });
      }
    };
    stdout?.on('resize', onResize);
    return () => { stdout?.off('resize', onResize); };
  }, [stdout]);

  // Write ready signal so hotkey.ps1 knows we've rendered
  useEffect(() => {
    mark('first render (ready signal)');
    writeTimings();
    try { fs.writeFileSync(READY_SIGNAL_PATH, String(process.pid)); } catch {}
    return () => { try { fs.unlinkSync(READY_SIGNAL_PATH); } catch {} };
  }, []);

  // Resize terminal to fit content (ANSI xterm window manipulation)
  // \x1b[8;rows;colst resizes the terminal — works in Windows Terminal, xterm, etc.
  useEffect(() => {
    const listLen = state.projects.length;
    // header(1) + separator(1) + projects(N, capped) + separator(1) + hints(1) + border(2) + 1 buffer
    const targetRows = Math.min(MINI_MAX_ROWS, listLen + 8);
    process.stdout.write(`\x1b[8;${targetRows};${MINI_COLS}t`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter projects
  const filteredProjects = useMemo(() => {
    if (!state.filterText) return state.projects;
    const lower = state.filterText.toLowerCase();
    return state.projects.filter(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.path.toLowerCase().includes(lower),
    );
  }, [state.projects, state.filterText]);

  // In projects phase, selectedIndex IS the project index.
  // In other phases, resolve the persisted selectedProjectPath from the full list.
  const selectedProject = state.phase === 'projects'
    ? filteredProjects[state.selectedIndex]
    : state.selectedProjectPath
      ? state.projects.find(p => p.path === state.selectedProjectPath)
      : undefined;

  // When returning to projects phase, scroll to the previously-selected project
  useEffect(() => {
    if (state.phase === 'projects' && state.selectedProjectPath) {
      const idx = filteredProjects.findIndex(p => p.path === state.selectedProjectPath);
      if (idx >= 0 && idx !== state.selectedIndex) {
        dispatch({ type: 'SELECT_INDEX', index: idx });
      }
    }
  }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sessions for selected project (async, lightweight)
  const [sessions, setSessions] = useState<Session[]>(EMPTY_SESSIONS);
  useEffect(() => {
    if (isDemoMode()) {
      setSessions(selectedProject ? demoSessions(selectedProject.path) : EMPTY_SESSIONS);
      return;
    }
    if (!selectedProject || (state.phase !== 'actions' && state.phase !== 'sessions')) {
      setSessions(EMPTY_SESSIONS);
      return;
    }
    let cancelled = false;
    getRecentSessions(selectedProject.path, 10).then((s) => {
      if (!cancelled) setSessions(s);
    });
    return () => { cancelled = true; };
  }, [selectedProject?.path, state.phase]);

  // Build action items
  const actions = useMemo(
    () => buildActions(sessions.length),
    [sessions.length],
  );

  // Expand to full TUI
  const onExpandFull = useCallback(() => {
    expandToFullCallback?.();
  }, []);

  // Keyboard handling
  useMiniKeyboard({
    state,
    dispatch,
    filteredProjects,
    selectedProject,
    actions,
    sessions,
    onExpandFull,
  });

  // Layout
  const width = Math.min(dims.cols, MINI_COLS);
  // Reserve rows for: border top(1) + header(1) + separator(1) + separator(1) + hints(1) + border bottom(1) = 6
  const bodyHeight = Math.max(4, dims.rows - 6);

  // Phase-dependent hints
  const hints = (() => {
    if (state.mode === 'filter') return 'Type to filter | Esc:cancel';
    if (state.mode === 'prompt') return 'Type prompt | Enter:launch | Esc:cancel';
    switch (state.phase) {
      case 'projects': return `${CHARS.arrow_up}${CHARS.arrow_down} nav  \u23CE launch  \u2192 more  / filter`;
      case 'actions': return `${CHARS.arrow_up}${CHARS.arrow_down} nav  ${CHARS.pointer} select  ← back`;
      case 'sessions': return `${CHARS.arrow_up}${CHARS.arrow_down} nav  ${CHARS.pointer} resume  ← back`;
    }
  })();

  return (
    <Box flexDirection="column" width={width}>
      {/* Frame */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={INK_COLORS.border}
        width={width}
      >
        {/* Header */}
        <Box paddingX={1} justifyContent="space-between">
          <Text>
            <Text color={INK_COLORS.accent}>▄</Text><Text color={ROCKET_BODY}>▀</Text><Text color={INK_COLORS.accent} backgroundColor={ROCKET_BODY}>▄</Text><Text color={ROCKET_BODY}>▀</Text><Text color={INK_COLORS.accent}>▄</Text>
            {'  '}<Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text>
          </Text>
          <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
        </Box>

        {/* Separator */}
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>
            {CHARS.separator.repeat(Math.max(1, width - 4))}
          </Text>
        </Box>

        {/* Phase content */}
        <Box flexDirection="column" height={bodyHeight}>
          {state.phase === 'projects' && (
            <MiniProjectList
              projects={filteredProjects}
              selectedIndex={state.selectedIndex}
              width={width - 2}
              height={bodyHeight}
              filterText={state.mode === 'filter' ? state.filterText : undefined}
            />
          )}

          {state.phase === 'actions' && selectedProject && (
            <MiniActionMenu
              projectName={selectedProject.name}
              actions={actions}
              selectedIndex={state.selectedIndex}
              width={width - 2}
            />
          )}

          {state.phase === 'sessions' && selectedProject && (
            <MiniSessionList
              projectName={selectedProject.name}
              sessions={sessions}
              selectedIndex={state.selectedIndex}
              width={width - 2}
            />
          )}

        </Box>

        {/* Prompt bar (shown in prompt mode) */}
        {state.mode === 'prompt' && (
          <PromptBar
            visible={true}
            text={state.promptText}
            projectName={selectedProject?.name}
          />
        )}

        {/* Separator */}
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>
            {CHARS.separator.repeat(Math.max(1, width - 4))}
          </Text>
        </Box>

        {/* Hints */}
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{hints}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Render the mini TUI with alternate screen buffer.
 */
export async function renderMiniApp(): Promise<void> {
  // No alternate screen buffer — popup window is destroyed on exit anyway,
  // and entering alt screen causes a visible "all black" flash before content renders.

  let instance: ReturnType<typeof render>;

  // Set up expand-to-full callback
  expandToFullCallback = async () => {
    instance.unmount();
    const { renderApp } = await import('./App.js');
    await renderApp();
  };

  // Clean up ready signal on orphan/termination signals
  const cleanup = () => {
    try { fs.unlinkSync(READY_SIGNAL_PATH); } catch {}
    process.exit(0);
  };
  process.on('SIGHUP', cleanup);
  process.on('SIGTERM', cleanup);

  instance = render(<MiniApp />, { exitOnCtrlC: true });

  try {
    await instance.waitUntilExit();
  } finally {
    // Clean up ready signal
    try { fs.unlinkSync(READY_SIGNAL_PATH); } catch {}
    process.removeListener('SIGHUP', cleanup);
    process.removeListener('SIGTERM', cleanup);
  }
}
