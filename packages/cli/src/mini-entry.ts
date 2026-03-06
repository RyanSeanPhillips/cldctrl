/**
 * Dedicated --mini entry point. Bypasses Commander/CLI overhead entirely.
 * Used by hotkey.ps1 for fastest possible startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const t0 = performance.now();
const timings: string[] = [];
function mark(label: string) {
  timings.push(`${(performance.now() - t0).toFixed(0).padStart(5)}ms  ${label}`);
}

mark('node started');

// Set process title for easy identification in task manager / process lists
process.title = 'cldctrl-mini';

// Set console title for window identification (hotkey.ps1 uses this to find us)
const popupId = process.env.CLDCTRL_POPUP_ID;
if (popupId) {
  process.stdout.write(`\x1b]0;${popupId}\x07`);
}

// Resize console to mini TUI dimensions
process.stdout.write('\x1b[8;20;48t');

// Disable QuickEdit mode (prevents text selection on click, enables drag)
try {
  const qeExe = path.join(
    process.env.APPDATA || '',
    'cldctrl',
    'qe-off.exe',
  );
  if (fs.existsSync(qeExe)) {
    execFileSync(qeExe, { stdio: 'ignore', timeout: 1000 });
  }
} catch {}
mark('qe-off done');

mark('importing MiniApp...');
const { renderMiniApp } = await import('./tui/MiniApp.js');
mark('MiniApp imported');

// Write timing log for diagnostics
const logPath = path.join(os.tmpdir(), 'cldctrl-perf.log');
const writeTimings = () => {
  try { fs.writeFileSync(logPath, timings.join('\n') + '\n'); } catch {}
};

// Pass mark function to renderMiniApp so it can add its own timings
(globalThis as any).__cldctrl_mark = mark;
(globalThis as any).__cldctrl_writeTimings = writeTimings;

await renderMiniApp();
