import './app.css';
import { render } from 'uhtml';
import { appView } from './views.js';
import { getState, subscribe, setData, setConnError, setUi, setTranscript, setDetail, resetDetail, setSearch, setCockpit, loadPersistedSession, clearPersistedSession, disablePersistence } from './store.js';
import type { CockpitTile } from './store.js';
import type { DetailTab } from './types.js';
import {
  fetchOverview, fetchTranscript, postLaunch,
  fetchProjectSessions, fetchProjectCommits, fetchProjectIssues, fetchProjectFiles, fetchProjectActivity, fetchSearch, postBridge, postScreenshot, postReveal, postPopout, postHandoffBrief, fetchNotes,
} from './api.js';
import { initRouter, writeHash } from './router.js';
import { syncCockpit, restartTile, toggleTileNote, injectIntoTile, docToggle, docSave, docSpeak, focusWaitingTile, clearTileAttn, openAgentScratchpad, activeTileInfo, dockNoteInActiveTile, openControlTile, mountTileStandalone, queueTilePrefill } from './cockpit.js';
import { syncStats } from './stats.js';
import { toast } from './toast.js';
import { readSession, autoRead, onSpeechState, isSpeaking, isHandsFree, enableHandsFree, disableHandsFree } from './speech.js';
import { initTheme, applyTheme } from './theme.js';
import type { ThemeId } from './theme.js';

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

// Reflect play/stop on every read-aloud button while speaking.
onSpeechState((on) => {
  document.querySelectorAll('[data-act="tile-readout"]').forEach((b) => {
    b.innerHTML = on ? '&#9209;' : '&#128266;';
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
function addResumeTile(sessionId: string, projectPath: string, title: string, openNow: boolean, vendor: 'claude' | 'codex' | 'antigravity' = 'claude'): void {
  const id = 'resume:' + sessionId;
  const cp = getState().ui.cockpit;
  const already = cp.tiles.some((t) => t.id === id);
  const label = vendor !== 'claude' ? title + ' · ' + vendor : title;
  const tiles = already
    ? cp.tiles
    : [...cp.tiles, { id, kind: 'resume' as const, sessionId, projectPath, title: label, vendor }];
  // Opening always reveals the conversation: unmute its project (focus chips) so
  // re-opening an already-open chat doesn't silently appear to do nothing.
  const hiddenProjects = cp.hiddenProjects.filter((p) => p !== projectPath);
  setCockpit({ tiles, hiddenProjects, open: openNow ? true : cp.open, maximized: null });
  if (openNow) { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
  if (already) toast('Already open — focused it');
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


/** Open a new agent session as a cockpit tile (CTRL launched it from the web). */
function addLaunchTile(projectPath: string, projectName: string | undefined, prompt?: string): void {
  const cp = getState().ui.cockpit;
  const id = 'new:' + projectPath + ':' + Date.now();
  const short = projectName || projectPath.split(/[/\\]/).pop() || projectPath;
  setCockpit({
    tiles: [...cp.tiles, { id, kind: 'new' as const, projectPath, title: short + ' · new', agent: 'claude', prompt }],
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
        if (openAgentScratchpad(sc.path)) {
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
  } catch { setConnError(true); }
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

// ── event delegation ─────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  // Close an open handoff menu on any outside click (option clicks are inside it).
  const hm = document.getElementById('handoff-menu');
  if (hm && !hm.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('[data-act="tile-handoff"]')) closeHandoffMenu();
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
    if (act === 'tile-close') { window.close(); return; }
    if (act === 'tile-dock') { requestDockBack(); return; }
    if (act === 'tile-max' || act === 'tile-popout') return;
  }

  if (act === 'theme') { applyTheme(el.dataset.theme as ThemeId); renderApp(); }
  else if (act === 'update-open') {
    const cmd = 'npm i -g cldctrl';
    navigator.clipboard?.writeText(cmd).then(() => toast('Copied: ' + cmd + ' — run it to update'))
      .catch(() => toast('To update, run:  ' + cmd));
  } else if (act === 'update-dismiss') {
    try { localStorage.setItem('cldctrl-dismissed-update', el.dataset.ver || ''); } catch { /* ignore */ }
    renderApp();
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
    const r = await postPopout({ kind: t.kind, id: t.id, session, path: t.projectPath, title: t.title, agent: t.agent });
    const opened = r.ok || (r.fallback && r.url && window.open(r.url, '_blank', 'popup,width=980,height=720') != null);
    if (opened) {
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
    const o = getState().ui.restoreOffer;
    if (o) { setCockpit({ tiles: o.tiles, layout: o.layout, open: true, maximized: null }); setUi({ restoreOffer: null, selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
  }
  else if (act === 'restore-dismiss') { setUi({ restoreOffer: null }); clearPersistedSession(); }
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
    // (distinct from "New in terminal" which opens a separate window).
    addLaunchTile(el.dataset.path!, el.dataset.name || undefined);
    toast('Opening a new conversation…');
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
  }
});

// ── boot ─────────────────────────────────────────────────────
// Bring back where you left off. Fresh reopen (PTYs still alive) → restore +
// reconnect silently; stale (next day) → offer to restore, no surprise spawns.
function restoreSession(): void {
  const p = loadPersistedSession();
  if (!p) return;
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
        noteOpen: t.noteOpen, notePath: t.notePath, noteAnnounced: t.noteAnnounced };
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
  if (!tiles.length) return;
  const FRESH_MS = 8 * 60_000; // inside the server's ~10-min PTY idle window
  if (Date.now() - p.ts < FRESH_MS) {
    // Force open:true — the cockpit is the always-open home surface (stale localStorage
    // from the old List/Cockpit tab era could otherwise carry open:false).
    setCockpit({ tiles, layout: p.cockpit.layout, open: true, maximized: p.cockpit.maximized, hiddenProjects: p.cockpit.hiddenProjects ?? [] });
    // Land on the cockpit — a project left in the URL hash (readHash set
    // selectedProject) would otherwise hide the restored tiles. Mirror restore-accept.
    setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash();
  } else {
    setUi({ restoreOffer: { tiles, layout: p.cockpit.layout } });
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
        addResumeTile(t.sessionId, t.projectPath, t.title, true);
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
  widgetTile = { id, kind, sessionId: session || undefined, projectPath, title, agent };
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
  setInterval(async () => { try { setData(await fetchOverview()); applyUsage(getState().data); } catch { /* offline tick */ } }, 5000);
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
