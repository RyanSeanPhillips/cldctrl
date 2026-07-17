/**
 * App-mode launch: open the dashboard as a chromeless standalone window via a
 * Chromium browser's `--app=` flag (Chrome preferred, then Edge). This is the
 * DEFAULT `cc` experience (`launchDashboardApp`), with a normal browser tab
 * (`cc web`/`--open`) and the classic TUI (`cc --tui`) as alternatives. Kept in
 * its own module (imports config) so it never loads on the zero-zod TUI path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { getConfigDir } from '../config.js';
import { getPlatform } from './platform.js';
import { ensureAppShortcutLinux } from './setup-linux.js';

/** Is a cldctrl dashboard already serving on this localhost port? Lets a repeat
 *  app-mode launch just open a new window instead of failing on port-in-use. */
export function probeServer(port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/overview', timeout: timeoutMs }, (res) => {
      res.resume();
      // Only treat a 200 JSON response as "CLD CTRL is here" — a foreign service
      // on this port (404/401/an HTML app) must NOT be mistaken for our server.
      const ct = String(res.headers['content-type'] || '');
      resolve(res.statusCode === 200 && ct.includes('application/json'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Locate a Chromium-based browser that supports `--app=`. Prefers CHROME by
 *  default — Chrome gives an --app window its own taskbar entry + the site
 *  favicon, whereas Edge tends to group it under Edge's identity. Pass
 *  prefer:'edge' to flip. Returns an absolute path/command, or null. */
export function findChromiumBrowser(prefer: 'chrome' | 'edge' = 'chrome'): string | null {
  const plat = getPlatform();
  if (plat === 'windows') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const chrome = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const edge = [
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    const known = prefer === 'edge' ? [...edge, ...chrome] : [...chrome, ...edge];
    for (const c of known) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
    // Registry App Paths fallback (handles non-standard install locations).
    const exes = prefer === 'edge' ? ['msedge.exe', 'chrome.exe'] : ['chrome.exe', 'msedge.exe'];
    for (const exe of exes) {
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
  const chrome = plat === 'macos'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['google-chrome', 'chromium', 'chromium-browser'];
  const edge = plat === 'macos'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['microsoft-edge'];
  const cands = prefer === 'edge' ? [...edge, ...chrome] : [...chrome, ...edge];
  for (const c of cands) {
    try {
      if (plat === 'macos') { if (fs.existsSync(c)) return c; }
      // `command` is a shell builtin, not an executable — run it via sh. The
      // candidates are a fixed allowlist (no injection risk).
      else { execFileSync('sh', ['-c', `command -v ${c}`], { stdio: ['ignore', 'pipe', 'ignore'] }); return c; }
    } catch { /* not present */ }
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
export function launchAppWindow(url: string, opts: { sharedProfile?: boolean; browser?: 'chrome' | 'edge' } = {}): boolean {
  const browser = findChromiumBrowser(opts.browser);
  if (!browser) return false;
  // Tag the URL so the client can DETERMINISTICALLY know it's app mode (Chrome
  // --app= windows don't reliably report display-mode: standalone).
  const target = url + (url.includes('?') ? '&' : '?') + 'app=1';
  const args = [`--app=${target}`, '--new-window'];
  // X11/Wayland: set WM_CLASS/app_id so the window groups under our .desktop icon
  // (StartupWMClass=cldctrl) instead of a generic Chromium entry in the dock.
  // Ensure that .desktop + icon actually exist first (installed on-demand), else
  // there's nothing for the WM to match `--class=cldctrl` against → generic icon.
  if (getPlatform() === 'linux') {
    try { ensureAppShortcutLinux(); } catch { /* best-effort — never block launch */ }
    args.push('--class=cldctrl');
  }
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

/** True when there's no GUI to open a window into (SSH/CI, or headless Linux). */
function isHeadless(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.CI) return true;
  if (getPlatform() === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
}

/**
 * The default `cc` action: open the dashboard as an app-mode window, starting a
 * background server first if one isn't already running.
 *
 * - Server already up  → open another app window against it (fast path).
 * - Not up + GUI       → spawn a DETACHED background `cc serve --app` (which
 *                        serves AND opens the window), then let `cc` exit so the
 *                        terminal is freed.
 * - Headless / no      → serve in the foreground and print the URL (nothing to
 *   Chromium             open a window into; the process stays up like `cc serve`).
 */
export async function launchDashboardApp(opts: { port?: number; browser?: 'chrome' | 'edge' } = {}): Promise<void> {
  const port = opts.port ?? 2533;
  const url = `http://127.0.0.1:${port}`;
  const headless = isHeadless();
  const browser = findChromiumBrowser(opts.browser);

  if (await probeServer(port)) {
    if (!headless && browser && launchAppWindow(url, { browser: opts.browser })) {
      console.log(`Opened CLD CTRL (already running at ${url}).`);
    } else {
      console.log(`CLD CTRL is running at ${url}`);
    }
    return;
  }

  // No server yet and no window we can open → serve in the foreground + print URL.
  if (headless || !browser) {
    if (!browser && !headless) {
      console.log('No Chrome/Edge found for app mode — opening in your default browser instead.');
    }
    const { startServeServer } = await import('../serve.js');
    startServeServer(port, { open: !headless }); // keeps the process alive (foreground)
    return;
  }

  // GUI available: spawn a detached background server that serves + opens the app
  // window, then return so this CLI exits and frees the terminal. Resolve the CLI
  // entry from THIS module's location (dist/index.js sits next to the bundle) so
  // it works regardless of how the process was launched (bin shim, node, etc.).
  let entry = process.argv[1];
  try {
    const here = fileURLToPath(new URL('./index.js', import.meta.url));
    if (fs.existsSync(here)) entry = here;
  } catch { /* fall back to argv[1] */ }
  // --idle-exit: this background server drains itself ~15 min after the last
  // window closes and the last PTY dies, instead of running forever.
  const childArgs = [entry, 'serve', '--app', '--idle-exit', '--port', String(port)];
  if (opts.browser) childArgs.push('--browser', opts.browser);
  try {
    spawn(process.execPath, childArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log(`Opening CLD CTRL…  (running at ${url} — run \`cc --tui\` for the terminal UI)`);
  } catch {
    // Last resort: serve in the foreground.
    const { startServeServer } = await import('../serve.js');
    startServeServer(port, { open: true });
  }
}
