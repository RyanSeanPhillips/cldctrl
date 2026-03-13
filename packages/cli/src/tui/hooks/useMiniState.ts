/**
 * Mini TUI state: simple reducer for the 3-phase wizard flow.
 * Phases: projects → actions → sessions
 */

import { useReducer } from 'react';
import { loadConfig } from '../../config.js';
import { buildProjectListFast } from '../../core/projects.js';
import { isDemoMode, demoConfig, demoProjects } from '../../core/demo-data.js';
import type { Config, Project } from '../../types.js';

export type MiniPhase = 'projects' | 'actions' | 'sessions';
export type MiniMode = 'normal' | 'filter' | 'prompt';

export interface MiniState {
  config: Config;
  projects: Project[];
  phase: MiniPhase;
  mode: MiniMode;
  selectedIndex: number;
  /** Persists the project selection across phase transitions (by path, not index) */
  selectedProjectPath: string | null;
  filterText: string;
  promptText: string;
}

export type MiniAction =
  | { type: 'NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'SELECT_INDEX'; index: number }
  | { type: 'SET_PHASE'; phase: MiniPhase; projectPath?: string }
  | { type: 'SET_MODE'; mode: MiniMode }
  | { type: 'SET_FILTER'; text: string }
  | { type: 'SET_PROMPT'; text: string }
  | { type: 'BACK' };

function reducer(state: MiniState, action: MiniAction): MiniState {
  switch (action.type) {
    case 'NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.selectedIndex + action.delta));
      if (newIdx === state.selectedIndex) return state;
      return { ...state, selectedIndex: newIdx };
    }

    case 'SELECT_INDEX':
      return state.selectedIndex === action.index ? state : { ...state, selectedIndex: action.index };

    case 'SET_PHASE': {
      const projPath = action.projectPath ?? state.selectedProjectPath;
      return { ...state, phase: action.phase, selectedIndex: 0, selectedProjectPath: projPath };
    }

    case 'SET_MODE':
      return {
        ...state,
        mode: action.mode,
        filterText: '',
        promptText: action.mode === 'prompt' ? '' : state.promptText,
        selectedIndex: action.mode === 'filter' ? 0 : state.selectedIndex,
      };

    case 'SET_FILTER':
      return { ...state, filterText: action.text, selectedIndex: 0 };

    case 'SET_PROMPT':
      return { ...state, promptText: action.text };

    case 'BACK': {
      if (state.phase === 'sessions') {
        return { ...state, phase: 'actions', selectedIndex: 0 };
      }
      if (state.phase === 'actions') {
        return { ...state, phase: 'projects', selectedIndex: 0 };
      }
      return state;
    }

    default:
      return state;
  }
}

function initState(): MiniState {
  if (isDemoMode()) {
    return {
      config: demoConfig(),
      projects: demoProjects(),
      phase: 'projects',
      mode: 'normal',
      selectedIndex: 0,
      selectedProjectPath: null,
      filterText: '',
      promptText: '',
    };
  }
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  return {
    config,
    projects,
    phase: 'projects',
    mode: 'normal',
    selectedIndex: 0,
    selectedProjectPath: null,
    filterText: '',
    promptText: '',
  };
}

export function useMiniState() {
  const [state, dispatch] = useReducer(reducer, null, initState);
  return { state, dispatch };
}

export type MiniDispatch = ReturnType<typeof useMiniState>['dispatch'];
