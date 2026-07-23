import './app.css';
import { render } from 'uhtml';
import { appView } from './views.js';
import { getState, subscribe, setData, setConnError, setUi, setTranscript, setDetail, resetDetail, setSearch, setCockpit, loadPersistedSession, clearPersistedSession, disablePersistence, loadPopouts, heartbeatPopout, removePopout } from './store.js';
import type { CockpitTile, RestoreItem } from './store.js';
import type { DetailTab } from './types.js';
import {
  fetchOverview, fetchTranscript, fetchTranscriptMeta, postLaunch,
  fetchProjectSessions, fetchProjectCommits, fetchProjectIssues, fetchProjectFiles, fetchProjectActivity, fetchSearch, postBridge, postScreenshot, postReveal, postPopout, postHandoffBrief, fetchNotes, postRestart, postShutdown,
} from './api.js';
import { initRouter, writeHash } from './router.js';
import { syncCockpit, restartTile, toggleTileNote, injectIntoTile, docToggle, docSave, docSpeak, focusWaitingTile, clearTileAttn, openAgentScratchpad, activeTileInfo, dockNoteInActiveTile, openControlTile, mountTileStandalone, queueTilePrefill, minimizeTile, restoreTile } from './cockpit.js';
import { syncStats } from './stats.js';
import { toast } from './toast.js';
import { readSession, autoRead, onSpeechState, isSpeaking, isHandsFree, enableHandsFree, disableHandsFree } from './speech.js';
import { initTheme, applyTheme } from './theme.js';
import type { ThemeId } from './theme.js';
import * as lifecycle from './lifecycle.js';
import { onOverview, onOverviewError, announceRestarting, announceRestartAborted, announceStopping } from './lifecycle.js';

// Test seam: the app ships as one bundle, so an e2e can't `import()` a module by
// URL to drive the restart/reconnect state machine against the REAL shipped code.
// Exposing it costs nothing (this dashboard is localhost-only) and keeps the
// lifecycle tests honest instead of re-implementing the logic in the test.
(window as unknown as { cldctrlLifecycle?: typeof lifecycle }).cldctrlLifecycle = lifecycle;

const appRoot = document.getElementById('app')!;

// Widget mode: this window is a single popped-out conversation (?widget=1), not
// the full dashboard. It mounts one tile full-window, never persists layout
// state (shared localStorage with the main window!), and skips the router/poll.
const WIDGET = new URLSearchParams(location.search).get('widget') === '1';


// ── window identity: live title + favicon attention badge ───
// In app mode the OS titlebar and taskbar ARE the app's chrome — carry live
// status there: "● 2 waiting — CLD CTRL" plus an amber dot on the caret icon,
// so a backgrounded/minimized window still shows conversations need input.
let lastWaiting = -1;
let iconBase: HTMLImageElement | null = null;
function updateWindowIdentity(waiting: number): void {
  if (waiting === lastWaiting) return;
  lastWaiting = waiting;
  document.title = waiting > 0 ? `● ${waiting} waiting — CLD CTRL` : '⌃ CLD CTRL';
  const draw = () => {
    if (!iconBase || !iconBase.complete || !iconBase.naturalWidth) return;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    if (!g) return;
    g.drawImage(iconBase, 0, 0, 64, 64);
    if (waiting > 0) {
      g.beginPath(); g.arc(50, 50, 12, 0, Math.PI * 2);
      g.fillStyle = '#f59e0b'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#070a10'; g.stroke();
    }
    let link = document.getElementById('dyn-icon') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = 'dyn-icon'; link.rel = 'icon'; (link as any).type = 'image/png';
      document.head.appendChild(link);
    }
    link.href = c.toDataURL('image/png');
  };
  if (!iconBase) { iconBase = new Image(); iconBase.src = '/icon-192.png'; iconBase.onload = draw; }
  else draw();
}

// ── render ───────────────────────────────────────────────────
let prevNewSessionOpen = false;
let prevSearchOpen = false;
let prevViewKey = '';
function renderApp(): void {
  const state = getState();

  // Preserve text-input focus + caret across the re-render (typing re-renders
  // the app to show results, and uhtml may recreate the input node).
  const active = document.activeElement as HTMLInputElement | null;
  // A native <select>'s open dropdown collapses if we re-render the tree beneath
  // it — so a 3s poll would snap the theme menu shut mid-hover. Skip this tick
  // while a <select> is focused/open; the next poll (or the user's change) catches up.
  if (active && active.tagName === 'SELECT') return;
  const PRESERVE_FOCUS = ['search-input', 'cockpit-add-search', 'newsession-prompt', 'notes-search'];
  const focusedId = active?.id && PRESERVE_FOCUS.includes(active.id) ? active.id : null;
  const caret = focusedId ? active!.selectionStart : null;

  // Transcript follows the tail ONLY if you're already at the bottom — so
  // scrolling up to read earlier output isn't yanked back down every poll.
  const trBefore = document.getElementById('transcript');
  const trWasAtBottom = trBefore ? (trBefore.scrollHeight - trBefore.scrollTop - trBefore.clientHeight < 40) : true;

  // Preserve scroll across the 3s poll re-render: the projects zone (.side-scroll)
  // always; the main content (.main) only when the view is unchanged, so real
  // navigation still resets to top.
  const viewKey = (state.ui.selectedProject ?? '') + '|' + state.search.query.trim() + '|' + state.ui.cockpit.tab;
  const sideScroll = (document.querySelector('.side-scroll') as HTMLElement | null)?.scrollTop ?? 0;
  const mainScroll = (document.querySelector('.main') as HTMLElement | null)?.scrollTop ?? 0;

  render(appRoot, appView(state) as Node);
  updateWindowIdentity(state.ui.cockpit.attnTiles?.length ?? 0);

  const ss = document.querySelector('.side-scroll') as HTMLElement | null;
  if (ss && sideScroll) ss.scrollTop = sideScroll;
  {
    const m = document.querySelector('.main') as HTMLElement | null;
    // .main is a persistent fixed scroller now, so reset it to top on real
    // navigation; only restore the prior position on a same-view poll re-render.
    if (m) m.scrollTop = viewKey === prevViewKey ? mainScroll : 0;
  }
  prevViewKey = viewKey;
  document.body.classList.toggle('no-agent', !(state.data?.features.agentTerminal ?? true));
  document.body.classList.toggle('sidebar-collapsed', state.ui.sidebarCollapsed);
  syncCockpit();
  syncStats();

  if (focusedId) {
    const inp = document.getElementById(focusedId) as HTMLInputElement | null;
    if (inp && document.activeElement !== inp) {
      inp.focus();
      if (caret != null) { try { inp.setSelectionRange(caret, caret); } catch { /* ignore */ } }
    }
  }

  const tr = document.getElementById('transcript');
  if (tr && trWasAtBottom) tr.scrollTop = tr.scrollHeight;

  const hf = document.querySelector('[data-act="handsfree-toggle"]') as HTMLElement | null;
  if (hf) { hf.classList.toggle('on', isHandsFree()); if (isSpeaking()) hf.classList.add('on'); }

  if (state.ui.newSessionOpen && !prevNewSessionOpen) {
    const input = document.getElementById('newsession-prompt') as HTMLInputElement | null;
    if (input) { input.focus(); input.value = state.ui.newSessionDraft; }
  }
  prevNewSessionOpen = state.ui.newSessionOpen;

  // Focus the sidebar search field the moment it opens (click or "/").
  if (state.ui.searchOpen && !prevSearchOpen) {
    const inp = document.getElementById('search-input') as HTMLInputElement | null;
    if (inp && document.activeElement !== inp) inp.focus();
  }
  prevSearchOpen = state.ui.searchOpen;
}
if (!WIDGET) subscribe(renderApp);

// ── screenshot → terminal ────────────────────────────────────
async function shoot(target: string): Promise<void> {
  toast('Snip a region… (its path goes into the session)');
  try {
    const r = await postScreenshot(target, 'region');
    toast(r.path ? '✓ Screenshot path added to the session' : '✗ ' + (r.error || 'cancelled'));
  } catch { toast('✗ Screenshot failed'); }
}

// Which session a media-button / hands-free read targets: the most recently
// active session that has an id.
function latestActiveSession() {
  const withId = (getState().data?.sessions ?? []).filter((s) => s.id);
  if (!withId.length) return null;
  const active = withId.filter((s) => s.status === 'active');
  const pool = active.length ? active : withId;
  pool.sort((a, b) => +new Date(b.lastActivity) - +new Date(a.lastActivity));
  return pool[0];
}
function latestActiveSessionId(): string | null { return latestActiveSession()?.id ?? null; }

// Reflect play/stop on every read-aloud control while speaking. Read-aloud now
// lives as a labelled row in the tile's ⋯ menu, so swap the icon + label in place
// — replacing the button's whole innerHTML would wipe that structure out.
onSpeechState((on) => {
  document.querySelectorAll('[data-act="tile-readout"]').forEach((b) => {
    const ic = b.querySelector('.tile-mi-ic');
    const lbl = b.querySelector('.tile-mi-lbl');
    if (ic) {
      ic.innerHTML = on ? '&#9209;' : '&#128266;';
      if (lbl) lbl.textContent = on ? 'Stop reading' : 'Read the latest reply aloud';
    } else {
      b.innerHTML = on ? '&#9209;' : '&#128266;'; // bare icon button (widget window)
    }
    (b as HTMLElement).classList.toggle('on', on);
  });
});

// ── open a project's location (file explorer / VS Code) ──────
async function reveal(projectPath: string, target: 'explorer' | 'code'): Promise<void> {
  try {
    const r = await postReveal(projectPath, target);
    if (!r.ok) toast('✗ ' + (r.error || 'could not open'));
    else toast(target === 'code' ? 'Opening in VS Code…' : 'Opening folder…');
  } catch { toast('✗ open failed'); }
}

// ── cockpit tile helpers ─────────────────────────────────────
// One-shot: explain where a minimized conversation went, the first time per load.
let minimizeExplained = false;

function addResumeTile(sessionId: string, projectPath: string, title: string, openNow: boolean, vendor: 'claude' | 'codex' | 'antigravity' = 'claude'): void {
  const id = 'resume:' + sessionId;
  const cp = getState().ui.cockpit;
  // Match by sessionId, not just tile id: a 'new' tile that has since discovered
  // this session IS this conversation. Without that, clicking its sidebar row
  // would spawn a second `--resume` PTY alongside the one already running.
  const existing = cp.tiles.find((t) => t.id === id
    || ((t.kind === 'new' || t.kind === 'resume') && (t.sessionId === sessionId || t.discoveredSessionId === sessionId)));
  // Opening always reveals the conversation: unmute its project (focus chips) so
  // re-opening an already-open chat doesn't silently appear to do nothing.
  const hiddenProjects = cp.hiddenProjects.filter((p) => p !== projectPath);
  if (existing) {
    // Already here — reveal it (un-park it if minimized) rather than duplicating it.
    setCockpit({ hiddenProjects, open: openNow ? true : cp.open, maximized: null });
    if (openNow) { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
    // restoreTile re-reads the store, so it must run after the patch above; it
    // no-ops (and we just say "focused it") when the tile is already on screen.
    if (existing.minimized) restoreTile(existing.id);
    else toast('Already open — focused it');
    return;
  }
  const suffix = ' · ' + vendor;
  const label = vendor !== 'claude' && !title.endsWith(suffix) ? title + suffix : title; // idempotent (dock-back reuses the tagged title)
  const tiles = [...cp.tiles, { id, kind: 'resume' as const, sessionId, projectPath, title: label, vendor }];
  setCockpit({ tiles, hiddenProjects, open: openNow ? true : cp.open, maximized: null });
  if (openNow) { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
}

function addDocTile(filePath: string, projectPath: string, openNow: boolean, scratch = false): void {
  const id = 'doc:' + filePath;
  const cp = getState().ui.cockpit;
  const title = filePath.split(/[\\/]/).pop() || 'doc';
  const tiles = cp.tiles.some((t) => t.id === id)
    ? cp.tiles
    : [...cp.tiles, { id, kind: 'doc' as const, projectPath, title, filePath, scratch }];
  setCockpit({ tiles, open: openNow ? true : cp.open, maximized: null, addOpen: false });
  if (openNow) { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
}


/** Open a new agent session as a cockpit tile (CTRL launched it from the web, or
 *  the project detail's "New here" split button). `agent` picks the CLI — the
 *  title carries it so a Codex/Antigravity tile is identifiable in the grid. */
function addLaunchTile(projectPath: string, projectName: string | undefined, prompt?: string, agent = 'claude'): void {
  const cp = getState().ui.cockpit;
  const id = 'new:' + projectPath + ':' + Date.now();
  const short = projectName || projectPath.split(/[/\\]/).pop() || projectPath;
  const title = short + ' · new' + (agent !== 'claude' ? ' · ' + agent : '');
  setCockpit({
    tiles: [...cp.tiles, { id, kind: 'new' as const, projectPath, title, agent, prompt }],
    open: true, maximized: null, addOpen: false,
  });
  setUi({ selectedProject: null });
  setSearch({ query: '', results: [] });
  writeHash();
  if (getState().ui.cockpit.tiles.length > 1) setCockpit({ layout: 'cols2' });
}

// ── project detail loading (on tab open, never on the poll) ──
async function loadDetailIfNeeded(): Promise<void> {
  const proj = getState().ui.selectedProject;
  if (!proj) return;
  if (getState().detail.project !== proj) resetDetail(proj);

  // Header activity heatmaps load once per project, independent of the tab.
  if (getState().detail.activity === null) {
    fetchProjectActivity(proj)
      .then((a) => { if (getState().ui.selectedProject === proj) setDetail({ activity: a }); })
      .catch(() => { /* heatmaps optional */ });
  }

  const tab = getState().ui.detailTab;
  const d = getState().detail;
  const loaded = tab === 'sessions' ? d.sessions !== null
    : tab === 'commits' ? d.commits !== null
    : tab === 'issues' ? d.issues !== null
    : d.files[''] !== undefined;
  if (loaded || d.loadingTab === tab) return;

  setDetail({ loadingTab: tab, error: null });
  const stale = () => getState().ui.selectedProject !== proj || getState().ui.detailTab !== tab;
  try {
    if (tab === 'sessions') { const v = await fetchProjectSessions(proj); if (!stale()) setDetail({ sessions: v, loadingTab: null }); }
    else if (tab === 'commits') { const v = await fetchProjectCommits(proj); if (!stale()) setDetail({ commits: v, loadingTab: null }); }
    else if (tab === 'issues') { const v = await fetchProjectIssues(proj); if (!stale()) setDetail({ issues: v, loadingTab: null }); }
    else { const r = await fetchProjectFiles(proj, ''); if (!stale()) setDetail({ files: { ...getState().detail.files, '': r.nodes }, loadingTab: null }); }
  } catch {
    if (!stale()) setDetail({ loadingTab: null, error: 'Failed to load ' + tab });
  }
}

// ── transcript loading (decoupled cadence) ───────────────────
async function refreshTranscript(): Promise<void> {
  const id = getState().ui.expandedSessionId;
  if (!id) return;
  try {
    const entries = await fetchTranscript(id);
    if (getState().ui.expandedSessionId === id) setTranscript({ id, entries });
  } catch { /* keep old content */ }
}

// ── poll loop (overview only — detail is event-driven) ───────
let lastBridgeTs = 0;
let lastScratchTs = 0;
let lastCockpitLaunchTs = 0;
let lastCockpitInjectTs = 0;
async function poll(): Promise<void> {
  try {
    const data = await fetchOverview();
    setData(data);
    // Detect a server restart (instanceId changed / recovered from an outage) and
    // reload so a fresh build + dead WebSockets resync against the new process.
    onOverview(data.instanceId);
    // Record the real sessionId each 'new' tile's agent created, so a restart can
    // resume the SAME conversation (no manual /resume). Persisted with the tile.
    const tsMap = data.terminalSessions;
    if (tsMap) {
      const cp = getState().ui.cockpit;
      let changed = false;
      const tiles = cp.tiles.map((t) => {
        if (t.kind === 'new' && tsMap[t.id] && t.discoveredSessionId !== tsMap[t.id]) { changed = true; return { ...t, discoveredSessionId: tsMap[t.id] }; }
        return t;
      });
      if (changed) setCockpit({ tiles });
    }
    // Adopt a search the control-plane agent pushed — but only a recent one, so
    // a fresh page load doesn't resurrect a stale push.
    const b = data.bridge;
    if (b && b.ts > lastBridgeTs && Date.now() - b.ts < 5 * 60_000) {
      lastBridgeTs = b.ts;
      setSearch({ query: b.query, results: b.results, loading: false, agentNote: b.note ?? '' });
    } else if (b && b.ts > lastBridgeTs) {
      lastBridgeTs = b.ts; // mark seen without adopting
    }
    // A scratchpad the agent requested (recent only). One notepad system: dock it as
    // the active conversation's notepad; only if there's no terminal tile to dock onto
    // do we fall back to a standalone doc tile (so the draft is never lost).
    const sc = data.scratch;
    if (sc && sc.ts > lastScratchTs) {
      lastScratchTs = sc.ts;
      if (Date.now() - sc.ts < 5 * 60_000) {
        if (openAgentScratchpad(sc.path, sc.tile)) {
          if (getState().ui.cockpit.tiles.length > 1) setCockpit({ layout: 'cols2' });
        } else {
          addDocTile(sc.path, '', true, true);
          if (getState().ui.cockpit.tiles.length > 1) setCockpit({ layout: 'cols2' });
        }
      }
    }
    // Open new sessions as cockpit tiles when CTRL launched them from the web
    // surface. It's a QUEUE: adopt every entry newer than the last one we saw
    // (recent only, so a fresh load doesn't replay stale launches) — two rapid
    // launches no longer clobber each other.
    for (const cl of data.cockpitLaunches ?? []) {
      if (cl.ts <= lastCockpitLaunchTs) continue;
      lastCockpitLaunchTs = cl.ts;
      if (Date.now() - cl.ts >= 60_000) continue;
      // agent + brief = an MCP-triggered handoff: new tile with that agent,
      // prefilled with the brief (reviewed + Sent by the operator).
      if (cl.agent && cl.handoffBrief) {
        const short = cl.project || cl.projectPath.split(/[/\\]/).pop() || 'conversation';
        const id = 'new:' + cl.projectPath + ':' + Date.now();
        const cp = getState().ui.cockpit;
        setCockpit({
          tiles: [...cp.tiles, { id, kind: 'new', projectPath: cl.projectPath, title: short + ' · ' + cl.agent + ' (handoff)', agent: cl.agent, handoffFrom: cl.handoffFrom }],
          open: true, maximized: null,
        });
        setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash();
        queueTilePrefill(id, cl.handoffBrief);
        toast('Handoff → ' + cl.agent + ': review the brief in the new tile, then Send');
      }
      // sessionId = resume that conversation as a tile; else spawn a fresh one.
      else if (cl.sessionId) addResumeTile(cl.sessionId, cl.projectPath, cl.project || cl.projectPath.split(/[/\\]/).pop() || 'conversation', true);
      else addLaunchTile(cl.projectPath, cl.project, cl.prompt);
    }
    // Message-in (#9): inject a message into a running cockpit session. Match by the
    // tile's sessionId (resume) or the sessionId its 'new' agent created. Prefills
    // the target's compose-box (confirm/edit) unless autoSend was requested.
    for (const inj of data.cockpitInjects ?? []) {
      if (inj.ts <= lastCockpitInjectTs) continue;
      lastCockpitInjectTs = inj.ts;
      if (Date.now() - inj.ts > 60_000) continue;
      const tile = getState().ui.cockpit.tiles.find(
        (t) => t.sessionId === inj.sessionId || t.discoveredSessionId === inj.sessionId,
      );
      if (!tile) { toast('↪ Message for a session that isn’t open here'); continue; }
      // Reveal the tile (unmute its project, drop any maximize) so the prefill is visible.
      setCockpit({ hiddenProjects: getState().ui.cockpit.hiddenProjects.filter((p) => p !== tile.projectPath), maximized: null });
      const ok = injectIntoTile(tile.id, inj.text, !!inj.autoSend);
      toast(ok ? (inj.autoSend ? '↪ Message sent into ' + tile.title : '↪ Message ready in ' + tile.title + ' — review & send') : '✗ Could not reach that tile');
    }
    // Listen mode: speak each new assistant reply of the active session.
    if (isHandsFree()) { const t = latestActiveSession(); if (t) autoRead({ id: t.id, assistantTurns: t.assistantTurns }); }
  } catch { setConnError(true); onOverviewError(); }
  await refreshTranscript();
}

// ── agent handoff ────────────────────────────────────────────
function closeHandoffMenu(): void { document.getElementById('handoff-menu')?.remove(); }
/** Show a small menu of the OTHER available agents anchored under the ⇄ button. */
function openHandoffMenu(btn: HTMLElement): void {
  closeHandoffMenu();
  const id = btn.dataset.id!;
  const tile = getState().ui.cockpit.tiles.find((t) => t.id === id);
  if (!tile) return;
  const session = tile.kind === 'new' ? getState().data?.terminalSessions?.[id] : tile.sessionId;
  if (!session) { toast('One moment — this session is still initializing'); return; }
  const curAgent = tile.kind === 'new' ? (tile.agent || 'claude') : (tile.vendor || 'claude');
  const agents = (getState().data?.features.agents || []).filter((a) => a.available && a.id !== curAgent);
  if (!agents.length) { toast('No other agents available to hand off to'); return; }
  const menu = document.createElement('div');
  menu.className = 'handoff-menu'; menu.id = 'handoff-menu';
  const hd = document.createElement('div'); hd.className = 'handoff-menu-hd'; hd.textContent = 'Continue this work in…'; menu.appendChild(hd);
  for (const a of agents) {
    const b = document.createElement('button');
    b.className = 'handoff-opt'; b.dataset.act = 'handoff-to';
    b.dataset.session = session; b.dataset.path = tile.projectPath; b.dataset.vendor = curAgent;
    b.dataset.agent = a.id; b.dataset.agentlabel = a.label; b.textContent = a.label;
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - 190, window.innerWidth - 200)) + 'px';
}
/** Build the on-disk brief and open a NEW sibling tile with the chosen agent,
 *  prefilled with the brief (review + Send). The original tile is untouched. */
async function startHandoff(session: string, projectPath: string, vendor: string, toAgent: string, agentLabel: string): Promise<void> {
  toast('Preparing handoff brief…');
  const r = await postHandoffBrief(session);
  if (!r.ok || !r.brief) { toast('✗ ' + (r.error || 'could not build the handoff brief')); return; }
  const proj = r.projectPath || projectPath;
  const short = r.project || proj.split(/[/\\]/).pop() || proj;
  const id = 'new:' + proj + ':' + Date.now();
  const cp = getState().ui.cockpit;
  setCockpit({
    tiles: [...cp.tiles, { id, kind: 'new', projectPath: proj, title: short + ' · ' + agentLabel + ' (handoff)', agent: toAgent, handoffFrom: { sessionId: session, vendor } }],
    open: true, maximized: null,
  });
  setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash();
  queueTilePrefill(id, r.brief); // dropped into the new tile's compose box on mount
  toast('Handoff → ' + agentLabel + ': review the brief in the new tile, then Send');
}

// ── dashboard power menu (⏻ restart / stop) ──────────────────
function closePowerMenu(): void { document.getElementById('power-menu')?.remove(); }
/** Restart the dashboard in place: show the "Updating…" overlay, then ask the
 *  server to restart. The page reloads onto the new instance via the lifecycle
 *  detector. Shared by the ⏻ menu's Restart and the "restart to load" pill. */
function triggerRestart(): void {
  closePowerMenu();
  doRestart();
}
/** The actual bounce, with no questions asked (confirmRestart gates the callers). */
function doRestart(): void {
  cancelRestartWait();
  announceRestarting();
  postRestart()
    .then((r) => {
      // Refused outright (demo mode) — nothing is bouncing, so take the overlay
      // down now rather than leaving a spinner for the timeout to clear.
      if (r?.disabled) { announceRestartAborted(); toast('Restart is unavailable in demo mode'); return; }
      // The server couldn't even start its restart helper. Say so immediately
      // instead of spinning for the 15s "didn't take" timeout to notice.
      if (r && r.ok === false) {
        announceRestartAborted();
        toast('✗ ' + (r.error || 'Restart failed — run `cc restart` in a terminal'));
      }
    })
    .catch(() => { /* the server is bouncing — the reconnect overlay handles it */ });
}
// ── restart safety gate ──────────────────────────────────────
// A restart HARD-KILLS every agent PTY (serve.ts shutdownTerminals → term.kill()).
// The conversation survives — it's on disk and the tile re-spawns `--resume` — but
// an in-flight turn does not: a partial reply or a half-finished tool call is lost.
// The ⏻ menu warned about open sessions; the "restart to load" notice didn't, and
// that's the one people click casually the moment a build lands. So both now go
// through this gate whenever a conversation is mid-turn.

/** Conversations that are WORKING right now, i.e. would lose an in-flight turn.
 *  A tile flagged "waiting" has finished its turn and is safe to interrupt; one
 *  that's live but not waiting is mid-turn. */
function busyTiles(): { busy: string[]; total: number } {
  const cp = getState().ui.cockpit;
  const attn = new Set(cp.attnTiles ?? []);
  const sessions = getState().data?.sessions ?? [];
  const working = new Set(sessions.filter((s) => s.status === 'active' && s.id).map((s) => s.id!));
  const discovered = getState().data?.terminalSessions ?? {};
  const tiles = cp.tiles.filter((t) => t.kind === 'new' || t.kind === 'resume' || t.kind === 'control');
  const busy: string[] = [];
  for (const t of tiles) {
    if (attn.has(t.id)) continue; // finished its turn — safe
    const sid = t.kind === 'new' ? (discovered[t.id] ?? t.discoveredSessionId) : t.sessionId;
    // No session id yet = just launched and still starting: treat as busy, since
    // that's the case that can't resume at all.
    if (!sid || working.has(sid)) busy.push(t.title || t.id);
  }
  return { busy, total: tiles.length };
}

let restartWaitTimer: ReturnType<typeof setInterval> | null = null;
function cancelRestartWait(): void {
  if (restartWaitTimer) { clearInterval(restartWaitTimer); restartWaitTimer = null; }
  document.getElementById('restart-confirm')?.remove();
}

/** Gate a restart on live work. Goes straight through when nothing is mid-turn. */
function confirmRestart(): void {
  closePowerMenu();
  const { busy, total } = busyTiles();
  if (!busy.length) { doRestart(); return; } // nothing in flight — just go
  cancelRestartWait();

  const wrap = document.createElement('div');
  wrap.id = 'restart-confirm';
  wrap.className = 'confirm-backdrop';
  const names = busy.slice(0, 3).map((n) => '<li>' + n.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) + '</li>').join('');
  wrap.innerHTML = `
    <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="rc-t">
      <h3 id="rc-t">Restart while ${busy.length === 1 ? 'a conversation is' : busy.length + ' conversations are'} working?</h3>
      <p>Restarting interrupts ${busy.length === 1 ? 'its current turn' : 'their current turns'}. The
         ${total === 1 ? 'conversation reopens' : 'conversations reopen'} afterwards and the history is kept —
         but whatever ${busy.length === 1 ? 'it is' : 'they are'} part-way through right now is lost.</p>
      <ul class="confirm-list">${names}${busy.length > 3 ? `<li>+${busy.length - 3} more</li>` : ''}</ul>
      <div class="confirm-actions">
        <button class="btn primary" data-rc="wait">Wait until idle, then restart</button>
        <button class="btn danger" data-rc="force">Restart now</button>
        <button class="btn" data-rc="cancel">Cancel</button>
      </div>
      <div class="confirm-status" data-rc-status></div>
    </div>`;
  document.body.appendChild(wrap);

  const status = wrap.querySelector('[data-rc-status]') as HTMLElement;
  wrap.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t === wrap) { cancelRestartWait(); return; } // backdrop click = cancel
    const act = t.closest('[data-rc]')?.getAttribute('data-rc');
    if (act === 'cancel') { cancelRestartWait(); return; }
    if (act === 'force') { cancelRestartWait(); doRestart(); return; }
    if (act === 'wait') {
      // Poll until every conversation has finished its turn, then bounce. The
      // dialog stays up (showing what it's waiting on) so it's always cancellable
      // — an agent can run for a long time, and this must never become a trap.
      (wrap.querySelector('[data-rc="wait"]') as HTMLButtonElement).disabled = true;
      const tick = () => {
        const now = busyTiles().busy;
        if (!now.length) { cancelRestartWait(); doRestart(); return; }
        status.textContent = `Waiting for ${now.length} conversation${now.length === 1 ? '' : 's'} to finish… (Cancel or Restart now still work)`;
      };
      tick();
      if (!restartWaitTimer) restartWaitTimer = setInterval(tick, 1500);
    }
  });
}

/** Count the OPEN conversation tiles a restart/stop would close, and how many
 *  can auto-resume. Doc tiles aren't sessions; the CTRL dock reopens from the
 *  sidebar (and continues via --continue), so it's not counted as "at risk". */
function liveSessionSummary(): { total: number; atRisk: number } {
  const tiles = getState().ui.cockpit.tiles.filter((t) => t.kind === 'new' || t.kind === 'resume');
  const tsMap = getState().data?.terminalSessions || {};
  let atRisk = 0;
  for (const t of tiles) {
    // A 'new' tile is resumable once its agent's sessionId has been discovered;
    // until then a restart may fork it into a fresh conversation.
    if (t.kind === 'new' && !t.discoveredSessionId && !tsMap[t.id]) atRisk++;
  }
  return { total: tiles.length, atRisk };
}
/** Open the ⏻ power menu ABOVE its button (it sits at the sidebar bottom). */
function openPowerMenu(btn: HTMLElement): void {
  closePowerMenu();
  const { total, atRisk } = liveSessionSummary();
  const menu = document.createElement('div');
  menu.className = 'power-menu'; menu.id = 'power-menu';
  const hd = document.createElement('div'); hd.className = 'power-menu-hd'; hd.textContent = 'Dashboard server'; menu.appendChild(hd);
  if (total > 0) {
    const note = document.createElement('div'); note.className = 'power-menu-note';
    note.textContent = `${total} agent session${total > 1 ? 's' : ''} open`
      + (atRisk > 0 ? ` — ${atRisk} just started and may not resume` : '');
    menu.appendChild(note);
  }
  const mk = (act: string, label: string, sub: string) => {
    const b = document.createElement('button'); b.className = 'power-opt'; b.dataset.act = act;
    const l = document.createElement('span'); l.className = 'power-opt-label'; l.textContent = label;
    const s = document.createElement('span'); s.className = 'power-opt-sub'; s.textContent = sub;
    b.appendChild(l); b.appendChild(s); return b;
  };
  menu.appendChild(mk('power-restart', '↻ Restart', total > 0 ? 'Load the latest build; sessions reopen' : 'Load the latest build'));
  menu.appendChild(mk('power-stop', '⏻ Stop server', 'Shut down — restart from a terminal with cc'));
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.max(8, r.top - 6 - menu.offsetHeight) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
}

function closeAboutMenu(): void { document.getElementById('about-menu')?.remove(); }
/** About / help popover — app version, a plain anonymous-usage disclosure line, and
 *  a couple of links. Opens ABOVE its sidebar-bottom button, same as the power menu.
 *  There is no in-app opt-out toggle (the tracking is a basic, content-free head
 *  count); the disclosure just states plainly what the update ping records. */
function openAboutMenu(btn: HTMLElement): void {
  closeAboutMenu();
  const d = getState().data;
  const envLocked = !!d?.telemetry?.envLocked;
  const menu = document.createElement('div');
  menu.className = 'power-menu about-menu'; menu.id = 'about-menu';

  const hd = document.createElement('div'); hd.className = 'power-menu-hd';
  hd.textContent = 'CLD CTRL' + (d?.version ? '  ·  v' + d.version : '');
  menu.appendChild(hd);

  // A disclosure, not a control. Reflects DO_NOT_TRACK if it happens to be set
  // (we still honor that env standard silently) so the line stays truthful.
  const note = document.createElement('div'); note.className = 'about-note';
  note.textContent = envLocked
    ? 'Anonymous usage is off — DO_NOT_TRACK is set in your environment.'
    : 'Anonymous usage: the update check keeps a basic, anonymous head count — app version + a coarse region only. Never your code, file names, or conversations.';
  menu.appendChild(note);

  const link = (label: string, href: string) => {
    const a = document.createElement('button'); a.className = 'power-opt about-link';
    a.dataset.act = 'about-link'; a.dataset.href = href;
    const l2 = document.createElement('span'); l2.className = 'power-opt-label'; l2.textContent = label;
    a.appendChild(l2); return a;
  };
  menu.appendChild(link('↗ Project on GitHub', 'https://github.com/RyanSeanPhillips/cldctrl'));
  menu.appendChild(link('↗ cld-ctrl.com', 'https://cld-ctrl.com'));

  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.max(8, r.top - 6 - menu.offsetHeight) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
}

// ── per-tile ⋯ overflow menu ─────────────────────────────────
// The rows live INSIDE the tile header (hidden), not in a body-level popup, so
// every existing querySelector-based handler and the reveal-when-ready wiring in
// syncCockpit/setReadSession keeps working on the same nodes. `.tile` clips
// overflow, so the tile gets `menu-open` to un-clip only while a menu is showing.
function closeTileMenus(): void {
  document.querySelectorAll('.tile-menu').forEach((m) => { (m as HTMLElement).style.display = 'none'; });
  document.querySelectorAll('.tile.menu-open').forEach((t) => t.classList.remove('menu-open'));
}
function toggleTileMenu(btn: HTMLElement): void {
  const menu = btn.parentElement?.querySelector('.tile-menu') as HTMLElement | null;
  if (!menu) return;
  const wasOpen = menu.style.display !== 'none';
  closeTileMenus();
  if (wasOpen) return;
  menu.style.display = '';
  btn.closest('.tile')?.classList.add('menu-open');
}

// ── event delegation ─────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  // Close an open handoff menu on any outside click (option clicks are inside it).
  const hm = document.getElementById('handoff-menu');
  if (hm && !hm.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('[data-act="tile-handoff"]')) closeHandoffMenu();
  // Same for the power menu.
  const pm = document.getElementById('power-menu');
  if (pm && !pm.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('[data-act="power-menu"]')) closePowerMenu();
  // ...and the About menu (but keep it open when the telemetry toggle is clicked,
  // so you see the checkbox flip in place instead of the menu vanishing).
  const am = document.getElementById('about-menu');
  if (am && !am.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('[data-act="about-menu"]')) closeAboutMenu();
  // Per-tile ⋯ overflow menus: close on any click that isn't the ⋯ button itself.
  // Clicking a row inside one runs its action AND dismisses the menu, which is
  // what you want — every row is a one-shot command.
  if (!(ev.target as HTMLElement).closest('[data-act="tile-more"]')) closeTileMenus();
  // Click on a picker backdrop (but not its panel) closes it. Notes first — its
  // backdrop also carries cp-add-backdrop for styling, so check the specific class.
  if ((ev.target as HTMLElement).classList?.contains('notes-backdrop')) { setCockpit({ notesOpen: false }); return; }
  if ((ev.target as HTMLElement).classList?.contains('cp-add-backdrop')) { setCockpit({ addOpen: false }); return; }
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.act;
  const ui = getState().ui;

  // Widget window: close means close the WINDOW (the PTY lives server-side);
  // dock hands the conversation back to the main window; maximize/pop-out are
  // hidden by CSS but guard anyway. All other tile actions (notepad, restart,
  // screenshot, read-aloud, reveal) fall through unchanged.
  if (WIDGET) {
    // Explicit ✕ = a deliberate close: drop the registry entry so a later
    // restart doesn't offer to resurrect a window the user chose to close.
    if (act === 'tile-close') { if (widgetTile) removePopout(widgetTile.id); window.close(); return; }
    if (act === 'tile-dock') { requestDockBack(); return; }
    // Minimize parks a tile in the MAIN window's sidebar — a pop-out has no
    // sidebar to park into, so it's hidden by CSS there (dock back first).
    if (act === 'tile-max' || act === 'tile-popout' || act === 'tile-min') return;
  }

  if (act === 'theme') { applyTheme(el.dataset.theme as ThemeId); renderApp(); }
  else if (act === 'update-open') {
    const cmd = 'npm i -g cldctrl';
    navigator.clipboard?.writeText(cmd).then(() => toast('Copied: ' + cmd + ' — run it to update'))
      .catch(() => toast('To update, run:  ' + cmd));
  } else if (act === 'update-dismiss') {
    try { localStorage.setItem('cldctrl-dismissed-update', el.dataset.ver || ''); } catch { /* ignore */ }
    renderApp();
  } else if (act === 'privacy-ack') {
    // First-run telemetry disclosure acknowledged — never show it again.
    try { localStorage.setItem('cldctrl-privacy-ack', '1'); } catch { /* ignore */ }
    renderApp();
  } else if (act === 'restart-open' || act === 'power-restart') {
    // The "restart to load" notice and the ⏻ menu's Restart share one path — and
    // both now check for mid-turn work first (confirmRestart no-ops when idle).
    confirmRestart();
  } else if (act === 'power-menu') {
    if (document.getElementById('power-menu')) closePowerMenu(); else openPowerMenu(el);
  } else if (act === 'power-stop') {
    closePowerMenu();
    announceStopping();
    postShutdown().catch(() => { /* the server is going down — a failed fetch is expected */ });
  } else if (act === 'about-menu') {
    if (document.getElementById('about-menu')) closeAboutMenu(); else openAboutMenu(el);
  } else if (act === 'about-link') {
    const href = el.closest('[data-act="about-link"]')?.getAttribute('data-href');
    if (href) { try { window.open(href, '_blank', 'noopener'); } catch { /* ignore */ } }
    closeAboutMenu();
  }
  else if (act === 'openincockpit') {
    const v = el.dataset.vendor;
    addResumeTile(el.dataset.id!, el.dataset.path!, el.dataset.title || el.dataset.path!, true, v === 'codex' || v === 'antigravity' ? v : 'claude');
  } else if (act === 'cockpit-add-toggle') {
    const cp = getState().ui.cockpit;
    setCockpit({ addOpen: !cp.addOpen, addQuery: '', addResults: [] });
  } else if (act === 'cockpit-add-close') {
    setCockpit({ addOpen: false });
  } else if (act === 'cockpit-notes') {
    setCockpit({ notesOpen: true, notesQuery: '', notesScope: activeTileInfo() ? 'project' : 'all', notesResults: [] });
    loadNotes();
  } else if (act === 'notes-close') {
    setCockpit({ notesOpen: false });
  } else if (act === 'notes-scope') {
    setCockpit({ notesScope: el.dataset.scope as 'conversation' | 'project' | 'all', notesResults: [] });
    loadNotes();
  } else if (act === 'notes-open') {
    const p = el.dataset.path!;
    if (!dockNoteInActiveTile(p)) addDocTile(p, '', true, false); // no chat tile → open standalone
    setCockpit({ notesOpen: false });
  } else if (act === 'cockpit-add-resume') {
    addResumeTile(el.dataset.id!, el.dataset.path!, el.dataset.title || el.dataset.path!, false);
    setCockpit({ addOpen: false, addQuery: '', addResults: [] });
  } else if (act === 'cockpit-add-new') {
    const sel = document.getElementById('cockpit-new-project') as HTMLSelectElement | null;
    const projectPath = sel?.value;
    if (projectPath) {
      const cp = getState().ui.cockpit;
      const wt = (document.getElementById('cockpit-new-worktree') as HTMLInputElement | null)?.checked ?? false;
      const branchInput = (document.getElementById('cockpit-new-branch') as HTMLInputElement | null)?.value.trim();
      const branch = wt ? (branchInput || 'cockpit/session-' + (cp.tiles.length + 1)) : undefined;
      const agent = (document.querySelector('input[name="cp-agent"]:checked') as HTMLInputElement | null)?.value || 'claude';
      const id = 'new:' + projectPath + ':' + Date.now();
      const short = projectPath.split(/[/\\]/).pop() || projectPath;
      const agentTag = agent !== 'claude' ? ' · ' + agent : '';
      const title = (wt ? short + ' · ' + branch : short + ' · new') + agentTag;
      setCockpit({ tiles: [...cp.tiles, { id, kind: 'new', projectPath, title, worktree: wt, branch, agent }], open: true, maximized: null, addOpen: false });
    }
  } else if (act === 'cockpit-layout') {
    setCockpit({ layout: el.dataset.layout as 'cols1' | 'cols2' | 'grid', maximized: null });
  } else if (act === 'tile-close') {
    const cp = getState().ui.cockpit;
    const tiles = cp.tiles.filter((t) => t.id !== el.dataset.id);
    // Cockpit is the always-open home surface — closing the last tile leaves an
    // empty cockpit (with its "+ Add" prompt), it never flips the view off.
    setCockpit({ tiles, open: true, maximized: cp.maximized === el.dataset.id ? null : cp.maximized });
  } else if (act === 'tile-more') {
    toggleTileMenu(el);
  } else if (act === 'tile-min') {
    minimizeTile(el.dataset.id!);
    // Say where it went — the tile vanishing from the grid otherwise reads as a
    // close, which is exactly the confusion minimize exists to remove.
    if (!minimizeExplained) { minimizeExplained = true; toast('Minimized — still running. Click it in the sidebar list to bring it back.'); }
  } else if (act === 'tile-restore') {
    restoreTile(el.dataset.id!);
    setUi({ selectedProject: null });
    setSearch({ query: '', results: [] });
    setCockpit({ open: true, tab: 'grid' });
    writeHash();
  } else if (act === 'tile-max') {
    const cp = getState().ui.cockpit;
    const id = el.dataset.id!;
    const maximizing = cp.maximized !== id;
    setCockpit({ maximized: maximizing ? id : null });
    if (maximizing) clearTileAttn(id); // you're now looking at it
  } else if (act === 'cockpit-waiting') {
    focusWaitingTile();
  } else if (act === 'tile-restart') {
    restartTile(el.dataset.id!);
  } else if (act === 'tile-handoff') {
    openHandoffMenu(el);
  } else if (act === 'handoff-to') {
    closeHandoffMenu();
    void startHandoff(el.dataset.session!, el.dataset.path!, el.dataset.vendor || 'claude', el.dataset.agent!, el.dataset.agentlabel || el.dataset.agent!);
  } else if (act === 'tile-popout') {
    // Pop this conversation out into its own chromeless window. Launch FIRST,
    // remove the grid tile only once the window is confirmed — the widget then
    // attaches to the same server PTY (10-min idle grace, replay on attach).
    const id = el.dataset.id!;
    const t = getState().ui.cockpit.tiles.find((x) => x.id === id);
    if (!t || (t.kind !== 'resume' && t.kind !== 'new')) return;
    // 'new' tiles pop out by their own terminal key; the discovered session rides
    // along as the reattach fallback + usage-meter id.
    const session = t.kind === 'new' ? getState().data?.terminalSessions?.[id] : t.sessionId;
    if (!session) { toast('One moment — this session is still initializing'); return; }
    el.setAttribute('disabled', '1'); // no double-launch on double-click
    const r = await postPopout({ kind: t.kind, id: t.id, session, path: t.projectPath, title: t.title, agent: t.agent, vendor: t.vendor });
    const opened = r.ok || (r.fallback && r.url && window.open(r.url, '_blank', 'popup,width=980,height=720') != null);
    if (opened) {
      // Track it: popped-out conversations live outside the persisted grid, so
      // the registry is what lets restart-restore find them again.
      heartbeatPopout({ ...t, sessionId: session });
      const cp = getState().ui.cockpit;
      setCockpit({ tiles: cp.tiles.filter((x) => x.id !== id), open: true, maximized: cp.maximized === id ? null : cp.maximized });
      toast('Popped out — dock it back with the tile’s ⇘ button (or the sidebar)');
    } else {
      el.removeAttribute('disabled');
      toast('✗ Pop-out failed' + (r.error ? ': ' + r.error : ''));
    }
  } else if (act === 'doc-toggle') {
    docToggle(el.dataset.id!);
  } else if (act === 'doc-save') {
    docSave(el.dataset.id!);
  } else if (act === 'doc-speak') {
    docSpeak(el.dataset.id!);
  } else if (act === 'opendoc') {
    if (el.dataset.path) addDocTile(el.dataset.path, getState().ui.selectedProject ?? '', true);
  } else if (act === 'cockpit-add-doc') {
    const proj = (document.getElementById('cockpit-doc-project') as HTMLSelectElement | null)?.value;
    const rel = (document.getElementById('cockpit-doc-path') as HTMLInputElement | null)?.value.trim();
    if (proj && rel) {
      const filePath = proj.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      addDocTile(filePath, proj, true);
    }
  } else if (act === 'tile-focus') {
    // header click focuses the terminal (but not when a header button was hit)
    if (!(ev.target as HTMLElement).closest('.btn')) {
      const term = (el.closest('.tile') as HTMLElement)?.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      term?.focus();
    }
  }
  else if (act === 'open-control') {
    // CTRL → open the mission-control agent as an on-demand pinned cockpit tile.
    // Land on the cockpit grid (clear project/search) so the tile is visible — mirror
    // the nav-cockpit cleanup so collapsed-search + the bridge don't go stale.
    const hadQuery = !!getState().search.query.trim();
    setCockpit({ tab: 'grid' });
    setUi({ selectedProject: null, searchOpen: false });
    setSearch({ query: '', results: [], loading: false, agentNote: null });
    if (hadQuery) postBridge('', null);
    openControlTile();
    writeHash();
  }
  else if (act === 'tile-shot') { shoot(el.dataset.id!); }
  else if (act === 'tile-note') { toggleTileNote(el.dataset.id!); }
  else if (act === 'tile-reveal' || act === 'tile-code') { reveal(el.dataset.path!, act === 'tile-code' ? 'code' : 'explorer'); }
  else if (act === 'tile-readout') { readSession(el.dataset.session); }
  else if (act === 'handsfree-toggle') {
    if (isHandsFree()) { disableHandsFree(); toast('Hands-free off'); }
    else {
      const ok = enableHandsFree(latestActiveSessionId);
      toast(ok ? '🎧 Listen mode on — reads new replies aloud; media buttons play/stop' : '✗ Media controls unavailable in this browser');
    }
    renderApp();
  }
  else if (act === 'restore-accept') {
    // Banner "Restore all": everything back where it was (dest = origin).
    const o = getState().ui.restoreOffer;
    if (o) void applyRestore(o.items.map((i) => ({ ...i, dest: i.origin })), o.layout);
  }
  else if (act === 'restore-choose') {
    const o = getState().ui.restoreOffer;
    if (o) { setUi({ restoreOffer: { ...o, chooserOpen: true } }); enrichRestoreItems(); }
  }
  else if (act === 'restore-chooser-close') {
    const o = getState().ui.restoreOffer;
    if (o) setUi({ restoreOffer: { ...o, chooserOpen: false } });
  }
  else if (act === 'restore-apply') {
    const o = getState().ui.restoreOffer;
    if (o) void applyRestore(o.items, o.layout);
  }
  else if (act === 'restore-peek') {
    const o = getState().ui.restoreOffer;
    const it = o?.items.find((x) => x.tile.id === el.dataset.id);
    if (it) { it.peek = !it.peek; setUi({}); }
  }
  else if (act === 'restore-dismiss') {
    const o = getState().ui.restoreOffer;
    if (o) for (const i of o.items) { if (i.origin === 'win') removePopout(i.tile.id); }
    setUi({ restoreOffer: null }); clearPersistedSession();
  }
  else if (act === 'sidebar-toggle') { setUi({ sidebarCollapsed: !getState().ui.sidebarCollapsed }); }
  else if (act === 'toggle-group') {
    const g = el.dataset.group!;
    const cur = getState().ui.collapsedGroups;
    setUi({ collapsedGroups: cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g] });
  }
  else if (act === 'nav-cockpit') {
    const hadQuery = !!getState().search.query.trim();
    setCockpit({ tab: 'grid' });
    setUi({ selectedProject: null, searchOpen: false });
    setSearch({ query: '', results: [] });
    if (hadQuery) postBridge('', null); // tell the bridge/CTRL the search is no longer active
    writeHash();
  }
  else if (act === 'nav-stats') {
    const hadQuery = !!getState().search.query.trim();
    setCockpit({ tab: 'stats' });
    setUi({ selectedProject: null, searchOpen: false });
    setSearch({ query: '', results: [] });
    if (hadQuery) postBridge('', null);
    writeHash();
  }
  else if (act === 'search-toggle') { setUi({ searchOpen: !getState().ui.searchOpen }); }
  else if (act === 'toggle-recent') { setUi({ recentCollapsed: !getState().ui.recentCollapsed }); }
  else if (act === 'cockpit-tab') { setCockpit({ tab: el.dataset.tab === 'stats' ? 'stats' : 'grid' }); }
  else if (act === 'stats-days') { setCockpit({ statsDays: Number(el.dataset.days) || 3 }); }
  else if (act === 'home') { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
  else if (act === 'searchclear') { setSearch({ query: '', results: [], loading: false, agentNote: null }); postBridge('', getState().ui.selectedProject); }
  else if (act === 'openresult' || act === 'selectproject') {
    setSearch({ query: '', results: [] });
    setUi({ selectedProject: el.dataset.path!, expandedSessionId: null, newSessionOpen: false, newSessionDraft: '' });
    writeHash();
    loadDetailIfNeeded();
  } else if (act === 'tab') {
    setUi({ detailTab: el.dataset.tab as DetailTab });
    writeHash();
    loadDetailIfNeeded();
  } else if (act === 'newcockpit') {
    // Start a fresh parallel conversation from this project as a cockpit tile
    // (distinct from "New in terminal" which opens a separate window). The agent
    // comes from the split button / its ⌄ menu — Claude unless another is picked.
    const agent = el.dataset.agent || 'claude';
    addLaunchTile(el.dataset.path!, el.dataset.name || undefined, undefined, agent);
    const label = getState().data?.features.agents.find((a) => a.id === agent)?.label;
    toast('Opening a new ' + (agent === 'claude' ? '' : (label || agent) + ' ') + 'conversation…');
  } else if (act === 'newsession') {
    setUi({ newSessionOpen: !ui.newSessionOpen, newSessionDraft: '' });
  } else if (act === 'newlaunch') {
    const input = document.getElementById('newsession-prompt') as HTMLInputElement | null;
    const prompt = input ? input.value.trim() : '';
    (el as HTMLButtonElement).disabled = true;
    const res = await postLaunch({ path: el.dataset.path!, prompt: prompt || undefined });
    toast(res.success ? '✓ ' + res.message + ': ' + res.project : '✗ ' + (res.error || res.message));
    setUi({ newSessionOpen: false, newSessionDraft: '' });
  } else if (act === 'expanddir') {
    const dir = el.dataset.dir!;
    const detail = getState().detail;
    if (detail.expandedDirs.includes(dir)) {
      setDetail({ expandedDirs: detail.expandedDirs.filter((x) => x !== dir) });
    } else {
      setDetail({ expandedDirs: [...detail.expandedDirs, dir] });
      if (!detail.files[dir]) {
        const proj = getState().ui.selectedProject!;
        try { const r = await fetchProjectFiles(proj, dir); setDetail({ files: { ...getState().detail.files, [dir]: r.nodes } }); } catch { /* ignore */ }
      }
    }
  } else if (act === 'toggle') {
    const id = el.dataset.id;
    if (!id) return;
    const next = ui.expandedSessionId === id ? null : id;
    setUi({ expandedSessionId: next });
    setTranscript(next ? { id: next, entries: [] } : null);
    writeHash();
    if (next) refreshTranscript();
  } else if (act === 'resume') {
    (el as HTMLButtonElement).disabled = true;
    const res = await postLaunch({ path: el.dataset.path!, resume: el.dataset.id });
    toast(res.success ? '✓ Resumed: ' + res.project : '✗ ' + (res.error || res.message));
    (el as HTMLButtonElement).disabled = false;
  }
});

// Shadow the new-session prompt into state WITHOUT a re-render, so the 3s poll's
// re-render restores the typed text instead of wiping it.
let searchTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'newsession-prompt') { getState().ui.newSessionDraft = (t as HTMLInputElement).value; return; }
  if (t.id === 'search-input') {
    const q = (t as HTMLInputElement).value;
    setSearch({ query: q, agentNote: null });  // user-driven search; value === q so cursor is preserved
    if (searchTimer) clearTimeout(searchTimer);
    if (!q.trim()) { setSearch({ results: [], loading: false }); postBridge('', getState().ui.selectedProject); return; }
    setSearch({ loading: true });
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetchSearch(q);
        if (getState().search.query === q) setSearch({ results: res, loading: false });
      } catch { setSearch({ loading: false }); }
      postBridge(q, getState().ui.selectedProject);  // publish what we're searching for the agent
    }, 250);
  } else if (t.id === 'cockpit-add-search') {
    const q = (t as HTMLInputElement).value;
    setCockpit({ addQuery: q });
    if (searchTimer) clearTimeout(searchTimer);
    if (!q.trim()) { setCockpit({ addResults: [] }); return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetchSearch(q);
        if (getState().ui.cockpit.addQuery === q) setCockpit({ addResults: res });
      } catch { /* ignore */ }
    }, 250);
  } else if (t.id === 'notes-search') {
    setCockpit({ notesQuery: (t as HTMLInputElement).value });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(loadNotes, 200); // server-side full-text (title + body)
  }
});

/** Fetch the notes list for the current library scope + full-text query. */
async function loadNotes(): Promise<void> {
  const cp = getState().ui.cockpit;
  const info = activeTileInfo();
  const params: { project?: string; conversation?: string; query?: string } =
    cp.notesScope === 'conversation' && info ? { conversation: info.conversation }
    : cp.notesScope === 'project' && info ? { project: info.project }
    : {}; // 'all', or scoped-but-no-active-tile → everything
  const q = cp.notesQuery.trim();
  if (q) params.query = q;
  const notes = await fetchNotes(params);
  // Drop a stale response if the user has since retyped or rescoped.
  const now = getState().ui.cockpit;
  if (now.notesOpen && now.notesQuery.trim() === q && now.notesScope === cp.notesScope) setCockpit({ notesResults: notes });
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.target as HTMLElement).id === 'newsession-prompt') {
    (document.querySelector('[data-act="newlaunch"]') as HTMLElement | null)?.click();
  }
  // "/" expands the sidebar search (unless typing in a field or a picker is up).
  const typing = /^(INPUT|TEXTAREA)$/.test((ev.target as HTMLElement | null)?.tagName || '');
  if (ev.key === '/' && !typing && !getState().ui.cockpit.addOpen && !getState().ui.cockpit.notesOpen) {
    ev.preventDefault();
    setUi({ searchOpen: true });
  }
  // Esc — ordered: notes overlay first, then the sidebar search (close + clear).
  if (ev.key === 'Escape') {
    if (getState().ui.cockpit.notesOpen) { setCockpit({ notesOpen: false }); }
    else if (getState().ui.searchOpen || getState().search.query.trim()) {
      const hadQuery = !!getState().search.query.trim();
      setUi({ searchOpen: false });
      setSearch({ query: '', results: [], loading: false, agentNote: null });
      if (hadQuery) postBridge('', getState().ui.selectedProject); // keep the bridge in sync, like searchclear
    }
  }
});

// Reveal the branch field when "Isolated worktree" is ticked.
document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'cockpit-new-worktree') {
    const branch = document.getElementById('cockpit-new-branch') as HTMLInputElement | null;
    if (branch) branch.style.display = (t as unknown as HTMLInputElement).checked ? '' : 'none';
  } else if (t.dataset?.act === 'theme-select') {
    applyTheme((t as unknown as HTMLSelectElement).value as ThemeId);
    renderApp();
  } else if (t.dataset?.act === 'restore-ck') {
    // Keep/skip checkbox on a chooser card: unchecked = leave it behind.
    const o = getState().ui.restoreOffer;
    const it = o?.items.find((x) => x.tile.id === t.dataset.id);
    if (it) { it.dest = (t as unknown as HTMLInputElement).checked ? it.origin : 'skip'; setUi({}); }
  }
});

// ── restore chooser: drag cards between zones ────────────────
// Delegated so uhtml re-renders don't drop listeners. Cards carry data-rid,
// zones data-rzone ('grid' | 'win' | 'skip').
if (!WIDGET) {
  document.addEventListener('dragstart', (e) => {
    const card = (e.target as HTMLElement).closest?.('[data-rid]') as HTMLElement | null;
    if (card && e.dataTransfer) { e.dataTransfer.setData('text/plain', card.dataset.rid!); e.dataTransfer.effectAllowed = 'move'; }
  });
  document.addEventListener('dragover', (e) => {
    const zone = (e.target as HTMLElement).closest?.('[data-rzone]') as HTMLElement | null;
    if (zone) { e.preventDefault(); zone.classList.add('dropover'); }
  });
  document.addEventListener('dragleave', (e) => {
    ((e.target as HTMLElement).closest?.('[data-rzone]') as HTMLElement | null)?.classList.remove('dropover');
  });
  document.addEventListener('drop', (e) => {
    const zone = (e.target as HTMLElement).closest?.('[data-rzone]') as HTMLElement | null;
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('dropover');
    const id = e.dataTransfer?.getData('text/plain');
    const o = getState().ui.restoreOffer;
    const it = o?.items.find((x) => x.tile.id === id);
    if (!it) return;
    const dest = zone.dataset.rzone as 'grid' | 'win' | 'skip';
    if (dest === 'win' && it.tile.kind !== 'resume' && it.tile.kind !== 'new') { toast('Only conversations can open as their own window'); return; }
    it.dest = dest;
    setUi({});
  });
}

// ── boot ─────────────────────────────────────────────────────
// Bring back where you left off. Fresh reopen (PTYs still alive) → restore +
// reconnect silently, including relaunching pop-out windows that died with the
// app; stale (next day) → banner + chooser, no surprise spawns.

/** Popped-out conversations that died WITH the app (vs deliberately closed or
 *  still alive in their own window right now). Prunes dead-wood entries. */
function collectOrphanPopouts(persistTs: number): CockpitTile[] {
  const map = loadPopouts();
  const now = Date.now();
  const ALIVE_MS = 20_000;             // widget heartbeats every ~5s
  const SHUTDOWN_WINDOW_MS = 10 * 60_000; // "closed around app shutdown" (windows are closed one at a time)
  const orphans: CockpitTile[] = [];
  for (const [id, e] of Object.entries(map)) {
    if (!e?.tile || typeof e.lastSeen !== 'number') { removePopout(id); continue; }
    if (now - e.lastSeen < ALIVE_MS) continue; // its window is open right now
    // A widget that outlived the main window (lastSeen > persistTs) also counts
    // as "was open at shutdown" — e.g. main closed first, widget died later.
    if (e.lastSeen >= persistTs - SHUTDOWN_WINDOW_MS) orphans.push(e.tile);
    else removePopout(id); // closed long before shutdown — a deliberate close
  }
  return orphans;
}

/** Re-open a conversation as its own chromeless window; grid-tile fallback so
 *  a failed launch never loses the conversation. */
async function relaunchPopout(t: CockpitTile): Promise<void> {
  const session = t.sessionId ?? '';
  if (!session || (t.kind !== 'resume' && t.kind !== 'new')) { removePopout(t.id); return; }
  const r = await postPopout({ kind: t.kind, id: t.id, session, path: t.projectPath, title: t.title, agent: t.agent, vendor: t.vendor });
  const opened = r.ok || (r.fallback && r.url && window.open(r.url, '_blank', 'popup,width=980,height=720') != null);
  if (opened) {
    heartbeatPopout(t); // fresh lastSeen until the widget's own heartbeat takes over
  } else {
    removePopout(t.id);
    addResumeTile(session, t.projectPath, t.title, false, t.vendor === 'codex' || t.vendor === 'antigravity' ? t.vendor : 'claude');
    toast('Couldn’t reopen "' + t.title + '" as a window — restored it as a tile instead');
  }
}

/** A pop-out tile as it should be RESTORED after a full restart: the PTY is
 *  gone, so a discovered 'new' tile becomes a resume of its real session. */
function popoutRestoreTile(t: CockpitTile): CockpitTile | null {
  if (t.kind === 'resume') return t;
  if (t.kind === 'new' && t.sessionId && !t.worktree) {
    return { id: 'resume:' + t.sessionId, kind: 'resume', sessionId: t.sessionId, projectPath: t.projectPath, title: t.title, vendor: t.vendor };
  }
  return null; // nothing resumable (undiscovered/worktree 'new') — leave it behind
}

/** Apply the restore offer: each item to its chosen destination. Grid tiles
 *  MERGE with anything already open (the banner is non-blocking — the user may
 *  have started working before deciding). */
async function applyRestore(items: RestoreItem[], layout: 'cols1' | 'cols2' | 'grid'): Promise<void> {
  const gridTiles = items.filter((i) => i.dest === 'grid').map((i) => i.tile);
  const winTiles = items.filter((i) => i.dest === 'win').map((i) => i.tile);
  // Everything offered leaves the registry: restored windows re-register on
  // relaunch; grid/skipped conversations no longer belong to a window.
  for (const i of items) removePopout(i.tile.id);
  const cur = getState().ui.cockpit.tiles;
  const seen = new Set(cur.map((t) => t.id));
  const merged = [...cur, ...gridTiles.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))];
  setCockpit({ tiles: merged, layout, open: true, maximized: null });
  setUi({ restoreOffer: null, selectedProject: null });
  setSearch({ query: '', results: [] });
  writeHash();
  for (const t of winTiles) void relaunchPopout(t);
  const skipped = items.length - gridTiles.length - winTiles.length;
  toast('Restored ' + gridTiles.length + ' tile' + (gridTiles.length === 1 ? '' : 's')
    + (winTiles.length ? ' + ' + winTiles.length + ' window' + (winTiles.length === 1 ? '' : 's') : '')
    + (skipped ? ' (skipped ' + skipped + ')' : ''));
}

/** Fill the chooser's cards with summary, context %, model, and last prompts.
 *  All fetches are fire-and-forget; cards render what has arrived so far. */
function enrichRestoreItems(): void {
  const o = getState().ui.restoreOffer;
  if (!o) return;
  // Summaries: one per-project sessions fetch (server-memoized), matched by id.
  for (const p of [...new Set(o.items.map((i) => i.tile.projectPath).filter(Boolean))]) {
    fetchProjectSessions(p).then((rows) => {
      const o2 = getState().ui.restoreOffer;
      if (!o2) return;
      let changed = false;
      for (const it of o2.items) {
        const row = it.tile.sessionId ? rows.find((r) => r.id === it.tile.sessionId) : undefined;
        if (row?.summary && !it.summary) { it.summary = row.summary; changed = true; }
      }
      if (changed) setUi({});
    }).catch(() => { /* card just shows no summary */ });
  }
  // Context meter + model + last prompts: one transcript-tail fetch per session.
  for (const it of o.items) {
    const sid = it.tile.sessionId;
    if (!sid || it.ctxPct !== undefined) continue;
    it.ctxPct = null; // in-flight marker (also the "unknown" render state)
    fetchTranscriptMeta(sid).then((m) => {
      const o2 = getState().ui.restoreOffer;
      const cur = o2?.items.find((x) => x.tile.id === it.tile.id);
      if (!cur) return;
      const win = getState().data?.sessions.find((s) => s.id === sid)?.contextWindow ?? 200_000;
      cur.ctxPct = m.contextSize > 0 ? Math.min(100, Math.round((m.contextSize / win) * 100)) : null;
      cur.model = m.model;
      cur.lastPrompts = m.entries.filter((e) => e.role === 'user').slice(-3).map((e) => e.text);
      setUi({});
    }).catch(() => { /* meter stays unknown */ });
  }
}

function restoreSession(): void {
  const p = loadPersistedSession();
  const orphanPopouts = collectOrphanPopouts(p?.ts ?? 0);
  if (!p && !orphanPopouts.length) return;
  if (!p) {
    // No persisted grid (e.g. cleared storage) but orphaned pop-outs exist —
    // still offer those rather than silently dropping them.
    const items = orphanPopouts.map(popoutRestoreTile).filter((t): t is CockpitTile => !!t)
      .map((tile): RestoreItem => ({ tile, origin: 'win', dest: 'win' }));
    if (items.length) setUi({ restoreOffer: { layout: 'cols2', items, chooserOpen: false } });
    return;
  }
  setUi({ sidebarCollapsed: !!p.sidebarCollapsed, collapsedGroups: p.collapsedGroups ?? [] });
  // Resume the SAME conversation a 'new' tile created (no manual /resume): if we
  // captured its real sessionId, restore it as a resume tile. Otherwise strip the
  // seed prompt so a restart never re-runs the original task as a fresh convo.
  const mapped = (p.cockpit?.tiles ?? []).map((t): CockpitTile => {
    // Convert a discovered 'new' tile into a resume of its real session — but NOT
    // worktree tiles: their session lives under the worktree's slug and the resume
    // path only accepts known-project cwds, so faithful worktree resume needs deeper
    // support (#9). They fall back to prompt-strip instead of a broken resume.
    if (t.kind === 'new' && t.discoveredSessionId && !t.worktree) {
      // Carry the docked notepad across the id change (new:… → resume:<sid>) so the
      // draft reopens instead of being orphaned + re-minted empty.
      return { id: 'resume:' + t.discoveredSessionId, kind: 'resume', sessionId: t.discoveredSessionId, projectPath: t.projectPath, title: t.title,
        noteOpen: t.noteOpen, notePath: t.notePath };
    }
    return (t.kind === 'new' && t.prompt) ? { ...t, prompt: undefined } : t;
  });
  // Dedupe by id: converting a discovered 'new' tile into resume:<sessionId> can
  // collide with an existing resume tile of the SAME conversation (it was also
  // opened directly), leaving two cp.tiles entries sharing one id. syncCockpit
  // (keyed by id) then renders one DOM tile while the focus-chip count shows two
  // — a "phantom conversation" that can't be opened or closed. Keep first.
  // The CTRL control tile is on-demand and never persisted; defensively drop it
  // here too (in case of stale localStorage from before this changed).
  const seen = new Set<string>();
  const tiles = mapped.filter((t) => t.kind !== 'control' && (seen.has(t.id) ? false : (seen.add(t.id), true)));
  if (!tiles.length && !orphanPopouts.length) return;
  const FRESH_MS = 8 * 60_000; // inside the server's ~10-min PTY idle window
  if (Date.now() - p.ts < FRESH_MS) {
    // Force open:true — the cockpit is the always-open home surface (stale localStorage
    // from the old List/Cockpit tab era could otherwise carry open:false).
    if (tiles.length) setCockpit({ tiles, layout: p.cockpit.layout, open: true, maximized: p.cockpit.maximized, hiddenProjects: p.cockpit.hiddenProjects ?? [] });
    // Land on the cockpit — a project left in the URL hash (readHash set
    // selectedProject) would otherwise hide the restored tiles. Mirror restore-accept.
    setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash();
    // Pop-outs that died with the app come back as windows too — "get me back
    // to where I was". Their PTYs are still inside the idle grace, so the
    // relaunched widgets reattach seamlessly.
    for (const t of orphanPopouts) void relaunchPopout(t);
  } else {
    const items: RestoreItem[] = [
      ...tiles.map((tile): RestoreItem => ({ tile, origin: 'grid' as const, dest: 'grid' as const })),
      ...orphanPopouts.map(popoutRestoreTile).filter((t): t is CockpitTile => !!t)
        .filter((t) => !seen.has(t.id)) // popped out AND somehow still in the grid — grid entry wins
        .map((tile): RestoreItem => ({ tile, origin: 'win' as const, dest: 'win' as const })),
    ];
    if (items.length) setUi({ restoreOffer: { layout: p.cockpit.layout, items, chooserOpen: false } });
  }
}

// ── dock-back bridge (widget → main window) ──────────────────
// Both windows share the app profile's localStorage (same origin), and 'storage'
// events fire in every OTHER window on a write — so the widget can hand its
// conversation to the main window without any server round-trip. Request/ack
// keys carry a timestamp so stale requests are ignored.
const DOCK_KEY = 'cldctrl.dock.v1';
const DOCK_ACK = 'cldctrl.dock.ack.v1';
let widgetTile: CockpitTile | null = null; // set by bootWidget

function requestDockBack(): void {
  if (!widgetTile) return;
  const req = { ts: Date.now(), tile: widgetTile };
  let done = false;
  const onAck = (e: StorageEvent) => {
    try {
      if (e.key === DOCK_ACK && e.newValue && JSON.parse(e.newValue).ts === req.ts) {
        done = true;
        window.removeEventListener('storage', onAck);
        window.close();
      }
    } catch { /* malformed ack */ }
  };
  window.addEventListener('storage', onAck);
  try { localStorage.setItem(DOCK_KEY, JSON.stringify(req)); } catch { /* quota */ }
  setTimeout(() => {
    if (!done) { window.removeEventListener('storage', onAck); toast('Main window not open — keeping the conversation here'); }
  }, 900);
}

// Main-window side: adopt a docked-back conversation. The PTY keeps running
// throughout — the new grid tile just attaches to it (replay included).
if (!WIDGET) {
  window.addEventListener('storage', (e) => {
    if (e.key !== DOCK_KEY || !e.newValue) return;
    try {
      const req = JSON.parse(e.newValue) as { ts: number; tile: CockpitTile };
      if (!req?.tile || Date.now() - req.ts > 5000) return; // stale request
      const t = req.tile;
      if (t.kind === 'resume' && t.sessionId) {
        addResumeTile(t.sessionId, t.projectPath, t.title, true, t.vendor === 'codex' || t.vendor === 'antigravity' ? t.vendor : 'claude');
      } else if (t.kind === 'new' && t.id) {
        const cp = getState().ui.cockpit;
        if (!cp.tiles.some((x) => x.id === t.id)) {
          setCockpit({
            tiles: [...cp.tiles, { id: t.id, kind: 'new', projectPath: t.projectPath, title: t.title, agent: t.agent, sessionId: t.sessionId }],
            open: true, maximized: null,
          });
        }
        setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash();
      } else return;
      removePopout(t.id); // it's a grid tile again — the persisted grid owns it now
      localStorage.setItem(DOCK_ACK, JSON.stringify({ ts: req.ts }));
    } catch { /* malformed request */ }
  });
}

// ── widget boot (?widget=1 pop-out window) ───────────────────
/** Mount ONE conversation tile full-window. No router, no 3s poll, no layout
 *  persistence — this window is a viewer onto an existing server PTY. The tile
 *  brings its own terminal + notepad + buttons; the shared click handler above
 *  drives them (tiles-map registration via mountTileStandalone). */
async function bootWidget(): Promise<void> {
  disablePersistence(); // NEVER let this window overwrite the main grid's saved layout
  initTheme();
  document.body.classList.add('widget-mode');
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') === 'new' ? 'new' as const : 'resume' as const;
  const session = q.get('session') ?? '';
  const projectPath = q.get('path') ?? '';
  const title = q.get('title') || projectPath.split(/[/\\]/).pop() || 'conversation';
  // 'new' widgets attach by their original terminal key (same live PTY); resume
  // widgets by session. Both carry sessionId for the usage meter + reattach fallback.
  const id = kind === 'new' ? (q.get('id') ?? '') : 'resume:' + session;
  const agent = q.get('agent') || undefined;
  const wv = q.get('vendor');
  const vendor = wv === 'codex' || wv === 'antigravity' ? wv : undefined;
  widgetTile = { id, kind, sessionId: session || undefined, projectPath, title, agent, vendor };
  heartbeatPopout(widgetTile); // register/refresh this window's entry (~5s cadence below)
  document.title = title + ' — CLD CTRL';
  const root = document.createElement('div');
  root.className = 'widget-root';
  appRoot.replaceChildren(root);
  // One overview fetch for features (reveal/vscode buttons) — persistence is
  // disabled so setData can't clobber anything; renderApp isn't subscribed.
  try { setData(await fetchOverview()); } catch { /* tile still works without */ }
  const t = mountTileStandalone(widgetTile, root);
  // Slim poll: the main window feeds the context-window meter via syncCockpit's
  // 3s render loop, which the widget doesn't run — poll just the session row and
  // push it into the tile directly (a failed tick only leaves the meter stale).
  const applyUsage = (d: ReturnType<typeof getState>['data']) => {
    const sid = session || (d?.terminalSessions ?? {})[id];
    const s = sid ? d?.sessions.find((x) => x.id === sid) : undefined;
    t.setContext?.(s?.contextSize ?? 0, s?.model ?? null, s?.contextWindow);
    t.setReadSession?.(sid ?? null);
  };
  applyUsage(getState().data);
  setInterval(async () => {
    if (widgetTile) heartbeatPopout(widgetTile); // liveness signal for restart-restore
    try { setData(await fetchOverview()); applyUsage(getState().data); } catch { /* offline tick */ }
  }, 5000);
}

if (WIDGET) {
  bootWidget();
} else {
  initTheme();
  initRouter(loadDetailIfNeeded);
  restoreSession();
  renderApp();
  loadDetailIfNeeded();
  poll();
  setInterval(poll, 3000);
}
