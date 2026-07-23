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

export interface CockpitTile {
  id: string;                 // 'resume:<sessionId>' | 'new:<...>' | 'doc:<path>' | 'control'
  kind: 'resume' | 'new' | 'doc' | 'control';
  sessionId?: string;         // resume only
  vendor?: 'claude' | 'codex' | 'antigravity'; // resume tiles: which CLI to resume with (claude default; codex → `codex resume`; antigravity → `agy --conversation`)
  projectPath: string;
  title: string;
  worktree?: boolean;         // new sessions: run in an isolated git worktree
  branch?: string;            // the worktree branch
  agent?: string;             // new sessions: which CLI agent (claude/codex/gemini)
  filePath?: string;          // doc tiles: absolute path to the markdown file
  prompt?: string;            // new sessions: seed prompt typed into the agent
  scratch?: boolean;          // doc tiles: a scratchpad (opens in edit mode, focused)
  minimized?: boolean;        // parked: the tile keeps its PTY/WebSocket but leaves the grid — it lives in the sidebar conversation list until restored
  noteOpen?: boolean;         // term tiles: the docked notepad panel is open (persists with the conversation)
  notePath?: string;          // term tiles: resolved docked-notepad file — persisted so resume reopens the SAME draft (not a fresh empty one)
  handoffFrom?: { sessionId: string; vendor: string }; // this tile continues another conversation's work (backlink)
  discoveredSessionId?: string; // 'new' tiles: the sessionId claude created → resume it (not re-spawn) on restore
}

/** One conversation (or doc tile) in the restore offer. `origin` is where it
 *  lived last session (cockpit grid vs its own pop-out window); `dest` is where
 *  the user wants it back — mutated by the chooser's drag/checkbox UI. */
export interface RestoreItem {
  tile: CockpitTile;
  origin: 'grid' | 'win';
  dest: 'grid' | 'win' | 'skip';
  // Lazy enrichment, fetched when the chooser opens (never persisted):
  summary?: string;       // rich summary → Claude's own index summary → gist
  ctxPct?: number | null; // context occupancy 0-100 (last assistant turn)
  model?: string | null;
  lastPrompts?: string[]; // last few user prompts (transcript tail)
  peek?: boolean;         // the last-prompts drawer is expanded
}

export interface RestoreOffer {
  layout: CockpitState['layout'];
  items: RestoreItem[];
  chooserOpen: boolean;   // the spatial drag-and-drop modal (banner "Choose…")
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
  searchOpen: boolean;             // the sidebar search field is expanded (explicit STORE state — a class toggle would snap back on the 3s poll re-render)
  recentCollapsed: boolean;        // the sidebar "Recent" conversations list is collapsed (STORE state — a DOM/details toggle would snap back on the 3s poll re-render, same lesson as searchOpen)
  detailTab: DetailTab;
  newSessionOpen: boolean;         // the "New session" prompt form in the detail header
  newSessionDraft: string;         // typed prompt, preserved across polls
  sidebarCollapsed: boolean;
  collapsedGroups: string[];       // sidebar project-groups the user has collapsed
  cockpit: CockpitState;           // cockpit.open = the Cockpit view is selected
  restoreOffer: RestoreOffer | null; // last-session workspace to optionally restore (banner + chooser modal)
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
    searchOpen: false,
    recentCollapsed: false,
    detailTab: 'sessions',
    newSessionOpen: false,
    newSessionDraft: '',
    sidebarCollapsed: false,
    collapsedGroups: [],
    cockpit: { tiles: [], layout: 'cols2', open: true, tab: 'grid', statsDays: 3, maximized: null, hiddenProjects: [], attnTiles: [], addOpen: false, addQuery: '', addResults: [], notesOpen: false, notesScope: 'project', notesQuery: '', notesResults: [] },
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
// Widget windows (?widget=1 pop-outs) share the app profile's localStorage with
// the main dashboard. They must NEVER persist their own (single-tile, empty-grid)
// state or they'd overwrite the primary window's saved layout.
let persistenceEnabled = true;
export function disablePersistence(): void { persistenceEnabled = false; }
function schedulePersist(): void {
  if (!persistenceEnabled) return;
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
      // The CTRL control tile is ON-DEMAND (opened from the sidebar) — never persist
      // it, or a reload would recreate it and re-spawn `claude --continue` on load,
      // defeating on-demand and coupling multiple windows. The sidebar row is the
      // persistent affordance instead.
      const persistTiles = cp.tiles
        .filter((t) => t.kind !== 'control')
        .map((t) => (t.kind === 'new' && t.prompt) ? { ...t, prompt: undefined } : t);
      const data: PersistedSession = {
        ts: Date.now(),
        // The cockpit is now always-open (it's the home surface) — persist `open:true`
        // so stale localStorage from the old List/Cockpit tab era can't reintroduce false.
        cockpit: { tiles: persistTiles, layout: cp.layout, open: true, maximized: cp.maximized, hiddenProjects: cp.hiddenProjects },
        sidebarCollapsed: state.ui.sidebarCollapsed,
        collapsedGroups: state.ui.collapsedGroups,
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch { /* storage unavailable / quota — non-fatal */ }
  }, 800);
}

// ── pop-out registry (localStorage) ──────────────────────────
// Popped-out conversations live in their own windows, outside the persisted
// grid — without this registry they'd silently vanish from every restore.
// The main window registers a tile when it pops out; the widget heartbeats
// its entry (~5s) while alive. Restore-time rules (main.ts restoreSession):
//   lastSeen within ~20s of now            → widget still open, leave it alone
//   lastSeen ≥ persisted ts − 10 min       → died with the app: offer/restore it
//   older                                  → deliberately closed long before
//                                             shutdown: prune the entry
// Widgets write ONLY their own entry here — the main-grid persistence guard
// (disablePersistence) covers cldctrl.session.v1, not this key.
const POPOUT_KEY = 'cldctrl.popouts.v1';
export interface PopoutEntry { tile: CockpitTile; lastSeen: number }

export function loadPopouts(): Record<string, PopoutEntry> {
  try {
    const raw = localStorage.getItem(POPOUT_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' ? map : {};
  } catch { return {}; }
}

function savePopouts(map: Record<string, PopoutEntry>): void {
  try { localStorage.setItem(POPOUT_KEY, JSON.stringify(map)); } catch { /* quota — non-fatal */ }
}

/** Upsert a pop-out's registry entry (register at pop-out time; heartbeat from the widget). */
export function heartbeatPopout(tile: CockpitTile): void {
  const map = loadPopouts();
  map[tile.id] = { tile, lastSeen: Date.now() };
  savePopouts(map);
}

export function removePopout(id: string): void {
  const map = loadPopouts();
  if (!(id in map)) return;
  delete map[id];
  savePopouts(map);
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
