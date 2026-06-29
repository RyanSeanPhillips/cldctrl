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
import { fetchFile, postFile, postNotepad, postNewNote, fetchNotes, postRecordNote, fetchNoteHistory, postRestoreNote, type NoteEntry, type NoteRevision } from './api.js';
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
  toggleNote?: (force?: boolean) => void;       // terminal tiles — show/hide docked notepad
  openNoteAt?: (path: string) => void;          // terminal tiles — dock a specific file as the notepad (agent scratchpad routing)
  setContext?: (size: number, model: string | null, window?: number) => void; // terminal tiles — context-window meter
  setReadSession?: (sid: string | null) => void; // terminal tiles — bind/show the read-aloud button once a session id is known
  focus?: () => void;         // terminal tiles — focus the xterm
  inject?: (text: string, autoSend: boolean) => void; // terminal tiles — message-in (#9)
  toggleMode?: () => void;    // doc tiles
  save?: () => void;          // doc tiles
  speak?: () => void;         // doc tiles — read aloud (toggle)
}
const tiles = new Map<string, LiveTile>();

// ── "needs input" attention ──────────────────────────────────
// A conversation is "waiting for you" when its agent went quiet after working, or
// rang the bell. We track those tile ids in the store so the always-visible cockpit
// toolbar can show a "● N waiting" pill (and the tile header pulses in grid mode).
// Ephemeral by design — not persisted, so it never survives a reload.
function setAttn(id: string, on: boolean): void {
  const cur = getState().ui.cockpit.attnTiles ?? [];
  const has = cur.includes(id);
  if (on === has) { tiles.get(id)?.el.classList.toggle('attn', on); return; } // class only
  setCockpit({ attnTiles: on ? [...cur, id] : cur.filter((x) => x !== id) });
  tiles.get(id)?.el.classList.toggle('attn', on);
}
const markAttn = (id: string) => setAttn(id, true);
const clearAttn = (id: string) => setAttn(id, false);
/** Drop a tile's "waiting" state from outside (e.g. when it's maximized/focused). */
export function clearTileAttn(id: string): void { clearAttn(id); }
/** Toolbar "waiting" pill → bring the oldest waiting conversation to the front. */
export function focusWaitingTile(): void {
  const cp = getState().ui.cockpit;
  const id = (cp.attnTiles ?? [])[0];
  if (!id) return;
  if (cp.maximized) setCockpit({ maximized: id }); // swap the full-bleed tile to this one
  clearAttn(id);
  const t = tiles.get(id);
  if (t) { try { t.el.scrollIntoView({ block: 'nearest' }); t.focus?.(); } catch { /* ignore */ } }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// ── context-window meter ─────────────────────────────────────
// Per-tile "how full is this conversation's context" gauge (the thing Claude Code
// itself shows). The size is the last assistant turn's prompt tokens
// (cacheRead + input + cacheCreation = lastContextSize), divided by the model's
// window. Most Claude models are 200k; the 1M-context variants report "[1m]".
function contextWindowFor(model: string | null): number {
  if (model && /\b1m\b|1m]|-1m/i.test(model)) return 1_000_000;
  return 200_000;
}
function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
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
  // Read the latest agent reply aloud. Always rendered, but hidden until we know a
  // session id — fresh ('new') tiles only discover theirs after claude writes the
  // first JSONL, so setReadSession() reveals + binds it later (in syncCockpit).
  const readBtn = `<button class="btn icon" data-act="tile-readout" data-session="${esc(meta.sessionId ?? '')}" title="Read the latest reply aloud"${meta.sessionId ? '' : ' style="display:none"'}>&#128266;</button>`;
  el.innerHTML = `
    <div class="tile-head" data-act="tile-focus" data-id="${esc(meta.id)}">
      <span class="tile-grip" draggable="true" title="Drag to reorder">&#10303;</span>
      <span class="tile-ava" style="background:hsl(${mg.hue} 52% 42%)">${esc(mg.initials)}</span>
      <span class="dot on"></span>
      <span class="tile-title">${esc(meta.title)}</span>
      <span class="tile-ctx-pct" style="display:none" title=""></span>
      <span class="tile-status">connecting…</span>
      <span class="sp"></span>
      <i class="tile-ctxline" style="display:none"></i>
      <button class="btn icon" data-act="tile-note" data-id="${esc(meta.id)}" title="Notepad — a draft docked to this conversation that persists with it (autosaves; the agent's edits sync in)">&#128211;</button>
      ${readBtn}
      ${locBtns}
      <button class="btn icon" data-act="tile-shot" data-id="${esc(meta.id)}" title="Screenshot into this session">&#128247;</button>
      <button class="btn icon" data-act="tile-compose" data-id="${esc(meta.id)}" title="Compose box — spellcheck, edit, paste &amp; multi-line (the terminal stays primary)">&#128221;</button>
      <button class="btn icon" data-act="tile-restart" data-id="${esc(meta.id)}" title="Restart">&#8635;</button>
      <button class="btn icon" data-act="tile-max" data-id="${esc(meta.id)}" title="Maximize">&#8689;</button>
      <button class="btn icon" data-act="tile-close" data-id="${esc(meta.id)}" title="Close">&#10005;</button>
    </div>
    <div class="tile-main">
      <div class="tile-term"></div>
      <div class="tile-note" style="display:none">
        <div class="note-head">
          <span class="note-mark">&#128211;</span>
          <button class="note-name" data-note="menu" title="Switch note · new · open from this project"><span class="note-name-text">notepad</span> <span class="note-caret">&#9662;</span></button>
          <span class="note-status"></span>
          <span class="sp"></span>
          <button class="btn icon" data-note="chat" title="Ask the agent to read &amp; review this draft (sends a clear instruction + the file path so it reads it directly, no searching)">&#128206;</button>
          <button class="btn icon" data-note="read" title="Read aloud (selection, else the whole note)">&#128266;</button>
          <button class="btn icon" data-note="mode" title="Edit / preview">&#9998;</button>
          <button class="btn icon" data-note="save" title="Save (Ctrl+S)">&#128190;</button>
          <div class="note-menu" style="display:none"></div>
        </div>
        <textarea class="note-edit" spellcheck="true"
          placeholder="Draft beside the chat — autosaves · Ctrl+S · the agent's edits to this file sync in"></textarea>
        <div class="note-preview markdown" style="display:none"></div>
      </div>
    </div>
    <div class="tile-compose" style="display:none">
      <textarea class="compose-input" rows="1" spellcheck="true"
        placeholder="Compose a message — Enter sends · Shift+Enter newline · Esc back to terminal"></textarea>
      <button class="btn primary compose-send" title="Send to the conversation">Send</button>
    </div>`;

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    fontSize: 12, cursorBlink: true, scrollback: 4000, allowProposedApi: true, theme: termTheme(),
    // force high contrast so the CLI's dim/faint text (e.g. the selected option in
    // Claude Code's permission prompt) stays legible — esp. on the light theme's
    // white bg, where the CLI's dim color otherwise reads washed-out (~5.8:1).
    minimumContrastRatio: 7,
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
  // Attention: a conversation "needs input" when its agent produces output then
  // goes quiet (turn finished) or rings the bell. Two consumers: the browser-tab
  // flash (only when you're on another tab) and the in-app "● N waiting" pill +
  // tile-header pulse (whenever the tile isn't the one you're already looking at).
  // `armed` gates marking until the reconnect buffer-replay settles, so resumed
  // tiles don't all light up as "waiting" the instant they load.
  let idleAttnTimer: ReturnType<typeof setTimeout> | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;
  const arm = () => { armed = false; if (armTimer) clearTimeout(armTimer); armTimer = setTimeout(() => { armed = true; }, 6000); };
  const focused = () => getState().ui.cockpit.maximized === meta.id // already full-bleed
    || el.contains(document.activeElement); // or you're typing in this tile
  const onIdle = () => {
    if (document.hidden) flagAttention(meta.title + ' · needs input');
    if (armed && !focused()) markAttn(meta.id);
  };
  const onOutput = () => {
    clearAttn(meta.id); // streaming → working, not waiting (also drops a stale pulse)
    if (idleAttnTimer) clearTimeout(idleAttnTimer);
    idleAttnTimer = setTimeout(onIdle, 5000);
  };
  const send = (msg: any): boolean => { if (sock && sock.readyState === 1) { sock.send(JSON.stringify(msg)); return true; } return false; };
  const doFit = () => {
    if (fit) {
      // Preserve the scroll position across the resize. fit.fit() → term.resize(),
      // and a column change (grid ↔ fullscreen are different widths) REFLOWS the
      // buffer, which otherwise drops the viewport at a random line. Capture where
      // we are relative to the bottom, then restore after the reflow.
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      const fromBottom = buf.baseY - buf.viewportY;
      try { fit.fit(); } catch { /* ignore */ }
      try {
        if (atBottom) term.scrollToBottom();
        else term.scrollToLine(Math.max(0, term.buffer.active.baseY - fromBottom));
      } catch { /* ignore */ }
    }
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  };
  const connect = () => {
    if (closedByUs) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    sock = new WebSocket(wsUrl(meta));
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { retry = 0; if (status) status.textContent = 'live'; if (dot) dot.className = 'dot on'; arm(); setTimeout(doFit, 40); };
    sock.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data); term.write(d); onOutput(); };
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
  term.onData((d: string) => { clearAttn(meta.id); if (!send({ type: 'input', data: d })) connect(); });
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
  // The bell is the agent's explicit "I need you" (permission prompt / turn done):
  // flash the tab when you're away, and mark the tile waiting when you're not on it.
  try { term.onBell(() => { flagAttention(meta.title + ' · needs input'); if (armed && !focused()) markAttn(meta.id); }); } catch { /* onBell needs proposed API */ }
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

  // ── docked notepad ────────────────────────────────────────
  // A markdown draft that belongs to THIS conversation: keyed by the tile id so
  // resuming the chat reopens the same file (the server stores it under the
  // scratch dir → the file API allows read/write). Autosaves; the agent's edits
  // to the same file sync back in. Toggled by the 📓 header button; open-state
  // persists on the tile so it returns on restore.
  const noteBar = el.querySelector('.tile-note') as HTMLElement;
  const noteEdit = el.querySelector('.note-edit') as HTMLTextAreaElement;
  const notePreview = el.querySelector('.note-preview') as HTMLElement;
  const noteName = el.querySelector('.note-name-text') as HTMLElement;
  const noteMenu = el.querySelector('.note-menu') as HTMLElement;
  const noteStatus = el.querySelector('.note-status') as HTMLElement;
  let noteOpen = false, notePath: string | null = null, noteReqd = false;
  const convKey = meta.sessionId || meta.id; // stable conversation key for note association (survives new→resume)
  let noteAnnounced = !!meta.noteAnnounced; // one-time "a notepad is linked" notice already sent?
  let noteContent = '', noteMtime = 0, noteDirty = false, noteMode: 'edit' | 'preview' = 'edit';
  let notePoll: ReturnType<typeof setInterval> | null = null;
  let noteSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const noteRenderPreview = () => { try { notePreview.innerHTML = marked.parse(noteContent) as string; } catch { notePreview.textContent = noteContent; } };
  const noteSetMode = (m: 'edit' | 'preview') => {
    noteMode = m;
    noteEdit.style.display = m === 'edit' ? '' : 'none';
    notePreview.style.display = m === 'edit' ? 'none' : '';
    if (m === 'preview') noteRenderPreview(); else noteEdit.focus();
  };
  const noteLoad = async () => {
    if (!notePath) return;
    const r = await fetchFile(notePath);
    if (!r) { noteStatus.textContent = 'not found'; return; }
    if (noteDirty) { if (r.mtime !== noteMtime) noteStatus.textContent = 'agent edited — Ctrl+S keeps yours'; return; } // don't clobber edits
    if (r.content === noteContent) return; // unchanged — don't reset the caret every poll
    noteContent = r.content; noteMtime = r.mtime; noteEdit.value = noteContent;
    if (noteMode === 'preview') noteRenderPreview();
    noteStatus.textContent = '';
  };
  const noteSave = async () => {
    if (!notePath) return;
    if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
    noteStatus.textContent = 'saving…';
    try {
      const r = await postFile(notePath, noteEdit.value);
      if (r.ok) { noteContent = noteEdit.value; noteMtime = r.mtime ?? noteMtime; noteDirty = false; noteStatus.textContent = 'saved'; setTimeout(() => { if (!noteDirty) noteStatus.textContent = ''; }, 1200); }
      else noteStatus.textContent = '✗ ' + (r.error || 'save failed');
    } catch { noteStatus.textContent = '✗ save failed'; }
  };
  const persistNoteAnnounced = () => {
    const cp = getState().ui.cockpit;
    if (cp.tiles.find((t) => t.id === meta.id)?.noteAnnounced) return; // already flagged
    setCockpit({ tiles: cp.tiles.map((t) => (t.id === meta.id ? { ...t, noteAnnounced: true } : t)) });
  };
  // One-time: the FIRST time you edit the notepad, tell the agent it's linked (with
  // the absolute path) so it never hunts for a "scratchpad" it knows nothing about.
  // Fires once per conversation (persisted on the tile) and only while you're typing
  // in the notepad — focus is here, not the terminal, so it won't mangle a half-typed
  // command. Framed as FYI/"no action needed" to minimise interruption.
  const announceNote = (): void => {
    if (noteAnnounced || !notePath) return;
    noteAnnounced = true;
    persistNoteAnnounced();
    const msg = `(cldctrl) FYI: I've linked a notepad to this conversation — a scratchpad file at ${notePath}. When I refer to "the notepad" or "scratchpad", read or edit that file directly (no need to search). It's auto-versioned in git — if I ask to undo or go back to an earlier draft, use the list_note_revisions / restore_note tools on this path. No action needed right now.`;
    if (!send({ type: 'input', data: msg + '\r' })) connect();
  };
  noteEdit.addEventListener('input', () => {
    noteContent !== noteEdit.value && (noteDirty = true);
    if (noteDirty) noteStatus.textContent = 'unsaved';
    if (noteEdit.value.trim()) announceNote(); // first real edit → one-time linked-notepad notice
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(noteSave, 900); // debounced autosave
  });
  noteEdit.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); noteSave(); } });
  (el.querySelector('[data-note="save"]') as HTMLButtonElement).addEventListener('click', noteSave);
  (el.querySelector('[data-note="mode"]') as HTMLButtonElement).addEventListener('click', () => noteSetMode(noteMode === 'edit' ? 'preview' : 'edit'));
  // "→ chat": hand the draft to the agent. We inject a self-describing instruction
  // (not a bare path) so the agent reads the file DIRECTLY instead of hunting for a
  // "scratchpad" it knows nothing about — that search wastes turns and pollutes the
  // conversation. An empty compose gets the full framing; if you've already typed,
  // we just append the path (deduped) so your own wording leads.
  (el.querySelector('[data-note="chat"]') as HTMLButtonElement).addEventListener('click', () => {
    if (!notePath) return;
    toggleCompose(true);
    const blurb = `Please read and review the draft in my cldctrl notepad for this conversation — it's a docked scratchpad file, so read it directly at this path (no need to search): ${notePath}`;
    if (!composeTa.value.trim()) composeTa.value = blurb + ' ';
    else if (!composeTa.value.includes(notePath)) composeTa.value = composeTa.value.replace(/\s*$/, ' ') + notePath + ' ';
    composeAutosize(); composeTa.focus();
  });
  // Read the note aloud (selection if any, else the whole thing) via the browser's
  // Web Speech API — no server, no key. Toggles off. (Ported from the doc tile;
  // the docked notepad is now the single notepad system.)
  const noteStripMd = (s: string) => s.replace(/`{1,3}/g, '').replace(/^[#>\s-]+/gm, '').replace(/[*_~]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const noteReadBtn = el.querySelector('[data-note="read"]') as HTMLButtonElement;
  const setNoteSpeaking = (on: boolean) => {
    noteReadBtn.innerHTML = on ? '&#9209;' : '&#128266;'; // ⏹ stop / 🔊 speaker
    noteReadBtn.title = on ? 'Stop reading' : 'Read aloud (selection, else the whole note)';
    noteReadBtn.classList.toggle('on', on);
  };
  const noteReadAloud = () => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (synth.speaking || synth.pending) { synth.cancel(); setNoteSpeaking(false); return; } // toggle off
      const sel = noteEdit.value.substring(noteEdit.selectionStart ?? 0, noteEdit.selectionEnd ?? 0);
      const text = (sel.trim() || noteStripMd(noteEdit.value)).slice(0, 32000).trim();
      if (!text) return;
      setNoteSpeaking(true);
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => setNoteSpeaking(false);
      u.onerror = () => setNoteSpeaking(false);
      synth.speak(u);
    } catch { setNoteSpeaking(false); }
  };
  noteReadBtn.addEventListener('click', noteReadAloud);

  // ── note switcher (dropdown on the note name) ─────────────────
  // One conversation usually has one note, but you can keep several — and, more
  // importantly, pull up any note from THIS PROJECT (across its conversations).
  let noteMenuOpen = false;
  const agoShort = (ms: number): string => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  };
  const samePath = (a: string | null, b: string | null): boolean =>
    !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  const closeNoteMenu = (): void => { noteMenuOpen = false; noteMenu.style.display = 'none'; };
  const noteItemHtml = (n: NoteEntry): string =>
    `<button class="note-item${samePath(n.path, notePath) ? ' on' : ''}" data-np="${esc(n.path)}" title="${esc(n.preview || n.path)}">`
    + `<span class="ni-title">${esc(n.title || 'untitled')}</span><span class="ni-ago">${agoShort(n.updated)}</span></button>`;
  const renderNoteMenu = async (scope: 'project' | 'all' = 'project'): Promise<void> => {
    noteMenuOpen = true; noteMenu.style.display = '';
    noteMenu.innerHTML = '<div class="note-menu-empty">…</div>';
    const convNotes = await fetchNotes({ conversation: convKey });
    const wide = scope === 'all' ? await fetchNotes() : (meta.projectPath ? await fetchNotes({ project: meta.projectPath }) : []);
    const convSet = new Set(convNotes.map((n) => n.path.replace(/\\/g, '/').toLowerCase()));
    const others = wide.filter((n) => !convSet.has(n.path.replace(/\\/g, '/').toLowerCase()));
    if (!noteMenuOpen) return; // closed while awaiting
    let html = '';
    if (convNotes.length) html += '<div class="note-menu-sec">This conversation</div>' + convNotes.map(noteItemHtml).join('');
    if (others.length) html += `<div class="note-menu-sec">${scope === 'all' ? 'All notes' : 'This project'}</div>` + others.slice(0, 40).map(noteItemHtml).join('');
    if (!convNotes.length && !others.length) html += '<div class="note-menu-empty">No notes yet</div>';
    html += '<div class="note-menu-div"></div><button class="note-item act" data-act="new">&#65291; New note</button>';
    if (notePath) html += '<button class="note-item act" data-act="history">&#128338; History…</button>';
    if (scope !== 'all') html += '<button class="note-item act" data-act="all">&#128270; All notes…</button>';
    noteMenu.innerHTML = html;
  };
  const renderNoteHistory = async (): Promise<void> => {
    if (!notePath) return;
    noteMenuOpen = true; noteMenu.style.display = '';
    noteMenu.innerHTML = '<div class="note-menu-empty">…</div>';
    const revs = await fetchNoteHistory(notePath);
    if (!noteMenuOpen) return;
    let html = '<button class="note-item act" data-act="menu-back">&#8592; Back</button><div class="note-menu-sec">History — click to restore</div>';
    html += revs.length
      ? revs.map((r: NoteRevision) => `<button class="note-item" data-rev="${esc(r.hash)}" title="${esc(r.hash.slice(0, 8))} · ${esc(r.subject)}">`
          + `<span class="ni-title">${esc(agoShort(Date.parse(r.date)))} ago</span><span class="ni-ago">restore</span></button>`).join('')
      : '<div class="note-menu-empty">No history yet (saves snapshot to git as you write)</div>';
    noteMenu.innerHTML = html;
  };
  (el.querySelector('[data-note="menu"]') as HTMLButtonElement).addEventListener('click', (e) => {
    e.stopPropagation();
    if (noteMenuOpen) { closeNoteMenu(); return; }
    renderNoteMenu('project');
  });
  noteMenu.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest('[data-np],[data-act],[data-rev]') as HTMLElement | null;
    if (!item) return;
    if (item.dataset.act === 'all') { renderNoteMenu('all'); return; }
    if (item.dataset.act === 'history') { renderNoteHistory(); return; }
    if (item.dataset.act === 'menu-back') { renderNoteMenu('project'); return; }
    if (item.dataset.act === 'new') {
      closeNoteMenu();
      const r = await postNewNote(meta.projectPath, convKey);
      if (r.path) openNoteAt(r.path); else noteStatus.textContent = '✗ ' + (r.error || 'could not create note');
      return;
    }
    if (item.dataset.rev && notePath) {
      const target = notePath;
      closeNoteMenu();
      noteStatus.textContent = 'restoring…';
      const r = await postRestoreNote(target, item.dataset.rev);
      if (r.ok) { noteDirty = false; noteContent = ''; await noteLoad(); noteStatus.textContent = 'restored'; setTimeout(() => { if (!noteDirty) noteStatus.textContent = ''; }, 1500); }
      else noteStatus.textContent = '✗ ' + (r.error || 'restore failed');
      return;
    }
    if (item.dataset.np) { closeNoteMenu(); openNoteAt(item.dataset.np); }
  });
  const onDocMouseForNote = (e: MouseEvent): void => {
    if (noteMenuOpen && !noteMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-note="menu"]')) closeNoteMenu();
  };
  document.addEventListener('mousedown', onDocMouseForNote);

  const bindNotePath = (p: string): void => {
    notePath = p;
    noteName.textContent = p.split(/[/\\]/).pop() || 'notepad';
    noteName.title = p;
  };
  const persistNotePath = (p: string): void => {
    const cp = getState().ui.cockpit;
    if (cp.tiles.find((t) => t.id === meta.id)?.notePath === p) return; // no-op
    setCockpit({ tiles: cp.tiles.map((t) => (t.id === meta.id ? { ...t, notePath: p } : t)) });
  };
  const ensureNotePath = async (): Promise<void> => {
    if (notePath || noteReqd) return;
    // Reopen the SAME draft on resume: a previously-resolved path is persisted in
    // the tile meta. Re-deriving from meta.id would break when a 'new' tile is
    // restored as 'resume:<sessionId>' (different id → fresh empty notepad).
    if (meta.notePath) { bindNotePath(meta.notePath); await noteLoad(); return; }
    noteReqd = true;
    try {
      const r = await postNotepad(meta.id, meta.projectPath, convKey);
      if (r.path) {
        bindNotePath(r.path);
        persistNotePath(r.path);
        await noteLoad();
      } else { noteStatus.textContent = '✗ ' + (r.error || 'no notepad'); noteReqd = false; }
    } catch { noteStatus.textContent = '✗ notepad failed'; noteReqd = false; }
  };
  const persistNoteOpen = (open: boolean) => {
    const cp = getState().ui.cockpit;
    if (cp.tiles.find((t) => t.id === meta.id)?.noteOpen === !!open) return; // no-op (don't churn the store)
    setCockpit({ tiles: cp.tiles.map((t) => (t.id === meta.id ? { ...t, noteOpen: open } : t)) });
  };
  const toggleNote = (force?: boolean): void => {
    noteOpen = force ?? !noteOpen;
    noteBar.style.display = noteOpen ? '' : 'none';
    el.querySelector('[data-act="tile-note"]')?.classList.toggle('on', noteOpen);
    persistNoteOpen(noteOpen);
    setTimeout(doFit, 60); // term shrank/grew — refit xterm
    if (noteOpen) {
      ensureNotePath();
      if (noteMode === 'edit') noteEdit.focus();
      if (!notePoll) notePoll = setInterval(noteLoad, 2500); // pick up the agent's edits
    } else if (notePoll) { clearInterval(notePoll); notePoll = null; }
  };
  // Dock a SPECIFIC file as this conversation's notepad and open it — used when the
  // agent's open_scratchpad routes its draft here (one notepad system) instead of
  // spawning a separate scratchpad tile. Adopts the path so user + agent share it.
  const openNoteAt = (p: string): void => {
    if (p && !samePath(p, notePath)) {
      if (noteDirty && notePath) noteSave(); // flush pending edits to the OLD file before switching
      bindNotePath(p); persistNotePath(p);
      noteContent = ''; noteMtime = 0; noteDirty = false; noteEdit.value = ''; // force a fresh load from the new file
    }
    if (!noteOpen) toggleNote(true); else noteLoad();
  };

  // ── context-window meter ──────────────────────────────────
  // Updated every poll from getState().data.sessions (see syncCockpit). Hidden
  // until the session reports a context size (no assistant turn yet → nothing to show).
  const ctxPct = el.querySelector('.tile-ctx-pct') as HTMLElement;
  const ctxLine = el.querySelector('.tile-ctxline') as HTMLElement;
  const setContext = (size: number, model: string | null, window?: number): void => {
    if (!size || size <= 0) { ctxPct.style.display = 'none'; ctxLine.style.display = 'none'; return; }
    // Prefer the server's window (it infers the real 1M beta from observed peak);
    // fall back to the model-name heuristic only when the server didn't send one.
    const win = window && window > 0 ? window : contextWindowFor(model);
    const pct = Math.min(100, Math.round((size / win) * 100));
    const level = pct >= 85 ? 'crit' : pct >= 65 ? 'warn' : 'ok';
    const title = `Context: ${fmtTok(size)} / ${fmtTok(win)} (${pct}%)`
      + (pct >= 85 ? ' — getting full, consider /compact' : '');
    // % chip lives next to the title; the fill is a subtle bar under the header.
    ctxPct.style.display = '';
    ctxPct.textContent = pct + '%';
    ctxPct.dataset.level = level;
    ctxPct.title = title;
    ctxLine.style.display = '';
    ctxLine.style.width = pct + '%';
    ctxLine.dataset.level = level;
    ctxLine.title = title;
  };

  if (meta.noteOpen) toggleNote(true); // restore the docked notepad on resume

  // Clicking into a tile means you're attending to it → drop any "waiting" pulse.
  el.addEventListener('mousedown', () => clearAttn(meta.id));

  return {
    el, kind: meta.kind === 'new' ? 'new' : 'resume', fit: doFit,
    toggleCompose, toggleNote, openNoteAt, setContext,
    setReadSession: (sid: string | null) => {
      const b = el.querySelector('[data-act="tile-readout"]') as HTMLElement | null;
      if (!b) return;
      if (sid) { b.dataset.session = sid; b.style.display = ''; }
      else b.style.display = 'none';
    },
    focus: () => { try { term.focus(); } catch { /* ignore */ } },
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
      if (idleAttnTimer) clearTimeout(idleAttnTimer);
      if (armTimer) clearTimeout(armTimer);
      if (notePoll) clearInterval(notePoll);
      if (noteSaveTimer) clearTimeout(noteSaveTimer);
      document.removeEventListener('visibilitychange', onWake);
      document.removeEventListener('mousedown', onDocMouseForNote);
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
  clearAttn(id); // a closed conversation can't be "waiting"
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
    const maxed = cp.maximized === meta.id;
    t.el.classList.toggle('maxed', maxed);
    // Swap the maximize button to a "restore" affordance while this tile is full-bleed.
    const mb = t.el.querySelector('[data-act="tile-max"]') as HTMLElement | null;
    if (mb && mb.dataset.maxed !== String(maxed)) {
      mb.dataset.maxed = String(maxed);
      mb.innerHTML = maxed ? '&#10697;' : '&#8689;'; // ⧉ restore / ⤡ maximize
      mb.title = maxed ? 'Restore' : 'Maximize';
    }
    // Focus chips: mute a project's tiles without tearing down their PTYs.
    t.el.classList.toggle('hidden-proj', hidden.has(meta.projectPath));
    // Reflect "needs input" so the pulse survives re-render/reorder.
    t.el.classList.toggle('attn', (cp.attnTiles ?? []).includes(meta.id));
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

  // Per-tile context-window meters: resolve each tile's sessionId (resume tiles
  // know it; 'new' tiles get a discoveredSessionId once claude creates one) and
  // push the latest context size from the polled session list.
  const sessions = st.data?.sessions;
  if (sessions && sessions.length) {
    const byId = new Map(sessions.filter((s) => s.id).map((s) => [s.id!, s]));
    const discovered = st.data?.terminalSessions ?? {};
    for (const meta of cp.tiles) {
      const t = tiles.get(meta.id);
      if (!t?.setContext) continue;
      const sid = meta.kind === 'new' ? discovered[meta.id] : meta.sessionId;
      const s = sid ? byId.get(sid) : undefined;
      t.setContext(s?.contextSize ?? 0, s?.model ?? null, s?.contextWindow);
      t.setReadSession?.(sid ?? null); // reveal/bind the read-aloud button once the id is known
    }
  }

  if (show || domChanged) { setTimeout(refitAll, 70); setTimeout(refitAll, 280); }
}

function refitAll(): void { for (const t of tiles.values()) t.fit?.(); }

export function restartTile(id: string): void { tiles.get(id)?.restart?.(); }
export function toggleTileCompose(id: string): void { tiles.get(id)?.toggleCompose?.(); }
export function toggleTileNote(id: string): void { tiles.get(id)?.toggleNote?.(); }
/**
 * Route an agent-opened scratchpad into a conversation's docked notepad (the single
 * notepad system) rather than a standalone scratchpad tile. Targets the tile the
 * operator is most likely looking at: the maximized one, else the focused one, else
 * the first terminal tile. Returns false if there's no terminal tile to dock onto —
 * the caller then falls back to a standalone doc tile so the draft is never lost.
 */
/** The terminal tile the operator is most likely looking at: maximized → focused →
 *  first terminal tile. Null if there are no terminal tiles. */
function pickActiveTermTileId(): string | null {
  const cp = getState().ui.cockpit;
  const termTiles = cp.tiles.filter((t) => t.kind !== 'doc');
  if (!termTiles.length) return null;
  const focusedId = termTiles.find((t) => tiles.get(t.id)?.el.contains(document.activeElement))?.id;
  return (cp.maximized && termTiles.some((t) => t.id === cp.maximized) ? cp.maximized : null)
    ?? focusedId ?? termTiles[0].id;
}
/** Project + conversation key of the active terminal tile (for scoping the notes list). */
export function activeTileInfo(): { project: string; conversation: string } | null {
  const id = pickActiveTermTileId();
  if (!id) return null;
  const m = getState().ui.cockpit.tiles.find((t) => t.id === id);
  return m ? { project: m.projectPath, conversation: m.sessionId || m.id } : null;
}
/** Dock an EXISTING note into the active conversation's notepad WITHOUT reassigning
 *  its home conversation (used by the notes library). Returns false if no term tile. */
export function dockNoteInActiveTile(path: string): boolean {
  const id = pickActiveTermTileId();
  if (!id) return false;
  const t = tiles.get(id);
  if (!t?.openNoteAt) return false;
  t.openNoteAt(path);
  return true;
}
export function openAgentScratchpad(path: string): boolean {
  const targetId = pickActiveTermTileId();
  if (!targetId) return false;
  const t = tiles.get(targetId);
  if (!t?.openNoteAt) return false;
  t.openNoteAt(path);
  // Associate the adopted draft with this conversation/project so it surfaces later.
  const tm = getState().ui.cockpit.tiles.find((x) => x.id === targetId);
  if (tm) postRecordNote(path, tm.projectPath, tm.sessionId || tm.id);
  return true;
}
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
