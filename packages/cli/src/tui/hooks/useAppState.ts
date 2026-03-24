/**
 * App state management: config + projects + navigation in a single useReducer.
 * PERF: Uses lazy initializer to avoid sync FS on every render.
 * SAFETY: No side effects in reducer — config saves happen via useEffect.
 */

import { useReducer, useEffect } from 'react';
import os from 'node:os';
import { loadConfig, saveConfig } from '../../config.js';
import { buildProjectList, buildProjectListFast } from '../../core/projects.js';
import { isDemoMode, demoConfig, demoProjects, demoIsNewUser } from '../../core/demo-data.js';
import type { Config, Project, FocusPane, AppMode, AppState, LeftSection } from '../../types.js';

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
  | { type: 'SET_PROMPT'; text: string }
  | { type: 'SET_SCROLL_OFFSET'; offset: number }
  | { type: 'SELECT_INDEX'; index: number }
  | { type: 'TOGGLE_PIN'; index: number }
  | { type: 'HIDE_PROJECT'; index: number }
  | { type: 'REFRESH_PROJECTS' }
  | { type: 'DETAIL_NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'DETAIL_SECTION'; section: 'sessions' | 'issues' | 'commits' | 'files'; index?: number }
  | { type: 'SET_GAME'; game: string | null }
  | { type: 'HELP_NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'SETTINGS_NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'SCAN_START' }
  | { type: 'SCAN_COMPLETE'; projects: Project[] }
  | { type: 'SCAN_CANCEL' }
  | { type: 'SET_LEFT_SECTION'; section: LeftSection; convIndex?: number }
  | { type: 'CONV_NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'CONV_EXPAND'; expanded: boolean }
  | { type: 'SETTINGS_TAB'; tab: 'general' | 'permissions' }
  | { type: 'PERMISSIONS_NAVIGATE'; delta: number; maxIndex: number }
  | { type: 'TOGGLE_SHOW_HIDDEN' }
  | { type: 'UNHIDE_PATHS'; paths: string[] };

// Track pending config saves (side-effect-free reducer)
let pendingConfigSave: Config | null = null;
let pendingConfigRevision = 0;

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };

    case 'SET_CONFIG':
      pendingConfigSave = action.config;
      pendingConfigRevision++;
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
      return {
        ...state,
        focusPane: action.pane,
        detailIndex: action.pane === 'details' ? 0 : state.detailIndex,
        detailSection: action.pane === 'details' ? 'sessions' : state.detailSection,
      };

    case 'SET_MODE':
      return {
        ...state,
        mode: action.mode,
        // Clear filter text when entering OR exiting filter mode
        filterText: '',
        // Clear prompt text when entering prompt mode (fresh start each time)
        promptText: action.mode === 'prompt' ? '' : state.promptText,
        selectedIndex: action.mode === 'filter' ? 0 : state.selectedIndex,
        // Clear active game when leaving game mode
        activeGame: action.mode === 'game' ? state.activeGame : null,
        // Reset help selection when entering help
        helpIndex: action.mode === 'help' ? 0 : state.helpIndex,
        // Reset settings selection when entering settings
        settingsIndex: action.mode === 'settings' ? 0 : state.settingsIndex,
        settingsTab: action.mode === 'settings' ? 'general' : state.settingsTab,
        permissionsIndex: action.mode === 'settings' ? 0 : state.permissionsIndex,
      };

    case 'SET_GAME':
      return {
        ...state,
        activeGame: action.game,
        mode: action.game ? 'game' : 'normal',
      };

    case 'SET_FILTER':
      return { ...state, filterText: action.text };

    case 'SET_PROMPT':
      return { ...state, promptText: action.text };

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
      pendingConfigRevision++;
      const projects = buildProjectListFast(config);
      return { ...state, config, projects };
    }

    case 'HIDE_PROJECT': {
      const project = state.projects[action.index];
      if (!project) return state;

      const config = { ...state.config };
      config.hidden_projects = [...config.hidden_projects, project.path];

      // Schedule async save
      pendingConfigSave = config;
      const projects = buildProjectListFast(config);
      const newIdx = Math.min(state.selectedIndex, projects.length - 1);
      return { ...state, config, projects, selectedIndex: Math.max(0, newIdx) };
    }

    case 'TOGGLE_SHOW_HIDDEN':
      return { ...state, showHidden: !state.showHidden };

    case 'UNHIDE_PATHS': {
      if (action.paths.length === 0) return state;
      const lower = new Set(action.paths.map(p => p.toLowerCase()));
      const config = { ...state.config };
      config.hidden_projects = config.hidden_projects.filter(
        p => !lower.has(p.toLowerCase())
      );
      pendingConfigSave = config;
      pendingConfigRevision++;
      return { ...state, config };
    }

    case 'REFRESH_PROJECTS': {
      const projects = buildProjectListFast(state.config);
      return { ...state, projects };
    }

    case 'DETAIL_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.detailIndex + action.delta));
      if (newIdx === state.detailIndex) return state;
      return { ...state, detailIndex: newIdx };
    }

    case 'DETAIL_SECTION':
      if (state.detailSection === action.section) return state;
      return { ...state, detailSection: action.section, detailIndex: action.index ?? 0 };

    case 'HELP_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.helpIndex + action.delta));
      if (newIdx === state.helpIndex) return state;
      return { ...state, helpIndex: newIdx };
    }

    case 'SETTINGS_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.settingsIndex + action.delta));
      if (newIdx === state.settingsIndex) return state;
      return { ...state, settingsIndex: newIdx };
    }

    case 'SCAN_START':
      return { ...state, scanning: true };

    case 'SCAN_COMPLETE':
      return { ...state, scanning: false, projects: action.projects };

    case 'SCAN_CANCEL':
      return { ...state, scanning: false };

    case 'SET_LEFT_SECTION': {
      if (state.leftSection === action.section && action.convIndex === undefined) return state;
      return {
        ...state,
        leftSection: action.section,
        conversationIndex: action.convIndex ?? (action.section === 'conversations' ? state.conversationIndex : 0),
        expandedConversation: false,
        focusPane: 'projects', // ensure left pane has focus
      };
    }

    case 'CONV_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.conversationIndex + action.delta));
      if (newIdx === state.conversationIndex) return state;
      return { ...state, conversationIndex: newIdx, expandedConversation: false };
    }

    case 'CONV_EXPAND':
      if (state.expandedConversation === action.expanded) return state;
      return { ...state, expandedConversation: action.expanded };

    case 'SETTINGS_TAB':
      if (state.settingsTab === action.tab) return state;
      return { ...state, settingsTab: action.tab, settingsIndex: 0, permissionsIndex: 0 };

    case 'PERMISSIONS_NAVIGATE': {
      const newIdx = Math.max(0, Math.min(action.maxIndex, state.permissionsIndex + action.delta));
      if (newIdx === state.permissionsIndex) return state;
      return { ...state, permissionsIndex: newIdx };
    }

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// ── Snapshot view override ───────────────────────────────────
// SNAPSHOT_VIEW env var sets initial view for frame capture.
// Values: sessions (default), issues, commits, files, conversations, conversation_detail

function applySnapshotView(state: AppState): AppState {
  const view = process.env.SNAPSHOT_VIEW;
  if (!view) return state;
  switch (view) {
    case 'issues':
      return { ...state, detailSection: 'issues', focusPane: 'details' };
    case 'commits':
      return { ...state, detailSection: 'commits', focusPane: 'details' };
    case 'files':
      return { ...state, detailSection: 'files', focusPane: 'details' };
    case 'conversations':
      return { ...state, leftSection: 'conversations', focusPane: 'projects' };
    case 'conversation_detail':
      return { ...state, leftSection: 'conversations', focusPane: 'projects', expandedConversation: true, conversationIndex: 0 };
    case 'sessions':
    default:
      return state;
  }
}

// ── Lazy initializer (runs once, not on every render) ───────

function initState(): AppState {
  if (isDemoMode()) {
    const projects = demoProjects();
    return applySnapshotView({
      config: demoConfig(),
      projects,
      selectedIndex: 0,
      focusPane: 'projects',
      mode: demoIsNewUser() || projects.length === 0 ? 'welcome' : 'normal',
      filterText: '',
      promptText: '',
      scrollOffset: 0,
      detailIndex: 0,
      detailSection: 'sessions',
      activeGame: null,
      helpIndex: 0,
      settingsIndex: 0,
      settingsTab: 'general',
      permissionsIndex: 0,
      scanning: false,
      leftSection: 'projects',
      conversationIndex: 0,
      expandedConversation: false,
      showHidden: false,
    });
  }
  const { config, isNew } = loadConfig();
  // Use fast path (cached names, no git spawns) for instant first paint.
  // Background refresh in App.tsx will fill in full names later.
  const initialProjects = buildProjectListFast(config);
  return applySnapshotView({
    config,
    projects: initialProjects,
    selectedIndex: 0,
    focusPane: 'projects',
    mode: isNew && initialProjects.length === 0 ? 'welcome' : 'normal',
    filterText: '',
    promptText: '',
    scrollOffset: 0,
    detailIndex: 0,
    detailSection: 'sessions',
    activeGame: null,
    helpIndex: 0,
    settingsIndex: 0,
    settingsTab: 'general',
    permissionsIndex: 0,
    scanning: false,
    leftSection: 'projects',
    conversationIndex: 0,
    expandedConversation: false,
    showHidden: false,
  });
}

// ── Hook ────────────────────────────────────────────────────

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, null, initState);

  // Flush pending config saves asynchronously (not in reducer).
  // Only runs when state.config changes (TOGGLE_PIN, HIDE_PROJECT, SET_CONFIG).
  useEffect(() => {
    if (pendingConfigSave) {
      const config = pendingConfigSave;
      pendingConfigSave = null;
      try { saveConfig(config); } catch { /* logged in saveConfig */ }
    }
  }, [state.config]);

  return { state, dispatch };
}

export type AppDispatch = ReturnType<typeof useAppState>['dispatch'];
