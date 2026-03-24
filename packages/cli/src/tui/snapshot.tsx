/**
 * Snapshot renderer: renders the REAL App component and captures a frame.
 *
 * Two modes:
 * - Default: uses ink-testing-library (no ANSI colors, good for text comparison)
 * - SNAPSHOT_ANSI=1: patches stdout to capture Ink's colored ANSI output
 *   (needed for xterm.js website embed)
 *
 * Usage: cc --demo --snapshot                    # plain text
 *        SNAPSHOT_ANSI=1 cc --demo --snapshot    # with ANSI colors
 */

import React from 'react';
import { App } from './App.js';

/**
 * CLI entry point for snapshot mode.
 */
export async function runSnapshot(): Promise<void> {
  const width = parseInt(process.env.COLUMNS ?? '120', 10);
  const height = parseInt(process.env.LINES ?? '40', 10);
  const delay = parseInt(process.env.SNAPSHOT_DELAY ?? '200', 10);
  const wantAnsi = process.env.SNAPSHOT_ANSI === '1';

  process.stdout.columns = width;
  process.stdout.rows = height;

  if (!wantAnsi) {
    // Plain text mode (no colors) via ink-testing-library
    const { render: testRender } = await import('ink-testing-library');
    const instance = testRender(React.createElement(App));
    await new Promise(resolve => setTimeout(resolve, delay));
    const frame = instance.lastFrame() ?? '';
    instance.unmount();
    process.stdout.write(frame + '\n');
    return;
  }

  // ANSI mode: intercept stdout.write to capture Ink's colored frames
  const origWrite = process.stdout.write.bind(process.stdout);
  let lastFrame = '';

  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    // Ink writes each complete frame as a single write() call
    // Keep the last one (it's the most complete)
    if (str.length > 50) { // skip short writes (cursor moves, etc.)
      lastFrame = str;
    }
    return true; // suppress actual output
  }) as any;

  // Force TTY-like behavior so Ink/chalk output ANSI color codes
  (process.stdout as any).isTTY = true;
  (process.stderr as any).isTTY = true;
  process.env.FORCE_COLOR = '3'; // force 24-bit color (chalk/Ink check this)

  // Ink requires raw mode + ref/unref on stdin — fake them for non-TTY
  if (!(process.stdin as any).isTTY) {
    (process.stdin as any).isTTY = true;
    (process.stdin as any).setRawMode = () => process.stdin;
    if (!process.stdin.ref) (process.stdin as any).ref = () => {};
    if (!process.stdin.unref) (process.stdin as any).unref = () => {};
  }

  const { render } = await import('ink');
  const instance = render(React.createElement(App));

  await new Promise(resolve => setTimeout(resolve, delay));
  instance.unmount();

  // Restore stdout
  process.stdout.write = origWrite;

  if (!lastFrame) {
    process.stderr.write('No frame captured\n');
    process.exit(1);
  }

  // Only strip alt screen enter/exit — keep everything else for xterm.js
  const cleaned = lastFrame
    .replace(/\x1b\[\?1049[lh]/g, '')         // alt screen
    .replace(/\x1b\[\?25[lh]/g, '');          // hide/show cursor

  origWrite(cleaned);
}
