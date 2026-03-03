/**
 * App state management: config + projects + navigation in a single useReducer.
 * PERF: Uses lazy initializer to avoid sync FS on every render.
 * SAFETY: No side effects in reducer — config saves happen via useEffect.
 */

import { useReducer, useEffect, useRef, useCallback } from 'react';
import os from 'node:os';
import { loadConfig, saveConfig } from '../../config.js';
import { buildProjectList } from '../../core/projects.js';
import type { Config, Project, FocusPane, AppMode, AppState } from '../../types.js';

// Case-insensitive path comparison only on Windows
const isWindows = os.platform() === 'win32';
function pathsEqual(a: string, b: string): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ── Actions ─────────────────────────────────────────────────

type Action =
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'SET_CONFIG'; config: Config }
  | { type: 'NAVIGATE'; delta: number }
  | { type: 'JUMP_TOP' }
  | { type: 'JUMP_BOTTOM' }
  | { type: 'HALF_PAGE'; direction: 'up' | 'down'; viewportHeight: number }
  | { type: 'SET_FOCUS'; pane: FocusPane }
  | { type: 'SET_MODE'; mode: AppMode }
  | { type: 'SET_FILTER'; text: string }
  | { type: 'SET_SCROLL_OFFSET'; offset: number }
  | { type: 'SELECT_INDEX'; index: number }
  | { type: 'TOGGLE_PIN'; index: number }
  | { type: 'HIDE_PROJECT'; index: number }
  | { type: 'REFRESH_PROJECTS' }
  | { type: 'DETAIL_NAVIGATE'; delta: number; maxIndex: number };

// Track pending config saves (side-effect-free reducer)
let pendingConfigSave: Config | null = null;

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };

    case 'SET_CONFIG':
      return { ...state, config: action.config };

    case 'NAVIGATE': {
      const maxIdx = state.projects.length - 1;
      const newIdx = Math.max(0, Math.min(maxIdx, state.selectedIndex + action.delta));
      if (newIdx === state.selectedIndex) return state; // No change — skip re-render
      return { ...state, selectedIndex: newIdx, detailIndex: 0 };
    }

    case 'JUMP_TOP':
      return state.selectedIndex === 0 ? state : { ...state, selectedIndex: 0 };

    case 'JUMP_BOTTOM': {
      const bottom = Math.max(0, state.projects.length - 1);
      return state.selectedIndex === bottom ? state : { ...state, selectedIndex: bottom };
    }

    case 'HALF_PAGE': {
      const half = Math.floor(action.viewportHeight / 2);
      const delta = action.direction === 'down' ? half : -half;
      const maxIdx = state.projects.length - 1;
      const newIdx = Math.max(0, Math.min(maxIdx, state.selectedIndex + delta));
      if (newIdx === state.selectedIndex) return state;
      return { ...state, selectedIndex: newIdx };
    }

    case 'SET_FOCUS':
      if (state.focusPane === action.pane) return state;
      return { ...state, focusPane: action.pane, detailIndex: action.pane === 'details' ? 0 : state.detailIndex };

    case 'SET_MODE':
      return {
        ...state,
        mode: action.mode,
        // Clear filter text when entering OR exiting filter mode
        filterText: '',
        selectedIndex: action.mode === 'filter' ? 0 : state.selectedIndex,
      };

    case 'SET_FILTER':
      return { ...state, filterText: action.text };

    case 'SET_SCROLL_OFFSET':
      return { ...state, scrollOffset: action.offset };

    case 'SELECT_INDEX':
      return state.selectedIndex === action.index ? state : { ...state, selectedIndex: action.index };

    case 'TOGGLE_PIN': {
      const project = state.projects[action.index];
      if (!project) return state;

      const config = { ...state.config };
      const isPinned = config.projects.some(
        (p) => pathsEqual(p.path, project.path)
      );

      if (isPinned) {
        config.projects = config.projects.filter(
          (p) => !pathsEqual(p.path, project.path)
        );
      } else {
        config.projects.push({ name: project.name, path: project.path });
      }

      // Schedule async save (no side effects in reducer)
      pendingConfigSave = config;
      const projects = buildProjectList(config);
      return { ...state, config, projects };
    }

    case 'HIDE_PROJECT': {
      const project = state.projects[action.index];
      if (!project) return state;

      const config = { ...state.config };
      config.hidden_projects = [...config.hidden_projects, project.path];

      // Schedule async save
      pendingConfigSave = config;
      const projects = buildProjectList(config);
      const newIdx = Math.min(state.selectedIndex, projects.length - 1);
      return { ...state, config, projects, selectedIndex: Math.max(0, newIdx) };
    }

    case 'REFRESH_PROJECTS': {
      const projects = buildProjectList(state.config);
      return { ...state, projects };
    }

    case 'DETAIL_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.detailIndex + action.delta));
      if (newIdx === state.detailIndex) return state;
      return { ...state, detailIndex: newIdx };
    }

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// ── Lazy initializer (runs once, not on every render) ───────

function initState(): AppState {
  const { config, isNew } = loadConfig();
  const initialProjects = buildProjectList(config);
  return {
    config,
    projects: initialProjects,
    selectedIndex: 0,
    focusPane: 'projects',
    mode: isNew && initialProjects.length === 0 ? 'welcome' : 'normal',
    filterText: '',
    scrollOffset: 0,
    detailIndex: 0,
  };
}

// ── Hook ────────────────────────────────────────────────────

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, null, initState);

  // Flush pending config saves asynchronously (not in reducer)
  useEffect(() => {
    if (pendingConfigSave) {
      const config = pendingConfigSave;
      pendingConfigSave = null;
      // Fire-and-forget async save
      try { saveConfig(config); } catch { /* logged in saveConfig */ }
    }
  });

  return { state, dispatch };
}

export type AppDispatch = ReturnType<typeof useAppState>['dispatch'];
