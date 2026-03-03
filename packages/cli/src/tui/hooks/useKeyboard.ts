/**
 * Vim-style keyboard input handling via Ink useInput.
 */

import { useInput, useApp } from 'ink';
import { launchClaude } from '../../core/launcher.js';
import { openInExplorer } from '../../core/platform.js';
import { openVSCode } from '../../core/launcher.js';
import type { AppState, Project, Session, Issue } from '../../types.js';
import type { AppDispatch } from './useAppState.js';

interface UseKeyboardOptions {
  state: AppState;
  dispatch: AppDispatch;
  viewportHeight: number;
  filteredProjects: Project[];
  selectedProject: Project | undefined;
  recentSessions: Session[];
  issues: Issue[];
  onLaunchFeedback?: (msg: string) => void;
}

export function useKeyboard(opts: UseKeyboardOptions): void {
  const { state, dispatch, viewportHeight, filteredProjects, selectedProject, recentSessions, issues, onLaunchFeedback } = opts;
  const { exit } = useApp();

  useInput((input, key) => {
    // ── Filter mode ──────────────────────────────────────
    if (state.mode === 'filter') {
      if (key.escape) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.return) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        // Keep the current selection from filtered results
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'SET_FILTER', text: state.filterText.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'SET_FILTER', text: state.filterText + input });
        // Reset selection to top when filter changes
        dispatch({ type: 'SELECT_INDEX', index: 0 });
        return;
      }
      // Arrow navigation in filter mode
      if (key.downArrow) {
        dispatch({ type: 'NAVIGATE', delta: 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'NAVIGATE', delta: -1 });
        return;
      }
      return;
    }

    // ── Help overlay ─────────────────────────────────────
    if (state.mode === 'help') {
      if (key.escape || input === '?' || input === 'q') {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
      }
      return;
    }

    // ── Welcome screen ───────────────────────────────────
    if (state.mode === 'welcome') {
      if (key.escape || input === 'q') {
        exit();
      }
      return;
    }

    // ── Normal mode ──────────────────────────────────────

    // Quit (from any pane)
    if (input === 'q') {
      exit();
      return;
    }

    // Help
    if (input === '?') {
      dispatch({ type: 'SET_MODE', mode: 'help' });
      return;
    }

    // Filter
    if (input === '/') {
      dispatch({ type: 'SET_MODE', mode: 'filter' });
      return;
    }

    // Details pane navigation (must come before generic navigation)
    if (state.focusPane === 'details') {
      const sessionCount = recentSessions.length;
      const issueCount = issues.length;

      if (input === 'j' || key.downArrow) {
        if (state.detailSection === 'sessions') {
          if (state.detailIndex < sessionCount - 1) {
            dispatch({ type: 'DETAIL_NAVIGATE', delta: 1, maxIndex: sessionCount - 1 });
          } else if (issueCount > 0) {
            // Past last session → switch to issues
            dispatch({ type: 'DETAIL_SECTION', section: 'issues' });
          }
        } else {
          dispatch({ type: 'DETAIL_NAVIGATE', delta: 1, maxIndex: issueCount - 1 });
        }
        return;
      }
      if (input === 'k' || key.upArrow) {
        if (state.detailSection === 'issues') {
          if (state.detailIndex > 0) {
            dispatch({ type: 'DETAIL_NAVIGATE', delta: -1, maxIndex: issueCount - 1 });
          } else if (sessionCount > 0) {
            // Past first issue → switch to sessions, select last
            dispatch({ type: 'DETAIL_SECTION', section: 'sessions', index: sessionCount - 1 });
          }
        } else {
          dispatch({ type: 'DETAIL_NAVIGATE', delta: -1, maxIndex: sessionCount - 1 });
        }
        return;
      }
      if (key.return) {
        if (state.detailSection === 'sessions' && recentSessions[state.detailIndex]) {
          const session = recentSessions[state.detailIndex];
          onLaunchFeedback?.(`Resuming session: ${session.summary.slice(0, 30)}...`);
          launchClaude({
            projectPath: selectedProject!.path,
            sessionId: session.id,
          });
        } else if (state.detailSection === 'issues' && issues[state.detailIndex]) {
          const issue = issues[state.detailIndex];
          onLaunchFeedback?.(`Fixing issue #${issue.number}...`);
          launchClaude({
            projectPath: selectedProject!.path,
            prompt: `Please investigate and fix GitHub issue #${issue.number}: ${issue.title}. Use gh issue view ${issue.number} to read the full details.`,
          });
        }
        return;
      }
      // Quick-jump between sections
      if (input === 'i' && issueCount > 0) {
        dispatch({ type: 'DETAIL_SECTION', section: 'issues' });
        return;
      }
      if (input === 's' && sessionCount > 0) {
        dispatch({ type: 'DETAIL_SECTION', section: 'sessions' });
        return;
      }
      if (key.escape || key.leftArrow || key.tab) {
        dispatch({ type: 'SET_FOCUS', pane: 'projects' });
        return;
      }
    }

    // Navigation (projects pane)
    if (input === 'j' || key.downArrow) {
      dispatch({ type: 'NAVIGATE', delta: 1 });
      return;
    }
    if (input === 'k' || key.upArrow) {
      dispatch({ type: 'NAVIGATE', delta: -1 });
      return;
    }
    if (input === 'g') {
      dispatch({ type: 'JUMP_TOP' });
      return;
    }
    if (input === 'G') {
      dispatch({ type: 'JUMP_BOTTOM' });
      return;
    }

    // Half-page scroll
    if (key.ctrl && input === 'd') {
      dispatch({ type: 'HALF_PAGE', direction: 'down', viewportHeight });
      return;
    }
    if (key.ctrl && input === 'u') {
      dispatch({ type: 'HALF_PAGE', direction: 'up', viewportHeight });
      return;
    }

    // Focus management
    if (key.rightArrow || key.tab) {
      dispatch({ type: 'SET_FOCUS', pane: 'details' });
      return;
    }
    if (key.return) {
      if (state.focusPane === 'projects' && selectedProject) {
        // Smart launch: continue if recent, else new
        const hasRecent = recentSessions.length > 0;
        onLaunchFeedback?.(`Launching ${selectedProject.name}...`);
        launchClaude({
          projectPath: selectedProject.path,
          isNew: !hasRecent,
        });
      }
      return;
    }

    // Actions (normal mode, projects pane)
    if (state.focusPane === 'projects' && selectedProject) {
      if (input === 'n') {
        onLaunchFeedback?.(`New session: ${selectedProject.name}...`);
        launchClaude({ projectPath: selectedProject.path, isNew: true });
        return;
      }
      if (input === 'c') {
        onLaunchFeedback?.(`Continuing: ${selectedProject.name}...`);
        launchClaude({ projectPath: selectedProject.path });
        return;
      }
      if (input === 'i') {
        dispatch({ type: 'SET_FOCUS', pane: 'details' });
        return;
      }
      if (input === 'p') {
        dispatch({ type: 'TOGGLE_PIN', index: state.selectedIndex });
        return;
      }
      if (input === 'h') {
        dispatch({ type: 'HIDE_PROJECT', index: state.selectedIndex });
        return;
      }
      if (input === 'r') {
        dispatch({ type: 'REFRESH_PROJECTS' });
        return;
      }
      if (input === 'o') {
        openInExplorer(selectedProject.path);
        return;
      }
      if (input === 'a') {
        // TODO: prompt for path in filter bar
        return;
      }
    }
  });
}
