/**
 * Tiny observable store. The cardinal rule: SERVER data (`data`) and UI/route
 * state (`ui`) are separate. The 3s poll only replaces `data` — it never
 * touches `ui` — so an open launch form, the typed prompt, the expanded
 * session, sort order and scroll all survive a refresh by construction.
 */
import type {
  OverviewPayload, TranscriptEntry, DetailTab,
  ProjectCommit, ProjectIssue, ProjectSessionRow, FileEntry, ProjectActivity, SearchResult, NoteEntry,
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
  prompt?: string;            // new sessions: seed prompt typed into the agent
  scratch?: boolean;          // doc tiles: a scratchpad (opens in edit mode, focused)
  noteOpen?: boolean;         // term tiles: the docked notepad panel is open (persists with the conversation)
  notePath?: string;          // term tiles: resolved docked-notepad file — persisted so resume reopens the SAME draft (not a fresh empty one)
  noteAnnounced?: boolean;    // term tiles: the one-time "a notepad is linked" notice has been sent to the agent
  discoveredSessionId?: string; // 'new' tiles: the sessionId claude created → resume it (not re-spawn) on restore
}

export interface CockpitState {
  tiles: CockpitTile[];
  layout: 'cols1' | 'cols2' | 'grid';
  open: boolean;
  tab: 'grid' | 'stats';      // cockpit sub-view: the tile grid, or the usage Stats panel
  statsDays: number;          // Stats range (1/3/7/30)
  maximized: string | null;   // tile id shown full-bleed
  hiddenProjects: string[];   // project paths whose tiles are muted (focus chips)
  attnTiles: string[];        // tile ids whose conversation is waiting for input (ephemeral — not persisted)
  addOpen: boolean;           // the "+ Add" picker overlay
  addQuery: string;
  addResults: SearchResult[];
  notesOpen: boolean;                              // the notes-library overlay
  notesScope: 'conversation' | 'project' | 'all'; // which notes the library lists
  notesQuery: string;                              // client-side filter over the listed notes
  notesResults: NoteEntry[];                       // last fetch for the current scope
}

export interface UiState {
  expandedSessionId: string | null;
  selectedProject: string | null; // project path — when set, main shows project detail
  detailTab: DetailTab;
  newSessionOpen: boolean;         // the "New session" prompt form in the detail header
  newSessionDraft: string;         // typed prompt, preserved across polls
  dockOpen: boolean;
  sidebarCollapsed: boolean;
  collapsedGroups: string[];       // sidebar project-groups the user has collapsed
  cockpit: CockpitState;           // cockpit.open = the Cockpit view is selected
  sortKey: SortKey;
  sortDir: 1 | -1;                 // 1 = desc, -1 = asc
  restoreOffer: { tiles: CockpitTile[]; layout: CockpitState['layout'] } | null; // last-session tiles to optionally restore
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
    collapsedGroups: [],
    cockpit: { tiles: [], layout: 'cols2', open: true, tab: 'grid', statsDays: 3, maximized: null, hiddenProjects: [], attnTiles: [], addOpen: false, addQuery: '', addResults: [], notesOpen: false, notesScope: 'project', notesQuery: '', notesResults: [] },
    sortKey: 'tokens',
    sortDir: 1,
    restoreOffer: null,
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
  schedulePersist();
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const fn of listeners) fn(state);
  });
}

// ── session persistence (localStorage) ───────────────────────
// Remember the cockpit + sidebar layout so closing/reopening the dashboard
// brings you back. `ts` is refreshed on every change while open, so on reopen
// we can tell "I just refreshed" (fresh → auto-restore + reconnect) from "next
// day" (stale → offer to restore, no surprise re-spawns).
const PERSIST_KEY = 'cldctrl.session.v1';
export interface PersistedSession {
  ts: number;
  cockpit: { tiles: CockpitTile[]; layout: CockpitState['layout']; open: boolean; maximized: string | null; hiddenProjects?: string[] };
  sidebarCollapsed: boolean;
  collapsedGroups: string[];
}
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const cp = state.ui.cockpit;
      // Drop the seed prompt from 'new' tiles before persisting: if the SERVER
      // restarts (PTYs gone), a restored 'new' tile would otherwise re-spawn
      // `claude "<prompt>"` and re-run the original task as a fresh, divergent
      // conversation. The prompt is only needed for the very first spawn, which
      // has already happened by the time we persist.
      const persistTiles = cp.tiles.map((t) => (t.kind === 'new' && t.prompt) ? { ...t, prompt: undefined } : t);
      const data: PersistedSession = {
        ts: Date.now(),
        cockpit: { tiles: persistTiles, layout: cp.layout, open: cp.open, maximized: cp.maximized, hiddenProjects: cp.hiddenProjects },
        sidebarCollapsed: state.ui.sidebarCollapsed,
        collapsedGroups: state.ui.collapsedGroups,
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch { /* storage unavailable / quota — non-fatal */ }
  }, 800);
}

export function loadPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch { return null; }
}

export function clearPersistedSession(): void {
  try { localStorage.removeItem(PERSIST_KEY); } catch { /* ignore */ }
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
