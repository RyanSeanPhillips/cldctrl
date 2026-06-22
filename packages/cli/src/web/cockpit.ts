/**
 * Cockpit — a grid of tiles in the Conversations pane. Two kinds:
 *  - terminal tiles (resume/new): a live `claude`/`codex`/… PTY over xterm.
 *  - doc tiles: a markdown file with an editor + live preview, for drafting text
 *    beside a chat. Auto-reloads when the agent edits the file on disk.
 * Tiles are managed IMPERATIVELY, outside the uhtml tree, so the 3s poll never
 * wipes them; `syncCockpit()` reconciles the DOM/PTYs with the store.
 */
import { marked } from 'marked';
import { getState } from './store.js';
import type { CockpitTile } from './store.js';
import { termTheme } from './dock.js';
import { fetchFile, postFile } from './api.js';

declare const Terminal: any;
declare const FitAddon: any;

interface LiveTile {
  el: HTMLElement;
  kind: 'resume' | 'new' | 'doc';
  dispose: () => void;
  fit?: () => void;
  restart?: () => void;       // terminal tiles
  setTheme?: () => void;      // terminal tiles
  toggleMode?: () => void;    // doc tiles
  save?: () => void;          // doc tiles
}
const tiles = new Map<string, LiveTile>();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// ── terminal tiles ───────────────────────────────────────────
function wsUrl(t: CockpitTile): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = proto + '://' + location.host + '/ws/term?path=' + encodeURIComponent(t.projectPath);
  if (t.kind === 'new') {
    let u = base + '&kind=new&id=' + encodeURIComponent(t.id);
    if (t.agent) u += '&agent=' + encodeURIComponent(t.agent);
    if (t.worktree) u += '&worktree=1&branch=' + encodeURIComponent(t.branch ?? '');
    return u;
  }
  return base + '&kind=resume&session=' + encodeURIComponent(t.sessionId ?? '');
}

function createTermTile(meta: CockpitTile): LiveTile {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = meta.id;
  el.innerHTML = `
    <div class="tile-head" data-act="tile-focus" data-id="${esc(meta.id)}">
      <span class="dot on"></span>
      <span class="tile-title">${esc(meta.title)}</span>
      <span class="tile-status">connecting…</span>
      <span class="sp"></span>
      <button class="btn icon" data-act="tile-scratch" data-id="${esc(meta.id)}" title="Open a scratchpad to draft beside this chat">&#9998;</button>
      <button class="btn icon" data-act="tile-shot" data-id="${esc(meta.id)}" title="Screenshot into this session">&#128247;</button>
      <button class="btn icon" data-act="tile-restart" data-id="${esc(meta.id)}" title="Restart">&#8635;</button>
      <button class="btn icon" data-act="tile-max" data-id="${esc(meta.id)}" title="Maximize">&#8689;</button>
      <button class="btn icon" data-act="tile-close" data-id="${esc(meta.id)}" title="Close">&#10005;</button>
    </div>
    <div class="tile-term"></div>`;

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    fontSize: 12, cursorBlink: true, scrollback: 4000, allowProposedApi: true, theme: termTheme(),
  });
  let fit: any = null;
  try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch { fit = null; }
  term.open(el.querySelector('.tile-term'));

  const sock = new WebSocket(wsUrl(meta));
  sock.binaryType = 'arraybuffer';
  const status = el.querySelector('.tile-status') as HTMLElement;
  const dot = el.querySelector('.dot') as HTMLElement;
  const doFit = () => { if (fit) { try { fit.fit(); } catch { /* ignore */ } } if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
  sock.onopen = () => { if (status) status.textContent = 'live'; setTimeout(doFit, 40); };
  sock.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data); term.write(d); };
  sock.onclose = () => { if (status) status.textContent = 'ended'; if (dot) dot.className = 'dot'; };
  sock.onerror = () => { if (status) status.textContent = 'error'; };
  term.onData((d: string) => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'input', data: d })); });

  return {
    el, kind: meta.kind === 'new' ? 'new' : 'resume', fit: doFit,
    dispose: () => { try { sock.close(); } catch { /* ignore */ } try { term.dispose(); } catch { /* ignore */ } },
    restart: () => { if (sock.readyState === 1) { term.reset(); sock.send(JSON.stringify({ type: 'restart' })); setTimeout(doFit, 200); } },
    setTheme: () => { try { term.options.theme = termTheme(); } catch { /* ignore */ } },
  };
}

// ── doc tiles (markdown editor + preview) ────────────────────
function createDocTile(meta: CockpitTile): LiveTile {
  const file = meta.filePath ?? '';
  const name = file.split(/[/\\]/).pop() || 'document';
  const el = document.createElement('div');
  el.className = 'tile doc-tile';
  el.dataset.id = meta.id;
  el.innerHTML = `
    <div class="tile-head">
      <span class="doc-mark">&#9998;</span>
      <span class="tile-title" title="${esc(file)}">${esc(name)}</span>
      <span class="doc-status"></span>
      <span class="sp"></span>
      <button class="btn icon" data-act="doc-toggle" data-id="${esc(meta.id)}" title="Edit / preview">&#9998;</button>
      <button class="btn icon" data-act="doc-save" data-id="${esc(meta.id)}" title="Save (Ctrl+S)">&#128190;</button>
      <button class="btn icon" data-act="tile-max" data-id="${esc(meta.id)}" title="Maximize">&#8689;</button>
      <button class="btn icon" data-act="tile-close" data-id="${esc(meta.id)}" title="Close">&#10005;</button>
    </div>
    <div class="doc-body">
      <textarea class="doc-edit" spellcheck="false" style="display:none"></textarea>
      <div class="doc-preview markdown"></div>
    </div>`;

  const editEl = el.querySelector('.doc-edit') as HTMLTextAreaElement;
  const previewEl = el.querySelector('.doc-preview') as HTMLElement;
  const statusEl = el.querySelector('.doc-status') as HTMLElement;

  let content = '', mtime = 0, mode: 'preview' | 'edit' = 'preview', dirty = false;
  const renderPreview = () => { try { previewEl.innerHTML = marked.parse(content) as string; } catch { previewEl.textContent = content; } };

  const load = async () => {
    const r = await fetchFile(file);
    if (!r) { statusEl.textContent = 'not found'; return; }
    if (dirty) { if (r.mtime !== mtime) statusEl.textContent = 'changed on disk'; return; } // don't clobber edits
    content = r.content; mtime = r.mtime; editEl.value = content;
    if (mode === 'preview') renderPreview();
    statusEl.textContent = '';
  };

  editEl.addEventListener('input', () => { content = editEl.value; dirty = true; statusEl.textContent = 'unsaved'; });
  editEl.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

  const setMode = (m: 'preview' | 'edit') => {
    mode = m;
    editEl.style.display = m === 'edit' ? '' : 'none';
    previewEl.style.display = m === 'edit' ? 'none' : '';
    if (m === 'preview') renderPreview(); else editEl.focus();
  };
  const save = async () => {
    statusEl.textContent = 'saving…';
    const r = await postFile(file, editEl.value);
    if (r.ok) { content = editEl.value; mtime = r.mtime ?? mtime; dirty = false; statusEl.textContent = 'saved'; setTimeout(() => { if (!dirty) statusEl.textContent = ''; }, 1500); }
    else statusEl.textContent = '✗ ' + (r.error || 'save failed');
  };

  load();
  const poll = setInterval(load, 2500); // pick up the agent's edits to the file

  return {
    el, kind: 'doc',
    dispose: () => clearInterval(poll),
    toggleMode: () => setMode(mode === 'preview' ? 'edit' : 'preview'),
    save,
  };
}

function createTile(meta: CockpitTile): LiveTile {
  return meta.kind === 'doc' ? createDocTile(meta) : createTermTile(meta);
}

function destroyTile(id: string): void {
  const t = tiles.get(id);
  if (!t) return;
  try { t.dispose(); } catch { /* ignore */ }
  t.el.remove();
  tiles.delete(id);
}

/** Reconcile the imperative cockpit DOM/PTYs with the store's cockpit state. */
export function syncCockpit(): void {
  const st = getState();
  const cp = st.ui.cockpit;
  const root = document.getElementById('cockpit');
  const grid = document.getElementById('cockpit-grid');
  if (!root || !grid) return;

  const show = cp.open && !st.ui.selectedProject && !st.search.query.trim();
  root.classList.toggle('open', show);
  grid.className = 'cockpit-grid ' + cp.layout + (cp.maximized ? ' has-max' : '');

  const wanted = new Set(cp.tiles.map((t) => t.id));
  for (const id of [...tiles.keys()]) if (!wanted.has(id)) destroyTile(id);
  for (const meta of cp.tiles) {
    let t = tiles.get(meta.id);
    if (!t) { t = createTile(meta); tiles.set(meta.id, t); grid.appendChild(t.el); }
    t.el.classList.toggle('maxed', cp.maximized === meta.id);
  }

  if (show) { setTimeout(refitAll, 70); setTimeout(refitAll, 280); }
}

function refitAll(): void { for (const t of tiles.values()) t.fit?.(); }

export function restartTile(id: string): void { tiles.get(id)?.restart?.(); }
export function docToggle(id: string): void { tiles.get(id)?.toggleMode?.(); }
export function docSave(id: string): void { tiles.get(id)?.save?.(); }

window.addEventListener('resize', () => { if (getState().ui.cockpit.open) refitAll(); });
window.addEventListener('themechange', () => { for (const t of tiles.values()) t.setTheme?.(); });
