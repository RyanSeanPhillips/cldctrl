/**
 * Cockpit — a grid of live conversation terminals in the Conversations area.
 * Each tile is a `claude --resume <sessionId>` PTY (server-side, persistent).
 * Like the dock, tiles are managed IMPERATIVELY and live outside the uhtml tree
 * so the 3s poll never wipes a terminal. The store holds which tiles are open +
 * the layout; `syncCockpit()` reconciles the DOM/PTYs with that state.
 */
import { getState } from './store.js';
import type { CockpitTile } from './store.js';
import { termTheme } from './dock.js';

declare const Terminal: any;
declare const FitAddon: any;

interface LiveTile { el: HTMLElement; term: any; fit: any; sock: WebSocket | null; }
const tiles = new Map<string, LiveTile>();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function wsUrl(t: CockpitTile): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = proto + '://' + location.host + '/ws/term?path=' + encodeURIComponent(t.projectPath);
  return t.kind === 'new'
    ? base + '&kind=new&id=' + encodeURIComponent(t.id)
    : base + '&kind=resume&session=' + encodeURIComponent(t.sessionId ?? '');
}

function fitTile(t: LiveTile): void {
  if (t.fit) { try { t.fit.fit(); } catch { /* ignore */ } }
  if (t.sock && t.sock.readyState === 1) {
    t.sock.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
  }
}

function createTile(meta: CockpitTile): LiveTile {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = meta.id;
  el.innerHTML = `
    <div class="tile-head" data-act="tile-focus" data-id="${esc(meta.id)}">
      <span class="dot on"></span>
      <span class="tile-title">${esc(meta.title)}</span>
      <span class="tile-status">connecting…</span>
      <span class="sp"></span>
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
  const live: LiveTile = { el, term, fit, sock };
  const status = el.querySelector('.tile-status') as HTMLElement;
  const dot = el.querySelector('.dot') as HTMLElement;
  sock.onopen = () => { if (status) status.textContent = 'live'; setTimeout(() => fitTile(live), 40); };
  sock.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data); term.write(d); };
  sock.onclose = () => { if (status) status.textContent = 'ended'; if (dot) dot.className = 'dot'; };
  sock.onerror = () => { if (status) status.textContent = 'error'; };
  term.onData((d: string) => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'input', data: d })); });
  return live;
}

function destroyTile(id: string): void {
  const t = tiles.get(id);
  if (!t) return;
  try { t.sock?.close(); } catch { /* ignore */ }
  try { t.term.dispose(); } catch { /* ignore */ }
  t.el.remove();
  tiles.delete(id);
}

/** Reconcile the imperative cockpit DOM/PTYs with the store's cockpit state. */
export function syncCockpit(): void {
  const cp = getState().ui.cockpit;
  const root = document.getElementById('cockpit');
  const grid = document.getElementById('cockpit-grid');
  if (!root || !grid) return;

  root.classList.toggle('open', cp.open);
  document.body.classList.toggle('cockpit-open', cp.open);
  grid.className = 'cockpit-grid ' + cp.layout + (cp.maximized ? ' has-max' : '');

  const title = document.getElementById('cockpit-title');
  if (title) title.textContent = 'Cockpit · ' + cp.tiles.length + ' session' + (cp.tiles.length === 1 ? '' : 's');

  // reconcile tiles
  const wanted = new Set(cp.tiles.map((t) => t.id));
  for (const id of [...tiles.keys()]) if (!wanted.has(id)) destroyTile(id);
  for (const meta of cp.tiles) {
    let t = tiles.get(meta.id);
    if (!t) { t = createTile(meta); tiles.set(meta.id, t); grid.appendChild(t.el); }
    t.el.classList.toggle('maxed', cp.maximized === meta.id);
  }

  // layout button active state
  root.querySelectorAll('[data-act="cockpit-layout"]').forEach((b) => {
    (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.layout === cp.layout);
  });

  if (cp.open) setTimeout(() => { for (const t of tiles.values()) fitTile(t); }, 60);
}

/** Restart the PTY behind a tile in place (server respawns, socket stays). */
export function restartTile(id: string): void {
  const t = tiles.get(id);
  if (t && t.sock && t.sock.readyState === 1) {
    t.term.reset();
    t.sock.send(JSON.stringify({ type: 'restart' }));
    setTimeout(() => fitTile(t), 200);
  }
}

window.addEventListener('resize', () => {
  if (getState().ui.cockpit.open) for (const t of tiles.values()) fitTile(t);
});
window.addEventListener('themechange', () => {
  for (const t of tiles.values()) { try { t.term.options.theme = termTheme(); } catch { /* ignore */ } }
});
