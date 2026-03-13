/**
 * Mini TUI keyboard: phase-aware navigation.
 * Left/Right to drill in/out, Up/Down to move within lists.
 * Enter launches directly from projects phase; Right arrow drills into actions.
 */

import { useInput, useApp } from 'ink';
import { openVSCode, launchAndTrack } from '../../core/launcher.js';
import { openInExplorer } from '../../core/platform.js';
import type { Project, Session } from '../../types.js';
import type { MiniState, MiniDispatch } from './useMiniState.js';
import type { ActionItem } from '../components/MiniActionMenu.js';

interface UseMiniKeyboardOptions {
  state: MiniState;
  dispatch: MiniDispatch;
  filteredProjects: Project[];
  selectedProject: Project | undefined;
  actions: ActionItem[];
  sessions: Session[];
  onExpandFull?: () => void;
}

export function useMiniKeyboard(opts: UseMiniKeyboardOptions): void {
  const {
    state, dispatch, filteredProjects, selectedProject,
    actions, sessions,
    onExpandFull,
  } = opts;
  const { exit } = useApp();

  const maxIndex = (() => {
    switch (state.phase) {
      case 'projects': return Math.max(0, filteredProjects.length - 1);
      case 'actions': return Math.max(0, actions.length - 1);
      case 'sessions': return Math.max(0, sessions.length - 1);
    }
  })();

  useInput((input, key) => {
    // ── Prompt mode ──────────────────────────────────────
    if (state.mode === 'prompt') {
      if (key.escape) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.return) {
        if (selectedProject) {
          const prompt = state.promptText.trim();
          launchAndTrack({
            projectPath: selectedProject.path,
            isNew: true,
            prompt: prompt || undefined,
          });
          exit();
        }
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'SET_PROMPT', text: state.promptText.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'SET_PROMPT', text: state.promptText + input });
      }
      return;
    }

    // ── Filter mode ──────────────────────────────────────
    if (state.mode === 'filter') {
      if (key.escape) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.return) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'SET_FILTER', text: state.filterText.slice(0, -1) });
        return;
      }
      if (key.downArrow || input === 'j') {
        dispatch({ type: 'NAVIGATE', delta: 1, maxIndex });
        return;
      }
      if (key.upArrow || input === 'k') {
        dispatch({ type: 'NAVIGATE', delta: -1, maxIndex });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'SET_FILTER', text: state.filterText + input });
      }
      return;
    }

    // ── Normal mode ──────────────────────────────────────

    // Quit
    if (input === 'q') {
      exit();
      return;
    }

    // Filter (only in projects phase)
    if (input === '/' && state.phase === 'projects') {
      dispatch({ type: 'SET_MODE', mode: 'filter' });
      return;
    }

    // Expand to full TUI
    if (input === 'f') {
      onExpandFull?.();
      return;
    }

    // Navigation
    if (input === 'j' || key.downArrow) {
      dispatch({ type: 'NAVIGATE', delta: 1, maxIndex });
      return;
    }
    if (input === 'k' || key.upArrow) {
      dispatch({ type: 'NAVIGATE', delta: -1, maxIndex });
      return;
    }

    // Drill in (right arrow)
    if (key.rightArrow) {
      handleDrillIn();
      return;
    }

    // Quick launch (Enter) — launches directly from projects, drills in from actions/sessions
    if (key.return) {
      handleSelect();
      return;
    }

    // Go back (left arrow or Escape)
    if (key.leftArrow || key.escape) {
      if (state.phase === 'projects') {
        exit();
      } else {
        dispatch({ type: 'BACK' });
      }
      return;
    }

    // New session with prompt (from any phase if project is selected)
    if (input === 'n' && selectedProject && (state.phase === 'projects' || state.phase === 'actions')) {
      dispatch({ type: 'SET_MODE', mode: 'prompt' });
      return;
    }
  });

  function handleSelect(): void {
    switch (state.phase) {
      case 'projects': {
        // Enter on project = launch immediately (continue last session)
        const proj = filteredProjects[state.selectedIndex];
        if (proj) {
          launchAndTrack({ projectPath: proj.path });
          exit();
        }
        break;
      }
      // For all other phases, Enter behaves same as drill-in
      default:
        handleDrillIn();
    }
  }

  function handleDrillIn(): void {
    switch (state.phase) {
      case 'projects': {
        const proj = filteredProjects[state.selectedIndex];
        if (proj) {
          dispatch({ type: 'SET_PHASE', phase: 'actions', projectPath: proj.path });
        }
        break;
      }
      case 'actions': {
        const action = actions[state.selectedIndex];
        if (!action || !selectedProject) break;

        switch (action.id) {
          case 'launch':
            launchAndTrack({ projectPath: selectedProject.path });
            exit();
            break;
          case 'new':
            dispatch({ type: 'SET_MODE', mode: 'prompt' });
            break;
          case 'sessions':
            dispatch({ type: 'SET_PHASE', phase: 'sessions' });
            break;
          case 'folder':
            openInExplorer(selectedProject.path);
            exit();
            break;
          case 'vscode':
            openVSCode(selectedProject.path);
            exit();
            break;
        }
        break;
      }
      case 'sessions': {
        const session = sessions[state.selectedIndex];
        if (session && selectedProject) {
          launchAndTrack({
            projectPath: selectedProject.path,
            sessionId: session.id,
          });
          exit();
        }
        break;
      }
    }
  }
}
