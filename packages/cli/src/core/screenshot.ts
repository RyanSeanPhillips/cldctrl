/**
 * Screen capture → PNG on disk, so the path can be fed into a Claude Code /
 * Codex conversation (the reliable cross-platform way to share an image, since
 * Windows clipboard-paste into Claude Code is broken). Windows-only for now via
 * screenshot.ps1 (region snip with a full-screen fallback).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getConfigDir } from '../config.js';
import { getPlatform } from './platform.js';
import { log } from './logger.js';

export type ShotMode = 'region' | 'full';

/** Locate screenshot.ps1 in the built output (mirrors getProbeScriptPath). */
function getScreenshotScript(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url)); // decodes %20 etc. — safe for paths with spaces
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'screenshot.ps1');
    if (fs.existsSync(cand)) return cand;
    dir = path.dirname(dir);
  }
  return null;
}

/** Capture a screenshot to a PNG and return its path, or null on failure/cancel. */
export async function captureScreenshot(mode: ShotMode = 'region'): Promise<string | null> {
  if (getPlatform() !== 'windows') return null; // macOS/Linux capture TBD
  const script = getScreenshotScript();
  if (!script) { log('error', { function: 'captureScreenshot', message: 'screenshot.ps1 not found' }); return null; }

  const dir = path.join(getConfigDir(), 'screenshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const out = path.join(dir, 'shot-' + Date.now() + '.png');

  return new Promise((resolve) => {
    let buf = '';
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutPath', out, '-Mode', mode],
      { windowsHide: true },
    );
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.on('error', (err) => { log('error', { function: 'captureScreenshot', message: String(err) }); resolve(null); });
    proc.on('exit', () => {
      if (buf.includes('OK') && fs.existsSync(out)) { resolve(out); }
      else { log('serve_shot', { result: buf.trim().slice(0, 100) }); resolve(null); }
    });
  });
}
