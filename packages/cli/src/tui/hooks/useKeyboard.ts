/**
 * Vim-style keyboard input handling via Ink useInput.
 */

import { useInput, useApp, useStdin } from 'ink';
import { useRef, useEffect } from 'react';
import { launchClaude, openVSCode, buildIssueFixPrompt } from '../../core/launcher.js';
import { openInExplorer } from '../../core/platform.js';
import { trackSession } from '../../core/tracker.js';
import { getHelpItemCount } from '../helpItems.js';
import type { SkillsData } from '../helpItems.js';
import type { AppState, Project, Session, Issue, GitCommit } from '../../types.js';
import type { AppDispatch } from './useAppState.js';

const KONAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'];

interface UseKeyboardOptions {
  state: AppState;
  dispatch: AppDispatch;
  viewportHeight: number;
  filteredProjects: Project[];
  selectedProject: Project | undefined;
  recentSessions: Session[];
  issues: Issue[];
  commits: GitCommit[];
  onLaunchFeedback?: (msg: string) => void;
  skillsData?: SkillsData;
}

export function useKeyboard(opts: UseKeyboardOptions): void {
  const { state, dispatch, viewportHeight, filteredProjects, selectedProject, recentSessions, issues, commits, onLaunchFeedback } = opts;
  const { exit } = useApp();

  // Konami code tracker
  const konamiRef = useRef<string[]>([]);
  const konamiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Raw stdin buffer for colon commands (:b, :t)
  // useInput can miss multi-char sequences, so we listen to raw stdin directly
  const inputBufRef = useRef('');
  const inputBufTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameTriggeredRef = useRef(false);
  const { stdin } = useStdin();

  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer) => {
      if (state.mode !== 'normal') return;
      const str = data.toString();
      inputBufRef.current += str;
      if (inputBufTimerRef.current) clearTimeout(inputBufTimerRef.current);
      inputBufTimerRef.current = setTimeout(() => { inputBufRef.current = ''; }, 1000);

      const buf = inputBufRef.current;
      if (buf.endsWith(':b')) {
        inputBufRef.current = '';
        gameTriggeredRef.current = true;
        dispatch({ type: 'SET_GAME', game: 'breakout' });
      } else if (buf.endsWith(':t')) {
        inputBufRef.current = '';
        gameTriggeredRef.current = true;
        dispatch({ type: 'SET_GAME', game: 'tetris' });
      }
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); };
  }, [stdin, state.mode, dispatch]);

  useInput((input, key) => {
    // ── Game mode (games handle their own input) ─────
    if (state.mode === 'game') return;

    // Skip if a game was just triggered by the raw stdin handler
    if (gameTriggeredRef.current) {
      gameTriggeredRef.current = false;
      return;
    }
    // ── Prompt mode ─────────────────────────────────────
    if (state.mode === 'prompt') {
      if (key.escape) {
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.return) {
        if (selectedProject) {
          const prompt = state.promptText.trim();
          onLaunchFeedback?.(prompt
            ? `Launching: ${prompt.slice(0, 40)}...`
            : `New session: ${selectedProject.name}...`);
          const promptResult = launchClaude({
            projectPath: selectedProject.path,
            isNew: true,
            prompt: prompt || undefined,
          });
          if (promptResult.success && promptResult.pid) {
            trackSession(promptResult.pid, selectedProject.path);
          }
        }
        dispatch({ type: 'SET_MODE', mode: 'normal' });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'SET_PROMPT', text: state.promptText.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'SET_PROMPT', text: state.promptText + input });
        return;
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
        return;
      }
      const maxHelp = Math.max(0, getHelpItemCount(opts.skillsData) - 1);
      // Navigation within help list
      if (input === 'j' || key.downArrow) {
        dispatch({ type: 'HELP_NAVIGATE', delta: 1, maxIndex: maxHelp });
        return;
      }
      if (input === 'k' || key.upArrow) {
        dispatch({ type: 'HELP_NAVIGATE', delta: -1, maxIndex: maxHelp });
        return;
      }
      if (input === 'g') {
        dispatch({ type: 'HELP_NAVIGATE', delta: -999, maxIndex: maxHelp });
        return;
      }
      if (input === 'G') {
        dispatch({ type: 'HELP_NAVIGATE', delta: 999, maxIndex: maxHelp });
        return;
      }
      if (key.ctrl && input === 'd') {
        dispatch({ type: 'HELP_NAVIGATE', delta: Math.floor(viewportHeight / 2), maxIndex: maxHelp });
        return;
      }
      if (key.ctrl && input === 'u') {
        dispatch({ type: 'HELP_NAVIGATE', delta: -Math.floor(viewportHeight / 2), maxIndex: maxHelp });
        return;
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

    // ── Easter egg game triggers ──────────────────────
    // Konami code: ↑↑↓↓←→←→ → Snake
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      const dir = key.upArrow ? 'up' : key.downArrow ? 'down' : key.leftArrow ? 'left' : 'right';
      konamiRef.current.push(dir);
      if (konamiTimerRef.current) clearTimeout(konamiTimerRef.current);
      konamiTimerRef.current = setTimeout(() => { konamiRef.current = []; }, 2000);

      // Check if last N entries match konami
      const seq = konamiRef.current;
      if (seq.length >= KONAMI.length) {
        const tail = seq.slice(-KONAMI.length);
        if (tail.every((v, i) => v === KONAMI[i])) {
          konamiRef.current = [];
          dispatch({ type: 'SET_GAME', game: 'snake' });
          return;
        }
      }
    }

    // Colon commands (:b, :t) handled by raw stdin listener above
    // Swallow the colon keystroke so it doesn't trigger other handlers
    if (input === ':') return;

    // ~ → Game of Life
    if (input === '~') {
      dispatch({ type: 'SET_GAME', game: 'life' });
      return;
    }

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
      const commitCount = commits.length;

      // Up/down: navigate within the active section
      if (input === 'j' || key.downArrow) {
        const max = state.detailSection === 'sessions' ? sessionCount - 1
          : state.detailSection === 'commits' ? commitCount - 1
          : issueCount - 1;
        dispatch({ type: 'DETAIL_NAVIGATE', delta: 1, maxIndex: max });
        return;
      }
      if (input === 'k' || key.upArrow) {
        const max = state.detailSection === 'sessions' ? sessionCount - 1
          : state.detailSection === 'commits' ? commitCount - 1
          : issueCount - 1;
        dispatch({ type: 'DETAIL_NAVIGATE', delta: -1, maxIndex: max });
        return;
      }
      // Left/right: cycle through 3 tabs (sessions → commits → issues)
      const tabOrder: Array<'sessions' | 'commits' | 'issues'> = ['sessions', 'commits', 'issues'];
      if (key.leftArrow) {
        const currentIdx = tabOrder.indexOf(state.detailSection);
        if (currentIdx <= 0) {
          dispatch({ type: 'SET_FOCUS', pane: 'projects' });
        } else {
          dispatch({ type: 'DETAIL_SECTION', section: tabOrder[currentIdx - 1] });
        }
        return;
      }
      if (key.rightArrow) {
        const currentIdx = tabOrder.indexOf(state.detailSection);
        if (currentIdx < tabOrder.length - 1) {
          dispatch({ type: 'DETAIL_SECTION', section: tabOrder[currentIdx + 1] });
        }
        return;
      }
      if (key.return) {
        if (state.detailSection === 'sessions' && recentSessions[state.detailIndex]) {
          const session = recentSessions[state.detailIndex];
          onLaunchFeedback?.(`Resuming session: ${session.summary.slice(0, 30)}...`);
          const resumeResult = launchClaude({
            projectPath: selectedProject!.path,
            sessionId: session.id,
          });
          if (resumeResult.success && resumeResult.pid) {
            trackSession(resumeResult.pid, selectedProject!.path);
          }
        } else if (state.detailSection === 'issues' && issues[state.detailIndex]) {
          const issue = issues[state.detailIndex];
          onLaunchFeedback?.(`Fixing issue #${issue.number}...`);
          const issueResult = launchClaude({
            projectPath: selectedProject!.path,
            prompt: buildIssueFixPrompt(issue),
          });
          if (issueResult.success && issueResult.pid) {
            trackSession(issueResult.pid, selectedProject!.path);
          }
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
      if (input === 'c' && commitCount > 0) {
        dispatch({ type: 'DETAIL_SECTION', section: 'commits' });
        return;
      }
      if (key.escape || key.tab) {
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
        const enterResult = launchClaude({
          projectPath: selectedProject.path,
          isNew: !hasRecent,
        });
        if (enterResult.success && enterResult.pid) {
          trackSession(enterResult.pid, selectedProject.path);
        }
      }
      return;
    }

    // Actions (normal mode, projects pane)
    if (state.focusPane === 'projects' && selectedProject) {
      if (input === 'n') {
        dispatch({ type: 'SET_MODE', mode: 'prompt' });
        return;
      }
      if (input === 'c') {
        onLaunchFeedback?.(`Continuing: ${selectedProject.name}...`);
        const contResult = launchClaude({ projectPath: selectedProject.path });
        if (contResult.success && contResult.pid) {
          trackSession(contResult.pid, selectedProject.path);
        }
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
        const opened = openInExplorer(selectedProject.path);
        onLaunchFeedback?.(opened ? `Opened: ${selectedProject.name}` : `Path not found: ${selectedProject.path}`);
        return;
      }
      if (input === 'a') {
        // TODO: prompt for path in filter bar
        return;
      }
    }
  });
}
