/**
 * Differential screen renderer: intercepts Ink's full-repaint writes
 * and only updates terminal lines that actually changed.
 *
 * Ink redraws the entire screen on every React render, which causes
 * visible flicker — especially at the bottom of the screen where the
 * terminal is still painting when the next frame arrives.
 *
 * This layer:
 * 1. Buffers all stdout writes within a single event-loop tick
 * 2. Strips Ink's cursor-home / clear-screen sequences
 * 3. Compares each line with the previous frame
 * 4. Only writes changed lines using direct cursor positioning
 *
 * Result: unchanged lines are never touched, eliminating flicker.
 */

export function enableDiffRendering(): () => void {
  const stdout = process.stdout;
  const originalWrite = stdout.write;

  let prevLines: string[] = [];
  let buffer = '';
  let flushPending = false;
  let active = false; // only diff inside alternate screen buffer

  function realWrite(data: string): boolean {
    return originalWrite.call(stdout, data);
  }

  function flush() {
    flushPending = false;

    if (!active || !buffer) {
      if (buffer) realWrite(buffer);
      buffer = '';
      return;
    }

    let frame = buffer;
    buffer = '';

    // Strip Ink's framing sequences — we handle positioning ourselves
    // Matches: cursor home (\x1b[H, \x1b[1;1H), clear to end (\x1b[J, \x1b[0J),
    // cursor visibility (\x1b[?25l, \x1b[?25h), and any other cursor positioning
    frame = frame.replace(/\x1b\[\?25[lh]/g, '');
    frame = frame.replace(/\x1b\[[\d;]*H/g, '');
    frame = frame.replace(/\x1b\[[012]?J/g, '');

    const lines = frame.split('\n');
    const out: string[] = ['\x1b[?25l']; // keep cursor hidden
    let changes = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== prevLines[i]) {
        // Move to row i+1 col 1, clear line, write new content
        out.push(`\x1b[${i + 1};1H\x1b[2K${lines[i]}`);
        changes++;
      }
    }

    // Clear leftover lines if previous frame was taller
    for (let i = lines.length; i < prevLines.length; i++) {
      out.push(`\x1b[${i + 1};1H\x1b[2K`);
      changes++;
    }

    prevLines = lines;

    if (changes > 0) {
      realWrite(out.join(''));
    }
  }

  // Invalidate cache on resize (terminal dimensions changed, full redraw needed)
  const onResize = () => { prevLines = []; };
  stdout.on('resize', onResize);

  (stdout as any).write = function (chunk: any, ...args: any[]): boolean {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const cb = args.find((a: any) => typeof a === 'function');

    // Alternate screen toggle — pass through immediately
    if (str.includes('\x1b[?1049h')) {
      active = true;
      prevLines = [];
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

    // Inside alternate screen — buffer for diffing
    buffer += str;
    if (!flushPending) {
      flushPending = true;
      setImmediate(flush);
    }
    if (cb) cb();
    return true;
  };

  return () => {
    stdout.off('resize', onResize);
    (stdout as any).write = originalWrite;
  };
}
