/**
 * Tiny observable store. The cardinal rule: SERVER data (`data`) and UI/route
 * state (`ui`) are separate. The 3s poll only replaces `data` — it never
 * touches `ui` — so an open launch form, the typed prompt, the expanded
 * session, sort order and scroll all survive a refresh by construction.
 */
import type {
  OverviewPayload, TranscriptEntry, DetailTab,
  ProjectCommit, ProjectIssue, ProjectSessionRow, FileEntry, ProjectActivity, SearchResult,
} from './types.js';

export type SortKey = 'tokens' | 'share' | 'msgs' | 'tr' | 'ctx' | 'dur' | 'ago';

export interface CockpitTile {
  id: string;                 // 'resume:<sessionId>' | 'new:<...>' | 'doc:<path>'
  kind: 'resume' | 'new' | 'doc';
  sessionId?: string;         // resume only
  projectPath: string;
  title: string;
  worktree?: boolean;         // new sessions: run in an isolated git worktree
  branch?: string;            // the worktree branch
  agent?: string;             // new sessions: which CLI agent (claude/codex/gemini)
  filePath?: string;          // doc tiles: absolute path to the markdown file
}

export interface CockpitState {
  tiles: CockpitTile[];
  layout: 'cols1' | 'cols2' | 'grid';
  open: boolean;
  maximized: string | null;   // tile id shown full-bleed
  addOpen: boolean;           // the "+ Add" picker overlay
  addQuery: string;
  addResults: SearchResult[];
}

export interface UiState {
  expandedSessionId: string | null;
  selectedProject: string | null; // project path — when set, main shows project detail
  detailTab: DetailTab;
  newSessionOpen: boolean;         // the "New session" prompt form in the detail header
  newSessionDraft: string;         // typed prompt, preserved across polls
  dockOpen: boolean;
  sidebarCollapsed: boolean;
  cockpit: CockpitState;           // cockpit.open = the Cockpit view is selected
  sortKey: SortKey;
  sortDir: 1 | -1;                 // 1 = desc, -1 = asc
}

export interface DetailState {
  project: string | null;          // path the loaded data belongs to
  activity: ProjectActivity | null; // header heatmaps (loaded once per project)
  sessions: ProjectSessionRow[] | null;
  commits: ProjectCommit[] | null;
  issues: { issues: ProjectIssue[]; ghAvailable: boolean; installUrl?: string } | null;
  files: Record<string, FileEntry[]>; // keyed by dir ('' = root)
  expandedDirs: string[];
  loadingTab: DetailTab | null;
  error: string | null;
}

export interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  agentNote: string | null; // set when the agent pushed this search
}

export interface State {
  data: OverviewPayload | null;
  connError: boolean;
  ui: UiState;
  detail: DetailState;
  search: SearchState;
  transcript: { id: string; entries: TranscriptEntry[] } | null;
}

function emptyDetail(project: string | null): DetailState {
  return { project, activity: null, sessions: null, commits: null, issues: null, files: {}, expandedDirs: [], loadingTab: null, error: null };
}

const state: State = {
  data: null,
  connError: false,
  ui: {
    expandedSessionId: null,
    selectedProject: null,
    detailTab: 'sessions',
    newSessionOpen: false,
    newSessionDraft: '',
    dockOpen: false,
    sidebarCollapsed: false,
    cockpit: { tiles: [], layout: 'cols2', open: false, maximized: null, addOpen: false, addQuery: '', addResults: [] },
    sortKey: 'tokens',
    sortDir: 1,
  },
  detail: emptyDetail(null),
  search: { query: '', results: [], loading: false, agentNote: null },
  transcript: null,
};

type Listener = (s: State) => void;
const listeners = new Set<Listener>();

export function getState(): State {
  return state;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let scheduled = false;
function notify(): void {
  // Coalesce multiple set() calls in one tick into a single render.
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const fn of listeners) fn(state);
  });
}

/** Replace server data (poll path). Never mutates `ui`. */
export function setData(data: OverviewPayload): void {
  state.data = data;
  state.connError = false;
  notify();
}

export function setConnError(v: boolean): void {
  if (state.connError === v) return;
  state.connError = v;
  notify();
}

export function setTranscript(t: State['transcript']): void {
  state.transcript = t;
  notify();
}

/** Patch UI state (user-interaction path). */
export function setUi(patch: Partial<UiState>): void {
  Object.assign(state.ui, patch);
  notify();
}

/** Patch the project-detail slice. */
export function setDetail(patch: Partial<DetailState>): void {
  Object.assign(state.detail, patch);
  notify();
}

/** Patch the search slice. */
export function setSearch(patch: Partial<SearchState>): void {
  Object.assign(state.search, patch);
  notify();
}

/** Patch the cockpit slice (nested under ui). */
export function setCockpit(patch: Partial<CockpitState>): void {
  Object.assign(state.ui.cockpit, patch);
  notify();
}

/** Point the detail slice at a (new) project, clearing any prior tab data. */
export function resetDetail(project: string | null): void {
  state.detail = emptyDetail(project);
  notify();
}
