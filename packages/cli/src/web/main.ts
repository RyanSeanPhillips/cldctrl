import './app.css';
import { render } from 'uhtml';
import { appView } from './views.js';
import { getState, subscribe, setData, setConnError, setUi, setTranscript, setDetail, resetDetail, setSearch, setCockpit, loadPersistedSession, clearPersistedSession } from './store.js';
import type { SortKey, CockpitTile } from './store.js';
import type { DetailTab } from './types.js';
import {
  fetchOverview, fetchTranscript, postLaunch,
  fetchProjectSessions, fetchProjectCommits, fetchProjectIssues, fetchProjectFiles, fetchProjectActivity, fetchSearch, postBridge, postScreenshot, postScratch, postReveal,
} from './api.js';
import { initRouter, writeHash } from './router.js';
import { syncDock, toggleDock, closeDock, restartDock } from './dock.js';
import { syncCockpit, restartTile, docToggle, docSave, docSpeak } from './cockpit.js';
import { readSession, autoRead, onSpeechState, isSpeaking, isHandsFree, enableHandsFree, disableHandsFree } from './speech.js';
import { initTheme, applyTheme } from './theme.js';
import type { ThemeId } from './theme.js';

const appRoot = document.getElementById('app')!;

// ── toast (lives in the shell, outside the reconciler) ───────
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── render ───────────────────────────────────────────────────
let prevNewSessionOpen = false;
let prevViewKey = '';
function renderApp(): void {
  const state = getState();

  // Preserve text-input focus + caret across the re-render (typing re-renders
  // the app to show results, and uhtml may recreate the input node).
  const active = document.activeElement as HTMLInputElement | null;
  const PRESERVE_FOCUS = ['search-input', 'cockpit-add-search', 'newsession-prompt'];
  const focusedId = active?.id && PRESERVE_FOCUS.includes(active.id) ? active.id : null;
  const caret = focusedId ? active!.selectionStart : null;

  // Transcript follows the tail ONLY if you're already at the bottom — so
  // scrolling up to read earlier output isn't yanked back down every poll.
  const trBefore = document.getElementById('transcript');
  const trWasAtBottom = trBefore ? (trBefore.scrollHeight - trBefore.scrollTop - trBefore.clientHeight < 40) : true;

  // Preserve scroll across the 3s poll re-render: the sidebar (project list)
  // always; the window (main content) only when the view is unchanged, so real
  // navigation still resets to top.
  const viewKey = (state.ui.selectedProject ?? '') + '|' + state.search.query.trim() + '|' + state.ui.cockpit.open;
  const sidebarScroll = (document.querySelector('.sidebar') as HTMLElement | null)?.scrollTop ?? 0;
  const winScroll = window.scrollY;

  render(appRoot, appView(state) as Node);

  const sb = document.querySelector('.sidebar') as HTMLElement | null;
  if (sb && sidebarScroll) sb.scrollTop = sidebarScroll;
  if (viewKey === prevViewKey && winScroll) window.scrollTo(0, winScroll);
  prevViewKey = viewKey;
  document.body.classList.toggle('no-agent', !(state.data?.features.agentTerminal ?? true));
  document.body.classList.toggle('sidebar-collapsed', state.ui.sidebarCollapsed);
  const home = !state.search.query.trim() && !state.ui.selectedProject;
  document.body.classList.toggle('conv-home', home);
  syncDock();
  syncCockpit();

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
}
subscribe(renderApp);

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
function addResumeTile(sessionId: string, projectPath: string, title: string, openNow: boolean): void {
  const id = 'resume:' + sessionId;
  const cp = getState().ui.cockpit;
  const already = cp.tiles.some((t) => t.id === id);
  const tiles = already
    ? cp.tiles
    : [...cp.tiles, { id, kind: 'resume' as const, sessionId, projectPath, title }];
  // Opening always reveals the conversation: unmute its project (focus chips) so
  // re-opening an already-open chat doesn't silently appear to do nothing.
  const hiddenProjects = cp.hiddenProjects.filter((p) => p !== projectPath);
  setCockpit({ tiles, hiddenProjects, open: openNow ? true : cp.open, maximized: null });
  if (openNow) { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
  if (already) toast('Already open in the cockpit — focused it');
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

/** Mint a fresh scratchpad and open it as a doc tile beside the given chat tile. */
async function openScratchpadFor(tileId: string): Promise<void> {
  const tile = getState().ui.cockpit.tiles.find((t) => t.id === tileId);
  const proj = tile?.projectPath ?? getState().ui.selectedProject ?? '';
  toast('Opening scratchpad…');
  try {
    const r = await postScratch();
    if (!r.path) { toast('✗ ' + (r.error || 'could not open scratchpad')); return; }
    addDocTile(r.path, proj, true, true);
    if (getState().ui.cockpit.tiles.length > 1) setCockpit({ layout: 'cols2' });
    toast('✓ Scratchpad ready — draft away, Ctrl+S to save');
  } catch { toast('✗ Scratchpad failed'); }
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
async function poll(): Promise<void> {
  try {
    const data = await fetchOverview();
    setData(data);
    // Adopt a search the control-plane agent pushed — but only a recent one, so
    // a fresh page load doesn't resurrect a stale push.
    const b = data.bridge;
    if (b && b.ts > lastBridgeTs && Date.now() - b.ts < 5 * 60_000) {
      lastBridgeTs = b.ts;
      setSearch({ query: b.query, results: b.results, loading: false, agentNote: b.note ?? '' });
    } else if (b && b.ts > lastBridgeTs) {
      lastBridgeTs = b.ts; // mark seen without adopting
    }
    // Pop open a scratchpad the agent requested (recent only).
    const sc = data.scratch;
    if (sc && sc.ts > lastScratchTs) {
      lastScratchTs = sc.ts;
      if (Date.now() - sc.ts < 5 * 60_000) {
        addDocTile(sc.path, '', true, true);
        if (getState().ui.cockpit.tiles.length > 1) setCockpit({ layout: 'cols2' });
      }
    }
    // Open a new session as a cockpit tile when CTRL launched one from the web
    // surface (recent only, so a fresh load doesn't replay a stale launch).
    const cl = data.cockpitLaunch;
    if (cl && cl.ts > lastCockpitLaunchTs) {
      lastCockpitLaunchTs = cl.ts;
      if (Date.now() - cl.ts < 60_000) addLaunchTile(cl.projectPath, cl.project, cl.prompt);
    }
    // Listen mode: speak each new assistant reply of the active session.
    if (isHandsFree()) { const t = latestActiveSession(); if (t) autoRead({ id: t.id, assistantTurns: t.assistantTurns }); }
  } catch { setConnError(true); }
  await refreshTranscript();
}

// ── event delegation ─────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  // Click on the picker backdrop (but not its panel) closes it.
  if ((ev.target as HTMLElement).classList?.contains('cp-add-backdrop')) { setCockpit({ addOpen: false }); return; }
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.act;
  const ui = getState().ui;

  if (act === 'theme') { applyTheme(el.dataset.theme as ThemeId); renderApp(); }
  else if (act === 'openincockpit') {
    addResumeTile(el.dataset.id!, el.dataset.path!, el.dataset.title || el.dataset.path!, true);
  } else if (act === 'cockpit-add-toggle') {
    const cp = getState().ui.cockpit;
    setCockpit({ addOpen: !cp.addOpen, addQuery: '', addResults: [] });
  } else if (act === 'cockpit-add-close') {
    setCockpit({ addOpen: false });
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
    setCockpit({ tiles, open: tiles.length > 0 && cp.open, maximized: cp.maximized === el.dataset.id ? null : cp.maximized });
  } else if (act === 'tile-max') {
    const cp = getState().ui.cockpit;
    setCockpit({ maximized: cp.maximized === el.dataset.id ? null : el.dataset.id! });
  } else if (act === 'tile-restart') {
    restartTile(el.dataset.id!);
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
  else if (act === 'dockToggle') { toggleDock(); }
  else if (act === 'dockClose') { closeDock(); }
  else if (act === 'dockRestart') { restartDock(); }
  else if (act === 'dock-shot') { shoot('control'); }
  else if (act === 'tile-shot') { shoot(el.dataset.id!); }
  else if (act === 'tile-scratch') { openScratchpadFor(el.dataset.id!); }
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
  else if (act === 'view-list') { setCockpit({ open: false }); }
  else if (act === 'view-cockpit') { setCockpit({ open: true }); }
  else if (act === 'cockpit-chip') {
    const proj = el.dataset.proj!;
    const cur = getState().ui.cockpit.hiddenProjects;
    setCockpit({ hiddenProjects: cur.includes(proj) ? cur.filter((p) => p !== proj) : [...cur, proj] });
  }
  else if (act === 'cockpit-chip-all') { setCockpit({ hiddenProjects: [] }); }
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
    toast('Opening a new conversation in the cockpit…');
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
  } else if (act === 'sort') {
    const key = el.dataset.key as SortKey;
    if (ui.sortKey === key) setUi({ sortDir: ui.sortDir === 1 ? -1 : 1 });
    else setUi({ sortKey: key, sortDir: 1 });
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
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.target as HTMLElement).id === 'newsession-prompt') {
    (document.querySelector('[data-act="newlaunch"]') as HTMLElement | null)?.click();
  }
});

// Reveal the branch field when "Isolated worktree" is ticked.
document.addEventListener('change', (ev) => {
  if ((ev.target as HTMLElement).id === 'cockpit-new-worktree') {
    const branch = document.getElementById('cockpit-new-branch') as HTMLInputElement | null;
    if (branch) branch.style.display = (ev.target as HTMLInputElement).checked ? '' : 'none';
  }
});

// ── boot ─────────────────────────────────────────────────────
// Bring back where you left off. Fresh reopen (PTYs still alive) → restore +
// reconnect silently; stale (next day) → offer to restore, no surprise spawns.
function restoreSession(): void {
  const p = loadPersistedSession();
  if (!p) return;
  setUi({ sidebarCollapsed: !!p.sidebarCollapsed, collapsedGroups: p.collapsedGroups ?? [] });
  const tiles = p.cockpit?.tiles ?? [];
  if (!tiles.length) return;
  const FRESH_MS = 8 * 60_000; // inside the server's ~10-min PTY idle window
  if (Date.now() - p.ts < FRESH_MS) {
    setCockpit({ tiles, layout: p.cockpit.layout, open: p.cockpit.open, maximized: p.cockpit.maximized, hiddenProjects: p.cockpit.hiddenProjects ?? [] });
  } else {
    setUi({ restoreOffer: { tiles, layout: p.cockpit.layout } });
  }
}

initTheme();
initRouter(loadDetailIfNeeded);
restoreSession();
renderApp();
loadDetailIfNeeded();
poll();
setInterval(poll, 3000);
