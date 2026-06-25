/**
 * Cockpit — a grid of tiles in the Conversations pane. Two kinds:
 *  - terminal tiles (resume/new): a live `claude`/`codex`/… PTY over xterm.
 *  - doc tiles: a markdown file with an editor + live preview, for drafting text
 *    beside a chat. Auto-reloads when the agent edits the file on disk.
 * Tiles are managed IMPERATIVELY, outside the uhtml tree, so the 3s poll never
 * wipes them; `syncCockpit()` reconciles the DOM/PTYs with the store.
 */
import { marked } from 'marked';
import { getState, setCockpit } from './store.js';
import type { CockpitTile } from './store.js';
import { termTheme } from './dock.js';
import { fetchFile, postFile } from './api.js';
import { registerFileLinks } from './termlinks.js';
import { toast } from './toast.js';
import { flagAttention } from './tabalert.js';

declare const Terminal: any;
declare const FitAddon: any;

interface LiveTile {
  el: HTMLElement;
  kind: 'resume' | 'new' | 'doc';
  dispose: () => void;
  fit?: () => void;
  restart?: () => void;       // terminal tiles
  setTheme?: () => void;      // terminal tiles
  toggleCompose?: (force?: boolean) => void;    // terminal tiles — show/hide compose-box
  inject?: (text: string, autoSend: boolean) => void; // terminal tiles — message-in (#9)
  toggleMode?: () => void;    // doc tiles
  save?: () => void;          // doc tiles
  speak?: () => void;         // doc tiles — read aloud (toggle)
}
const tiles = new Map<string, LiveTile>();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** A deterministic colored monogram for a project, so each tile reads at a glance
 *  which project it is (a lightweight stand-in for per-project logos). */
function monogram(title: string): { initials: string; hue: number } {
  const base = (title.split('·')[0] || title).trim() || title;
  const words = base.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/);
  const initials = (words.length > 1
    ? words[0][0] + words[1][0]
    : base.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2)).toUpperCase() || '··';
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return { initials, hue: h % 360 };
}

// ── terminal tiles ───────────────────────────────────────────
function wsUrl(t: CockpitTile): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = proto + '://' + location.host + '/ws/term?path=' + encodeURIComponent(t.projectPath);
  if (t.kind === 'new') {
    let u = base + '&kind=new&id=' + encodeURIComponent(t.id);
    if (t.agent) u += '&agent=' + encodeURIComponent(t.agent);
    if (t.worktree) u += '&worktree=1&branch=' + encodeURIComponent(t.branch ?? '');
    if (t.prompt) u += '&prompt=' + encodeURIComponent(t.prompt);
    return u;
  }
  return base + '&kind=resume&session=' + encodeURIComponent(t.sessionId ?? '');
}

function createTermTile(meta: CockpitTile): LiveTile {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = meta.id;
  const mg = monogram(meta.title);
  const feats = getState().data?.features;
  const pp = esc(meta.projectPath);
  const locBtns =
    (feats?.openExplorer ? `<button class="btn icon" data-act="tile-reveal" data-path="${pp}" title="Open project folder">&#128193;</button>` : '') +
    (feats?.openVscode ? `<button class="btn icon" data-act="tile-code" data-path="${pp}" title="Open in VS Code">&lt;/&gt;</button>` : '');
  // Read the latest agent reply aloud (only when we know the session id).
  const readBtn = meta.sessionId
    ? `<button class="btn icon" data-act="tile-readout" data-session="${esc(meta.sessionId)}" title="Read the latest reply aloud">&#128266;</button>`
    : '';
  el.innerHTML = `
    <div class="tile-head" data-act="tile-focus" data-id="${esc(meta.id)}">
      <span class="tile-grip" draggable="true" title="Drag to reorder">&#10303;</span>
      <span class="tile-ava" style="background:hsl(${mg.hue} 52% 42%)">${esc(mg.initials)}</span>
      <span class="dot on"></span>
      <span class="tile-title">${esc(meta.title)}</span>
      <span class="tile-status">connecting…</span>
      <span class="sp"></span>
      <button class="btn icon" data-act="tile-scratch" data-id="${esc(meta.id)}" title="Open a scratchpad to draft beside this chat">&#9998;</button>
      ${readBtn}
      ${locBtns}
      <button class="btn icon" data-act="tile-shot" data-id="${esc(meta.id)}" title="Screenshot into this session">&#128247;</button>
      <button class="btn icon" data-act="tile-compose" data-id="${esc(meta.id)}" title="Compose box — spellcheck, edit, paste &amp; multi-line (the terminal stays primary)">&#128221;</button>
      <button class="btn icon" data-act="tile-restart" data-id="${esc(meta.id)}" title="Restart">&#8635;</button>
      <button class="btn icon" data-act="tile-max" data-id="${esc(meta.id)}" title="Maximize">&#8689;</button>
      <button class="btn icon" data-act="tile-close" data-id="${esc(meta.id)}" title="Close">&#10005;</button>
    </div>
    <div class="tile-term"></div>
    <div class="tile-compose" style="display:none">
      <textarea class="compose-input" rows="1" spellcheck="true"
        placeholder="Compose a message — Enter sends · Shift+Enter newline · Esc back to terminal"></textarea>
      <button class="btn primary compose-send" title="Send to the conversation">Send</button>
    </div>`;

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    fontSize: 12, cursorBlink: true, scrollback: 4000, allowProposedApi: true, theme: termTheme(),
    // force ≥4.5:1 contrast so the CLI's dim/faint text stays readable on the
    // light theme's white terminal background
    minimumContrastRatio: 4.5,
  });
  let fit: any = null;
  try { fit = new FitAddon.FitAddon(); term.loadAddon(fit); } catch { fit = null; }
  term.open(el.querySelector('.tile-term'));

  const status = el.querySelector('.tile-status') as HTMLElement;
  const dot = el.querySelector('.dot') as HTMLElement;

  // Auto-reconnecting socket: after the machine sleeps/reboots (or the server
  // idle-kills the PTY), the old WS is dead and typing silently no-ops. Re-open
  // it instead — the server re-spawns the PTY (resume: → `claude --resume`,
  // new: → fresh) and replays its buffer, so tiles self-heal without a manual
  // close+reopen.
  let sock: WebSocket | null = null;
  let closedByUs = false, retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // flag tab attention when the agent produces output then goes quiet while you're
  // on another tab (i.e., it likely finished its turn / needs input)
  let idleAlertTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleIdleAlert = () => {
    if (!document.hidden) return;
    if (idleAlertTimer) clearTimeout(idleAlertTimer);
    idleAlertTimer = setTimeout(() => flagAttention(meta.title + ' · needs input'), 4000);
  };
  const send = (msg: any): boolean => { if (sock && sock.readyState === 1) { sock.send(JSON.stringify(msg)); return true; } return false; };
  const doFit = () => { if (fit) { try { fit.fit(); } catch { /* ignore */ } } send({ type: 'resize', cols: term.cols, rows: term.rows }); };
  const connect = () => {
    if (closedByUs) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    sock = new WebSocket(wsUrl(meta));
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { retry = 0; if (status) status.textContent = 'live'; if (dot) dot.className = 'dot on'; setTimeout(doFit, 40); };
    sock.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data); term.write(d); scheduleIdleAlert(); };
    sock.onclose = () => {
      if (dot) dot.className = 'dot';
      if (closedByUs) return;
      if (status) status.textContent = 'reconnecting…';
      retry++;
      reconnectTimer = setTimeout(connect, Math.min(600 * retry, 4000));
    };
    sock.onerror = () => { try { sock?.close(); } catch { /* triggers onclose → reconnect */ } };
  };
  // typing into a dead socket → kick a reconnect instead of dropping the input
  term.onData((d: string) => { if (!send({ type: 'input', data: d })) connect(); });
  // Terminals don't map Ctrl/Cmd+C/V to clipboard. Make Ctrl+C copy the SELECTION
  // (and only fall through to interrupt when nothing is selected), Ctrl+V paste.
  let lastCtrlC = 0;
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()).catch(() => { /* ignore */ }); return false; } // copy
      // no selection → interrupt passes through; warn only on the SECOND press
      // within 1.5s (the double-Ctrl+C that EXITS Claude), not ordinary interrupts.
      const now = Date.now();
      if (now - lastCtrlC < 1500) toast('⚠ Double Ctrl+C — Claude will exit this session');
      lastCtrlC = now;
      return true;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard?.readText().then((t) => { if (t && !send({ type: 'input', data: t })) connect(); }).catch(() => { /* ignore */ });
      return false;
    }
    return true;
  });
  registerFileLinks(term, meta.projectPath); // clickable file paths in output
  try { term.onBell(() => flagAttention(meta.title + ' · needs input')); } catch { /* onBell needs proposed API */ }
  // wake-from-sleep / network back: reconnect any tile whose socket died
  const onWake = () => { if (!closedByUs && (!sock || sock.readyState > 1)) connect(); };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  connect();

  // ── compose-box ───────────────────────────────────────────
  // A real <textarea> beneath the terminal: native click-to-edit, spellcheck and
  // paste (things xterm can't give you), then send the composed message into the
  // PTY on Enter. Multi-line text is wrapped in bracketed-paste so the agent
  // treats embedded newlines as literal content instead of submitting each line.
  const composeBar = el.querySelector('.tile-compose') as HTMLElement;
  const composeTa = el.querySelector('.compose-input') as HTMLTextAreaElement;
  const composeBtn = el.querySelector('.compose-send') as HTMLButtonElement;
  const composeAutosize = () => {
    if (!composeTa.value) { composeTa.style.height = ''; return; } // empty → let CSS min-height keep it one line
    composeTa.style.height = 'auto';
    composeTa.style.height = Math.min(composeTa.scrollHeight, 140) + 'px';
  };
  const sendCompose = (): void => {
    const text = composeTa.value;
    if (!text.trim()) { composeTa.focus(); return; }
    const data = text.includes('\n') ? '\x1b[200~' + text + '\x1b[201~\r' : text + '\r';
    if (!send({ type: 'input', data })) { connect(); return; } // dead socket → reconnect, keep text to retry
    composeTa.value = ''; composeAutosize(); composeTa.focus();
  };
  composeTa.addEventListener('input', composeAutosize);
  composeTa.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(); }
    // Escape collapses the compose box and hands focus back to the terminal for
    // raw interaction (slash-menu autocomplete, y/n prompts, Ctrl+C, arrows).
    else if (e.key === 'Escape') { toggleCompose(false); try { term.focus(); } catch { /* ignore */ } }
  });
  composeBtn.addEventListener('click', sendCompose);
  // Terminal stays PRIMARY (slash-command autocomplete, y/n prompts, interrupts,
  // plan mode all need the real TUI). The compose box is an opt-in helper for the
  // things a terminal prompt line can't do — spellcheck, multi-line, paste, edit —
  // toggled by the 📝 button. Esc drops you straight back into the terminal.
  let composeOpen = false;
  const toggleCompose = (force?: boolean): void => {
    composeOpen = force ?? !composeOpen;
    composeBar.style.display = composeOpen ? '' : 'none';
    el.querySelector('[data-act="tile-compose"]')?.classList.toggle('on', composeOpen);
    setTimeout(doFit, 60); // term shrank/grew — refit
    if (composeOpen) { composeAutosize(); composeTa.focus(); }
  };

  return {
    el, kind: meta.kind === 'new' ? 'new' : 'resume', fit: doFit,
    toggleCompose,
    // Programmatic message-in (#9): drop text into this running session, optionally
    // opening the compose-box first so the user can confirm/edit before it submits.
    inject: (text: string, autoSend: boolean) => {
      toggleCompose(true);
      composeTa.value = text; composeAutosize(); composeTa.focus();
      if (autoSend) sendCompose();
    },
    dispose: () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (idleAlertTimer) clearTimeout(idleAlertTimer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      try { sock?.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
    },
    restart: () => {
      if (sock && sock.readyState === 1) { term.reset(); send({ type: 'restart' }); setTimeout(doFit, 200); }
      else connect(); // socket dead → just re-establish it
    },
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
      <span class="tile-grip" draggable="true" title="Drag to reorder">&#10303;</span>
      <span class="doc-mark">&#9998;</span>
      <span class="tile-title" title="${esc(file)}">${esc(name)}</span>
      <span class="doc-status"></span>
      <span class="sp"></span>
      <button class="btn icon" data-act="doc-toggle" data-id="${esc(meta.id)}" title="Edit / preview">&#9998;</button>
      <button class="btn icon" data-act="doc-speak" data-id="${esc(meta.id)}" title="Read aloud (selection, else whole doc)">&#128266;</button>
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
  const speakBtn = el.querySelector('[data-act="doc-speak"]') as HTMLButtonElement | null;
  // Clicking a header button normally blurs the editor / clears the page
  // selection before our handler runs — preventDefault on mousedown keeps the
  // highlight intact so "read selection" works.
  speakBtn?.addEventListener('mousedown', (e) => e.preventDefault());

  // Scratchpads open in edit mode (focused) for immediate typing; other doc
  // tiles (e.g. a project .md from the Files tab) open in preview.
  let content = '', mtime = 0, mode: 'preview' | 'edit' = meta.scratch ? 'edit' : 'preview', dirty = false;
  let reading = false; // karaoke read-aloud view is up
  const renderPreview = () => { try { previewEl.innerHTML = marked.parse(content) as string; } catch { previewEl.textContent = content; } };

  const load = async () => {
    if (reading) return; // don't re-render the doc while the karaoke view is up
    const r = await fetchFile(file);
    if (!r) { statusEl.textContent = 'not found'; return; }
    if (dirty) { if (r.mtime !== mtime) statusEl.textContent = 'changed on disk'; return; } // don't clobber edits
    if (r.content === content) { statusEl.textContent = ''; return; } // unchanged — don't reset the textarea (caret) every poll
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
    try {
      const r = await postFile(file, editEl.value);
      if (r.ok) { content = editEl.value; mtime = r.mtime ?? mtime; dirty = false; statusEl.textContent = 'saved'; setTimeout(() => { if (!dirty) statusEl.textContent = ''; }, 1500); }
      else statusEl.textContent = '✗ ' + (r.error || 'save failed');
    } catch { statusEl.textContent = '✗ save failed (network)'; } // never hang on "saving…"
  };

  // Read aloud via the browser's Web Speech API — no server, no key, offline.
  // Reads the current selection if there is one, else the whole doc; toggles off.
  const stripMd = (s: string) => s.replace(/`{1,3}/g, '').replace(/^[#>\s-]+/gm, '').replace(/[*_~]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const setSpeaking = (on: boolean) => {
    if (!speakBtn) return;
    speakBtn.innerHTML = on ? '&#9209;' : '&#128266;';       // ⏹ stop  /  🔊 speaker
    speakBtn.title = on ? 'Stop reading' : 'Read aloud (selection, else whole doc)';
    speakBtn.classList.toggle('on', on);
  };
  // Karaoke: render the spoken text as word spans in the preview and light up
  // the word currently being read (driven by the utterance's boundary events),
  // scrolling to follow. Restores the prior view when reading stops.
  let rwSpans: HTMLElement[] = [], rwStarts: number[] = [], rwActive = -1, prevReadMode: 'preview' | 'edit' = 'preview';
  const renderReading = (text: string) => {
    const re = /\S+/g; let m: RegExpExecArray | null, cursor = 0, html = '';
    rwStarts = [];
    while ((m = re.exec(text))) {
      html += esc(text.slice(cursor, m.index));
      rwStarts.push(m.index);
      html += `<span class="rw">${esc(m[0])}</span>`;
      cursor = m.index + m[0].length;
    }
    html += esc(text.slice(cursor));
    previewEl.innerHTML = `<div class="reading">${html.replace(/\n/g, '<br>')}</div>`;
    rwSpans = Array.from(previewEl.querySelectorAll('.rw')) as HTMLElement[];
    editEl.style.display = 'none'; previewEl.style.display = ''; // show the highlight even if we were editing
  };
  const highlightAt = (charIndex: number) => {
    let i = -1;
    for (let k = 0; k < rwStarts.length; k++) { if (rwStarts[k] <= charIndex) i = k; else break; }
    if (i < 0 || i === rwActive) return;
    rwSpans[rwActive]?.classList.remove('on');
    rwActive = i;
    rwSpans[i]?.classList.add('on');
    rwSpans[i]?.scrollIntoView({ block: 'nearest' });
  };
  const endReading = () => {
    if (!reading) return;
    reading = false; rwActive = -1; rwSpans = []; rwStarts = [];
    setSpeaking(false);
    setMode(prevReadMode); // restore markdown preview / textarea
  };
  const speak = () => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (synth.speaking || synth.pending || reading) { synth.cancel(); endReading(); return; } // toggle off
      const sel = mode === 'edit'
        ? editEl.value.substring(editEl.selectionStart ?? 0, editEl.selectionEnd ?? 0)
        : (window.getSelection()?.toString() ?? '');
      const text = (sel.trim() || stripMd(content || editEl.value)).slice(0, 32000).trim();
      if (!text) return;
      prevReadMode = mode;
      reading = true;
      renderReading(text);
      setSpeaking(true);
      const u = new SpeechSynthesisUtterance(text);
      u.onboundary = (e) => { if (reading) highlightAt(e.charIndex); };
      u.onend = () => endReading();
      u.onerror = () => endReading();
      synth.speak(u);
    } catch { reading = false; }
  };

  load();
  if (mode === 'edit') setMode('edit'); // show + focus the textarea on mount (scratchpads)
  const poll = setInterval(load, 2500); // pick up the agent's edits to the file

  return {
    el, kind: 'doc',
    dispose: () => { clearInterval(poll); try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } },
    toggleMode: () => setMode(mode === 'preview' ? 'edit' : 'preview'),
    save,
    speak,
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

// ── drag-to-reorder ──────────────────────────────────────────
// Grips on each tile header start an HTML5 drag; dropping over another tile
// reorders the store's `cp.tiles` array. syncCockpit then re-orders the DOM to
// match WITHOUT recreating tiles, so PTYs/xterm state survive the reorder.
let dndWired = false;
let draggingId: string | null = null;
function reorderTiles(targetId: string, before: boolean): void {
  if (!draggingId || draggingId === targetId) return;
  const cp = getState().ui.cockpit;
  const arr = [...cp.tiles];
  const from = arr.findIndex((t) => t.id === draggingId);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  let to = arr.findIndex((t) => t.id === targetId);
  if (to < 0) { arr.push(moved); } else { if (!before) to++; arr.splice(to, 0, moved); }
  if (arr.some((t, i) => t.id !== cp.tiles[i]?.id)) setCockpit({ tiles: arr });
}
function wireGridDnD(grid: HTMLElement): void {
  if (dndWired) return;
  dndWired = true;
  grid.addEventListener('dragstart', (e) => {
    const grip = (e.target as HTMLElement).closest('.tile-grip');
    if (!grip) return;
    const tile = grip.closest('.tile') as HTMLElement | null;
    if (!tile) return;
    draggingId = tile.dataset.id ?? null;
    tile.classList.add('dragging');
    try { e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', draggingId ?? ''); } catch { /* ignore */ }
  });
  grid.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    e.preventDefault(); // allow drop
    try { e.dataTransfer!.dropEffect = 'move'; } catch { /* ignore */ }
    const tile = (e.target as HTMLElement).closest('.tile') as HTMLElement | null;
    grid.querySelectorAll('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (tile && tile.dataset.id !== draggingId) {
      const r = tile.getBoundingClientRect();
      tile.classList.add((e as DragEvent).clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    }
  });
  grid.addEventListener('drop', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    const tile = (e.target as HTMLElement).closest('.tile') as HTMLElement | null;
    if (tile && tile.dataset.id && tile.dataset.id !== draggingId) {
      const r = tile.getBoundingClientRect();
      reorderTiles(tile.dataset.id, (e as DragEvent).clientX < r.left + r.width / 2);
    }
  });
  const clearDnD = () => {
    grid.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
    draggingId = null;
  };
  grid.addEventListener('dragend', clearDnD);
  grid.addEventListener('drop', clearDnD);
}

/** Reconcile the imperative cockpit DOM/PTYs with the store's cockpit state. */
export function syncCockpit(): void {
  const st = getState();
  const cp = st.ui.cockpit;
  const root = document.getElementById('cockpit');
  const grid = document.getElementById('cockpit-grid');
  if (!root || !grid) return;
  wireGridDnD(grid);

  // Moving a tile's node (createTile append / order-enforcement insertBefore)
  // BLURS any focused descendant — the compose <textarea> you're typing in. The
  // node survives intact (value + caret), only focus is lost. Capture it here and
  // restore at the end so a poll that re-parents a tile doesn't yank your cursor.
  const ae = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
  const keepFocus = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && grid.contains(ae)
    ? { el: ae, start: ae.selectionStart, end: ae.selectionEnd } : null;

  const show = cp.open && cp.tab !== 'stats' && !st.ui.selectedProject && !st.search.query.trim();
  root.classList.toggle('open', show);
  grid.className = 'cockpit-grid ' + cp.layout + (cp.maximized ? ' has-max' : '');

  const wanted = new Set(cp.tiles.map((t) => t.id));
  for (const id of [...tiles.keys()]) if (!wanted.has(id)) destroyTile(id);
  const hidden = new Set(cp.hiddenProjects);
  for (const meta of cp.tiles) {
    let t = tiles.get(meta.id);
    if (!t) { t = createTile(meta); tiles.set(meta.id, t); grid.appendChild(t.el); }
    t.el.classList.toggle('maxed', cp.maximized === meta.id);
    // Focus chips: mute a project's tiles without tearing down their PTYs.
    t.el.classList.toggle('hidden-proj', hidden.has(meta.projectPath));
  }

  // Enforce DOM order = store order (drag-reorder). appendChild MOVES existing
  // nodes, preserving their xterm/PTY — only re-append when out of order so the
  // 3s poll doesn't thrash the DOM.
  let domChanged = false;
  let prev: Element | null = null;
  for (const meta of cp.tiles) {
    const t = tiles.get(meta.id);
    if (!t) continue;
    const want: Element | null = prev ? prev.nextElementSibling : grid.firstElementChild;
    if (want !== t.el) { grid.insertBefore(t.el, want); domChanged = true; }
    prev = t.el;
  }

  // Re-focus the compose box if a DOM move blurred it (text/caret are preserved).
  if (keepFocus && keepFocus.el.isConnected && document.activeElement !== keepFocus.el) {
    keepFocus.el.focus();
    try { keepFocus.el.setSelectionRange(keepFocus.start ?? 0, keepFocus.end ?? 0); } catch { /* ignore */ }
  }

  if (show || domChanged) { setTimeout(refitAll, 70); setTimeout(refitAll, 280); }
}

function refitAll(): void { for (const t of tiles.values()) t.fit?.(); }

export function restartTile(id: string): void { tiles.get(id)?.restart?.(); }
export function toggleTileCompose(id: string): void { tiles.get(id)?.toggleCompose?.(); }
/** Inject a message into a running terminal tile (message-in, #9). */
export function injectIntoTile(id: string, text: string, autoSend = false): boolean {
  const t = tiles.get(id);
  if (!t?.inject) return false;
  t.inject(text, autoSend);
  return true;
}
export function docToggle(id: string): void { tiles.get(id)?.toggleMode?.(); }
export function docSave(id: string): void { tiles.get(id)?.save?.(); }
export function docSpeak(id: string): void { tiles.get(id)?.speak?.(); }

window.addEventListener('resize', () => { if (getState().ui.cockpit.open) refitAll(); });
window.addEventListener('themechange', () => { for (const t of tiles.values()) t.setTheme?.(); });
