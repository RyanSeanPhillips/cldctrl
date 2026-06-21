import './app.css';
import { render } from 'uhtml';
import { appView } from './views.js';
import { getState, subscribe, setData, setConnError, setUi, setTranscript, setDetail, resetDetail, setSearch, setCockpit } from './store.js';
import type { SortKey, CockpitTile } from './store.js';
import type { DetailTab } from './types.js';
import {
  fetchOverview, fetchTranscript, postLaunch,
  fetchProjectSessions, fetchProjectCommits, fetchProjectIssues, fetchProjectFiles, fetchProjectActivity, fetchSearch, postBridge, postScreenshot,
} from './api.js';
import { initRouter, writeHash } from './router.js';
import { syncDock, toggleDock, closeDock, restartDock } from './dock.js';
import { syncCockpit, restartTile } from './cockpit.js';
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
function renderApp(): void {
  const state = getState();

  // Preserve text-input focus + caret across the re-render (typing re-renders
  // the app to show results, and uhtml may recreate the input node).
  const active = document.activeElement as HTMLInputElement | null;
  const focusedId = (active?.id === 'search-input' || active?.id === 'cockpit-add-search') ? active.id : null;
  const caret = focusedId ? active!.selectionStart : null;

  render(appRoot, appView(state) as Node);
  document.body.classList.toggle('no-agent', !(state.data?.features.agentTerminal ?? true));
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
  if (tr) tr.scrollTop = tr.scrollHeight;

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

// ── cockpit tile helpers ─────────────────────────────────────
function addResumeTile(sessionId: string, projectPath: string, title: string, openNow: boolean): void {
  const id = 'resume:' + sessionId;
  const cp = getState().ui.cockpit;
  const tiles = cp.tiles.some((t) => t.id === id)
    ? cp.tiles
    : [...cp.tiles, { id, kind: 'resume' as const, sessionId, projectPath, title }];
  setCockpit({ tiles, open: openNow ? true : cp.open, maximized: null });
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
      const id = 'new:' + projectPath + ':' + Date.now();
      const title = (projectPath.split(/[/\\]/).pop() || projectPath) + ' · new';
      setCockpit({ tiles: [...cp.tiles, { id, kind: 'new', projectPath, title }], open: true, maximized: null, addOpen: false });
    }
  } else if (act === 'cockpit-open') {
    setCockpit({ open: true });
  } else if (act === 'cockpit-close') {
    setCockpit({ open: false });
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

// ── boot ─────────────────────────────────────────────────────
initTheme();
initRouter(loadDetailIfNeeded);
renderApp();
loadDetailIfNeeded();
poll();
setInterval(poll, 3000);
