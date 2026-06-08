/**
 * Single-instance guard for the full TUI.
 *
 * Goal: at most one CLD CTRL instance per Windows virtual desktop, while
 * allowing a fresh instance on a different desktop. On non-Windows platforms
 * we keep the historical behavior: one instance globally.
 *
 * Strategy:
 *  - `instances.json` tracks the PIDs of running TUIs (replaces the old single
 *    `tui.pid`). Dead PIDs are pruned on read.
 *  - If no live instance exists anywhere → launch immediately (fast path, no
 *    subprocess), preserving the <500ms startup budget for the common case.
 *  - If a live instance exists:
 *      • Windows: ask `desktop-probe.ps1` whether another CLD CTRL window is on
 *        the *current* virtual desktop. Only then do we block. Probe failure /
 *        timeout fails OPEN (we launch) so a probe bug never traps the user.
 *      • Other platforms: block (single instance globally).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfigDir } from '../config.js';
import { getPlatform } from './platform.js';

interface InstanceEntry {
  pid: number;
}

function instancesPath(): string {
  return path.join(getConfigDir(), 'instances.json');
}

/** True if the process is alive (signal 0 = liveness check, no signal sent). */
function isAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = exists but not ours → still alive. ESRCH = gone.
    return e?.code === 'EPERM';
  }
}

function readInstances(): InstanceEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(instancesPath(), 'utf-8'));
    if (Array.isArray(raw)) {
      return raw.filter((e): e is InstanceEntry => typeof e?.pid === 'number');
    }
  } catch { /* missing or corrupt — treat as empty */ }
  return [];
}

function writeInstances(entries: InstanceEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(instancesPath()), { recursive: true });
    fs.writeFileSync(instancesPath(), JSON.stringify(entries));
  } catch { /* best effort */ }
}

/** Locate desktop-probe.ps1 from the built output (mirrors getHotkeyScriptPath). */
function getProbeScriptPath(): string | null {
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'desktop-probe.ps1');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Windows-only: is another CLD CTRL window already on the current virtual
 * desktop? Fails OPEN (returns false) on any error/timeout.
 */
function blockedByCurrentDesktop(): boolean {
  const script = getProbeScriptPath();
  if (!script) return false;
  try {
    const out = execFileSync('powershell', [
      '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script,
    ], { timeout: 2000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes('BLOCKED');
  } catch {
    return false; // fail open
  }
}

export interface GuardDecision {
  /** True → caller should proceed to launch the TUI. */
  ok: boolean;
  /** User-facing message when ok === false. */
  message?: string;
}

/**
 * Decide whether this process may launch a TUI. When it may, the caller's PID
 * is recorded and an exit hook is registered to remove it.
 */
export function acquireInstanceLock(): GuardDecision {
  const live = readInstances().filter(e => isAlive(e.pid));

  if (live.length > 0) {
    const onWindows = getPlatform() === 'windows';
    const blocked = onWindows ? blockedByCurrentDesktop() : true;
    if (blocked) {
      return {
        ok: false,
        message: onWindows
          ? 'CLD CTRL is already running on this desktop. Press Ctrl+Up to focus it, or switch to another desktop to open a new one.'
          : 'CLD CTRL is already running. Press Ctrl+Up to focus it, or close the other instance first.',
      };
    }
  }

  // Cleared to launch — record our PID and arrange cleanup.
  const entries = [...live, { pid: process.pid }];
  writeInstances(entries);

  const cleanup = () => {
    try {
      const remaining = readInstances().filter(e => e.pid !== process.pid);
      writeInstances(remaining);
    } catch { /* ignore */ }
  };
  process.on('exit', cleanup);

  return { ok: true };
}
