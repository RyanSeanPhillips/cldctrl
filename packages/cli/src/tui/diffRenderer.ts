/**
 * Flicker-free renderer: intercepts Ink's stdout.write() calls,
 * keeps only the LATEST write per event-loop tick, strips non-SGR
 * control sequences, and redraws ALL lines with explicit cursor
 * positioning.
 *
 * Key anti-flicker techniques:
 * - Content is written BEFORE erase (overwrite-then-erase-tail),
 *   never erase-then-write. This eliminates the visible "blank line"
 *   flash that occurs when \x1b[2K erases a line before content
 *   replaces it.
 * - stderr is intercepted during alt screen to prevent any bypassing
 *   writes from corrupting the display.
 * - DEC 2026 synchronized update markers for atomic frame display.
 */

// Strip non-SGR ANSI escape sequences (cursor, clear, erase).
// SGR codes (\x1b[...m) are preserved for colors/styles.
const STRIP_PATTERNS = [
  /\x1b\[[\d;]*[Hf]/g,    // cursor positioning (CUP/HVP)
  /\x1b\[\d*J/g,           // clear screen / scrollback
  /\x1b\[\d*K/g,           // erase in line (all variants: 0K, 1K, 2K, K)
  /\x1b\[\d*[ABCD]/g,      // cursor up/down/forward/backward
  /\x1b\[\d*G/g,           // cursor to column
  /\x1b\[\?25[lh]/g,       // cursor show/hide
  /\x1b\[\?\d+[hl]/g,      // private mode set/reset (DEC modes)
];

function stripControlSequences(str: string): string {
  let result = str;
  for (const pattern of STRIP_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

export function enableDiffRendering(): () => void {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const originalWrite = stdout.write;
  const originalStderrWrite = stderr.write;

  let active = false;
  let latestWrite = '';       // Only the LAST write is kept
  let flushScheduled = false;
  let pendingCallbacks: (() => void)[] = [];

  function realWrite(data: string): boolean {
    return originalWrite.call(stdout, data);
  }

  function firePendingCallbacks(): void {
    const cbs = pendingCallbacks;
    pendingCallbacks = [];
    for (const fn of cbs) fn();
  }

  function flush(): void {
    flushScheduled = false;
    if (!latestWrite) {
      firePendingCallbacks();
      return;
    }

    const raw = latestWrite;
    latestWrite = '';

    if (!active) {
      realWrite(raw);
      firePendingCallbacks();
      return;
    }

    // Strip all non-SGR control sequences to get pure content
    const stripped = stripControlSequences(raw);

    const allLines = stripped.split('\n');
    // Remove trailing empty string from log-update's appended \n
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const maxRows = stdout.rows || 24;
    const lines = allLines.slice(0, maxRows);

    // Skip trivial writes (only control sequences, no real content)
    const hasContent = lines.some(line => line.length > 0);
    if (!hasContent) {
      firePendingCallbacks();
      return;
    }

    // Write ALL lines with explicit positioning every frame.
    // Each line: position → reset SGR → write content → reset SGR → erase tail.
    // Content is written BEFORE erase (overwrite-then-erase-tail pattern).
    // This avoids the visible "blank line" flash that \x1b[2K causes when
    // the terminal renders the erase before the content that follows.
    const out: string[] = [
      '\x1b[?2026h', // begin synchronized update (atomic display)
      '\x1b[?25l',   // hide cursor
    ];

    for (let i = 0; i < lines.length; i++) {
      // Position → reset → content → reset → erase tail
      out.push(`\x1b[${i + 1};1H\x1b[0m${lines[i]}\x1b[0m\x1b[K`);
    }

    // Clear any remaining rows below the content
    for (let i = lines.length; i < maxRows; i++) {
      out.push(`\x1b[${i + 1};1H\x1b[0m\x1b[K`);
    }

    out.push('\x1b[?2026l'); // end synchronized update
    realWrite(out.join(''));

    firePendingCallbacks();
  }

  function scheduleFlush(): void {
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flush);
    }
  }

  // ── stdout interceptor ────────────────────────────────────
  (stdout as any).write = function (chunk: any, ...args: any[]): boolean {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const cb = args.find((a: any) => typeof a === 'function');

    // Alternate screen toggle — pass through immediately
    if (str.includes('\x1b[?1049h')) {
      active = true;
      realWrite(str);
      if (cb) cb();
      return true;
    }
    if (str.includes('\x1b[?1049l')) {
      active = false;
      realWrite(str);
      if (cb) cb();
      return true;
    }

    // Outside alternate screen — pass through unchanged
    if (!active) {
      return originalWrite.call(stdout, chunk, ...args);
    }

    // Inside alternate screen — REPLACE with latest write.
    latestWrite = str;
    if (cb) pendingCallbacks.push(cb);
    scheduleFlush();
    return true;
  };

  // ── stderr interceptor ────────────────────────────────────
  // Suppress stderr during alt screen to prevent stray error messages,
  // unhandled rejection warnings, or debug output from corrupting the
  // alternate screen buffer. Silently drop (stderr is not critical for
  // TUI rendering; errors are logged to debug.log via the file logger).
  (stderr as any).write = function (chunk: any, ...args: any[]): boolean {
    if (active) {
      // Swallow stderr while alt screen is active
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb();
      return true;
    }
    return originalStderrWrite.call(stderr, chunk, ...args);
  };

  return () => {
    active = false;
    (stdout as any).write = originalWrite;
    (stderr as any).write = originalStderrWrite;
  };
}
