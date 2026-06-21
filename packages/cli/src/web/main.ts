import './app.css';
import { render } from 'uhtml';
import { appView } from './views.js';
import { getState, subscribe, setData, setConnError, setUi, setTranscript, setDetail, resetDetail, setSearch } from './store.js';
import type { SortKey } from './store.js';
import type { DetailTab } from './types.js';
import {
  fetchOverview, fetchTranscript, postLaunch,
  fetchProjectSessions, fetchProjectCommits, fetchProjectIssues, fetchProjectFiles, fetchProjectActivity, fetchSearch,
} from './api.js';
import { initRouter, writeHash } from './router.js';
import { syncDock, toggleDock, closeDock, restartDock } from './dock.js';
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

  // Preserve search-box focus + caret across the re-render (typing re-renders
  // the app to show results, and uhtml may recreate the input node).
  const active = document.activeElement as HTMLInputElement | null;
  const searchHadFocus = active?.id === 'search-input';
  const caret = searchHadFocus ? active!.selectionStart : null;

  render(appRoot, appView(state) as Node);
  document.body.classList.toggle('no-agent', !(state.data?.features.agentTerminal ?? true));
  syncDock();

  if (searchHadFocus) {
    const inp = document.getElementById('search-input') as HTMLInputElement | null;
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
async function poll(): Promise<void> {
  try { setData(await fetchOverview()); }
  catch { setConnError(true); }
  await refreshTranscript();
}

// ── event delegation ─────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.act;
  const ui = getState().ui;

  if (act === 'theme') { applyTheme(el.dataset.theme as ThemeId); renderApp(); }
  else if (act === 'dockToggle') { toggleDock(); }
  else if (act === 'dockClose') { closeDock(); }
  else if (act === 'dockRestart') { restartDock(); }
  else if (act === 'home') { setUi({ selectedProject: null }); setSearch({ query: '', results: [] }); writeHash(); }
  else if (act === 'searchclear') { setSearch({ query: '', results: [], loading: false }); }
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
    setSearch({ query: q });               // value === q on re-render, so cursor is preserved
    if (searchTimer) clearTimeout(searchTimer);
    if (!q.trim()) { setSearch({ results: [], loading: false }); return; }
    setSearch({ loading: true });
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetchSearch(q);
        if (getState().search.query === q) setSearch({ results: res, loading: false });
      } catch { setSearch({ loading: false }); }
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
