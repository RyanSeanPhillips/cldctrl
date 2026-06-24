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
  const theme = document.documentElement.getAttribute('data-theme') || '';
  const light = theme === 'daylight' || theme === 'paper';
  const base: Record<string, string> = {
    background: v('--surface-1', '#0d121d'),
    foreground: v('--text', '#e4e8ef'),
    cursor: v('--accent', '#e87632'),
    cursorAccent: v('--surface-1', '#0d121d'),
    // accent-soft (12%) is too faint for selected TEXT — use a stronger wash.
    selectionBackground: light ? 'rgba(224,101,31,0.30)' : 'rgba(232,118,50,0.34)',
    green: v('--success', '#2dd4bf'), brightGreen: v('--success', '#2dd4bf'),
    blue: v('--info', '#4f9cff'), brightBlue: v('--info', '#4f9cff'),
    yellow: v('--warn', '#f59e0b'), brightYellow: v('--warn', '#f59e0b'),
    red: v('--crit', '#ef4444'), brightRed: v('--crit', '#ef4444'),
  };
  // xterm's default black/white/cyan/magenta are tuned for dark backgrounds; on a
  // light terminal the "dim" (brightBlack) text used by CLIs goes near-invisible.
  // Map the full palette per theme so secondary/dim text stays readable.
  if (light) {
    return {
      ...base,
      black: v('--text', '#1a2230'), brightBlack: v('--text-muted', '#5b6678'),
      white: v('--text-secondary', '#46536b'), brightWhite: v('--text', '#1a2230'),
      cyan: '#0e7490', brightCyan: '#0e7490', magenta: '#a21caf', brightMagenta: '#a21caf',
    };
  }
  return {
    ...base,
    black: '#0d121d', brightBlack: '#64748b',
    white: '#cfd6e2', brightWhite: '#ffffff',
    cyan: '#22d3ee', brightCyan: '#22d3ee', magenta: '#c084fc', brightMagenta: '#c084fc',
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
    minimumContrastRatio: 4.5, // keep dim CLI text readable on the light theme's white bg
  });
  try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch { fit = null; }
  term.open(el('dock-term'));
  term.onData((d: string) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'input', data: d })); });
  // Ctrl/Cmd+C copies the selection (interrupt only when nothing selected), Ctrl/Cmd+V pastes.
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C') && term!.hasSelection()) {
      navigator.clipboard?.writeText(term!.getSelection()).catch(() => { /* ignore */ });
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard?.readText().then((t) => { if (t && sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'input', data: t })); }).catch(() => { /* ignore */ });
      return false;
    }
    return true;
  });
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

let prevOpen = false;
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
    // Only fit + focus when the dock JUST opened — NOT on every 3s poll, or it
    // would keep stealing the cursor from a cockpit tile you're typing in.
    if (!prevOpen) setTimeout(() => { fitAndResize(); if (term) term.focus(); }, 270);
  }
  prevOpen = open;
  writeHash();
}
