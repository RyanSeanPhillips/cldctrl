/**
 * Agent dock — the embedded xterm control-plane terminal. It is managed
 * IMPERATIVELY and lives OUTSIDE the uhtml-rendered tree: xterm owns its DOM,
 * so the 3s poll's reconciliation never wipes the terminal. The rest of the app
 * only flips `ui.dockOpen`; this module reacts to it via `syncDock()`.
 *
 * xterm.js + the fit addon are loaded as UMD globals from /vendor/*.
 */
import { setUi, getState } from './store.js';
import { writeHash } from './router.js';

declare const Terminal: any;
declare const FitAddon: any;

let term: any = null;
let fit: any = null;
let sock: WebSocket | null = null;
let mounted = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(text: string, on: boolean): void {
  const s = el('dock-status');
  if (s) s.textContent = text;
  const dot = el('dock-dot');
  if (dot) dot.className = 'dot' + (on ? ' on' : '');
}

/** Build an xterm theme from the active CSS variables so the terminal matches
 *  whichever dashboard theme is selected. */
export function termTheme(): Record<string, string> {
  const cs = getComputedStyle(document.body);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    background: v('--surface-1', '#0d121d'),
    foreground: v('--text', '#e4e8ef'),
    cursor: v('--accent', '#e87632'),
    selectionBackground: v('--accent-soft', 'rgba(232,118,50,0.25)'),
    green: v('--success', '#2dd4bf'), brightGreen: v('--success', '#2dd4bf'),
    blue: v('--info', '#4f9cff'), brightBlue: v('--info', '#4f9cff'),
    yellow: v('--warn', '#f59e0b'), brightYellow: v('--warn', '#f59e0b'),
    red: v('--crit', '#ef4444'), brightRed: v('--crit', '#ef4444'),
  };
}

function initTerm(): void {
  if (mounted) return;
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: termTheme(),
  });
  try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch { fit = null; }
  term.open(el('dock-term'));
  term.onData((d: string) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'input', data: d })); });
  window.addEventListener('resize', () => { if (getState().ui.dockOpen) fitAndResize(); });
  window.addEventListener('themechange', () => { if (term) { try { term.options.theme = termTheme(); } catch { /* ignore */ } } });
  mounted = true;
}

function fitAndResize(): void {
  if (fit) { try { fit.fit(); } catch { /* ignore */ } }
  if (term && sock && sock.readyState === 1) {
    sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function connect(): void {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  setStatus('connecting…', false);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  sock = new WebSocket(proto + '://' + location.host + '/ws/agent');
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => { setStatus('connected', true); fitAndResize(); };
  sock.onmessage = (ev) => {
    const d = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    if (term) term.write(d);
  };
  sock.onclose = () => setStatus('disconnected', false);
  sock.onerror = () => setStatus('connection error', false);
}

export function openDock(): void {
  if (!mounted) initTerm();
  setUi({ dockOpen: true });
}

export function closeDock(): void {
  setUi({ dockOpen: false });
}

export function toggleDock(): void {
  getState().ui.dockOpen ? closeDock() : openDock();
}

export function restartDock(): void {
  if (sock && sock.readyState === 1) {
    if (term) term.reset();
    setStatus('restarting…', true);
    sock.send(JSON.stringify({ type: 'restart' }));
    setTimeout(fitAndResize, 300);
  } else {
    if (term) term.reset();
    connect();
  }
}

/** Reconcile the dock's imperative DOM/connection with `ui.dockOpen`. */
export function syncDock(): void {
  const open = getState().ui.dockOpen;
  const dock = el('dock');
  if (!dock) return;
  dock.classList.toggle('open', open);
  document.body.classList.toggle('dock-open', open);
  if (open) {
    if (!mounted) initTerm();
    connect();
    setTimeout(() => { fitAndResize(); if (term) term.focus(); }, 270);
  }
  writeHash();
}
