/**
 * App-mode launch: open the dashboard as a chromeless standalone window via a
 * Chromium browser's `--app=` flag (Edge preferred, then Chrome). This is an
 * OPTION alongside the normal browser tab (`cc web` / `--open`), not a
 * replacement — see cli.ts `web --app`. Kept in its own module (imports config)
 * so it never loads on the zero-zod TUI startup path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { getConfigDir } from '../config.js';
import { getPlatform } from './platform.js';

/** Is a cldctrl dashboard already serving on this localhost port? Lets a repeat
 *  app-mode launch just open a new window instead of failing on port-in-use. */
export function probeServer(port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/overview', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Locate a Chromium-based browser that supports `--app=`. Edge first (present
 *  on most Windows machines), then Chrome. Returns an absolute path/command, or
 *  null if none found. */
export function findChromiumBrowser(): string | null {
  const plat = getPlatform();
  if (plat === 'windows') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const known = [
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of known) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
    // Registry App Paths fallback (handles non-standard install locations).
    for (const exe of ['msedge.exe', 'chrome.exe']) {
      for (const root of ['HKCU', 'HKLM']) {
        try {
          const out = execFileSync('reg', ['query',
            `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
          const m = out.match(/REG_SZ\s+(.+?\.exe)/i);
          const p = m?.[1]?.trim();
          if (p && fs.existsSync(p)) return p;
        } catch { /* not registered */ }
      }
    }
    return null;
  }
  if (plat === 'macos') {
    const known = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const c of known) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
    return null;
  }
  // Linux: resolve by name on PATH.
  for (const c of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { execFileSync('command', ['-v', c], { stdio: ['ignore', 'pipe', 'ignore'] }); return c; }
    catch { /* not on PATH */ }
  }
  return null;
}

/**
 * Launch `url` as a chromeless app-mode window. Returns true if a browser was
 * found and spawned (caller falls back to a normal browser tab on false).
 * Defaults to an ISOLATED profile (its own app window + taskbar grouping, no
 * hijacking of the user's main browser session); pass sharedProfile to reuse the
 * default profile (extensions/logins, but no separate window identity).
 */
export function launchAppWindow(url: string, opts: { sharedProfile?: boolean } = {}): boolean {
  const browser = findChromiumBrowser();
  if (!browser) return false;
  // Tag the URL so the client can DETERMINISTICALLY know it's app mode (Chrome
  // --app= windows don't reliably report display-mode: standalone).
  const target = url + (url.includes('?') ? '&' : '?') + 'app=1';
  const args = [`--app=${target}`, '--new-window'];
  if (!opts.sharedProfile) {
    const dir = path.join(getConfigDir(), 'app-profile');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    args.push(`--user-data-dir=${dir}`);
  }
  try {
    spawn(browser, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
