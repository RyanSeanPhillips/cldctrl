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
import { VERSION } from '../constants.js';

/** GET a localhost JSON endpoint, resolving the parsed object (or null on any
 *  non-200 / non-JSON / parse error / connection failure). Never rejects. */
function getJson(port: number, path: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      const ct = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || !ct.includes('application/json')) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { if (body.length < 1_000_000) body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Does a JSON blob have the distinctive shape of an /api/overview payload? Used
 *  to recognize a LEGACY server (built before the `product` marker existed) —
 *  the version the user is most likely running right now. Requires several
 *  co-occurring cldctrl-specific fields so a random 200-JSON service on the port
 *  can't be mistaken for ours. */
function looksLikeOverview(j: Record<string, unknown> | null): boolean {
  if (!j || typeof j !== 'object') return false;
  const feat = j.features as Record<string, unknown> | undefined;
  return typeof j.version === 'string'
    && typeof j.generatedAt === 'string'
    && !!feat && typeof feat === 'object' && 'agentTerminal' in feat
    && !!j.usage && typeof j.usage === 'object';
}

/**
 * Probe the localhost port for a cldctrl dashboard. `ok` is true ONLY when the
 * response POSITIVELY identifies as ours — either the `product: "cldctrl"`
 * marker (STRONG, `identified: 'marker'`) or the distinctive overview shape of a
 * pre-marker build (LEGACY, `identified: 'legacy'`). A foreign service on this
 * port (404/401, an HTML app, or unrelated 200-JSON) yields `ok: false`, because
 * callers escalate a positive probe to a destructive stop/kill.
 *
 * Fast path is /api/id (instant, no rate-limit/git work — /api/overview can
 * exceed the timeout when cold). Falls back to /api/overview so already-running
 * OLD servers (no /api/id route) are still recognized. Captures version +
 * instanceId for stale-build detection and old-vs-successor discrimination.
 */
export async function probeServerInfo(
  port: number,
  timeoutMs = 1500,
): Promise<{ ok: boolean; version?: string; instanceId?: string; identified?: 'marker' | 'legacy' }> {
  // 1. Strong identity via the lightweight id endpoint (new builds).
  const id = await getJson(port, '/api/id', timeoutMs);
  if (id && id.product === 'cldctrl') {
    return {
      ok: true,
      identified: 'marker',
      version: typeof id.version === 'string' ? id.version : undefined,
      instanceId: typeof id.instanceId === 'string' ? id.instanceId : undefined,
    };
  }
  // 2. Fall back to /api/overview: a new server still carries the marker there;
  //    an old server is recognized by its distinctive payload shape.
  const ov = await getJson(port, '/api/overview', Math.max(timeoutMs, 2500));
  if (ov && ov.product === 'cldctrl') {
    return {
      ok: true,
      identified: 'marker',
      version: typeof ov.version === 'string' ? ov.version : undefined,
      instanceId: typeof ov.instanceId === 'string' ? ov.instanceId : undefined,
    };
  }
  if (looksLikeOverview(ov)) {
    return { ok: true, identified: 'legacy', version: typeof ov!.version === 'string' ? ov!.version as string : undefined };
  }
  return { ok: false };
}

/** Is a cldctrl dashboard already serving on this localhost port? Lets a repeat
 *  app-mode launch just open a new window instead of failing on port-in-use. */
export async function probeServer(port: number, timeoutMs = 900): Promise<boolean> {
  return (await probeServerInfo(port, timeoutMs)).ok;
}

/** One-line hint when the running server was built from older code than the
 *  local install — the reason "my updates aren't showing up" happens. */
export function staleServerNote(runningVersion: string | undefined): string | null {
  if (!runningVersion || runningVersion === VERSION) return null;
  return `Note: the running dashboard is v${runningVersion} but v${VERSION} is installed — run \`cc stop\` then \`cc\` to load the update.`;
}

/** POST /api/shutdown to a running dashboard server. Falls back to killing the
 *  process that owns the port (older servers predate the endpoint). Only called
 *  after a positive probe, so we never kill a foreign service. */
function requestShutdown(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST',
      headers: { 'X-CLDCTRL': '1', 'Content-Length': 0 }, timeout: timeoutMs,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Kill whatever PID is LISTENING on the port. Windows: netstat + taskkill /T
 *  (kills the PTY children too, so agent processes don't orphan). Unix: lsof. */
function killPortOwner(port: number): boolean {
  try {
    if (getPlatform() === 'windows') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split(/\r?\n/).find((l) => l.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(l));
      const pid = line?.trim().split(/\s+/).pop();
      if (!pid || !/^\d+$/.test(pid) || pid === '0') return false;
      execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      return true;
    }
    const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\s+/).filter((p) => /^\d+$/.test(p));
    if (!pids.length) return false;
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ } }
    return true;
  } catch {
    return false;
  }
}

/** Stop the dashboard server on `port`. Returns what happened so the CLI can
 *  report it. Verifies the port actually went quiet before claiming success. */
export async function stopServer(port: number): Promise<'not-running' | 'stopped' | 'failed'> {
  const info = await probeServerInfo(port);
  if (!info.ok) return 'not-running';
  let sent = await requestShutdown(port);
  // Older builds don't have /api/shutdown — kill the port's owner directly.
  if (!sent) sent = killPortOwner(port);
  if (!sent) return 'failed';
  // Wait for the port to actually go quiet (shutdown has a short grace timer).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await probeServerInfo(port, 400)).ok) return 'stopped';
  }
  return 'failed';
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
  if (getPlatform() === 'linux') args.push('--class=cldctrl');
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

/** Resolve the CLI entry (dist/index.js) from THIS module's location so a
 *  detached respawn works regardless of how we were launched (bin shim, node,
 *  npx). Falls back to argv[1]. */
function resolveEntry(): string {
  try {
    const here = fileURLToPath(new URL('./index.js', import.meta.url));
    if (fs.existsSync(here)) return here;
  } catch { /* fall through */ }
  return process.argv[1];
}

/** Spawn a detached background `cc serve --idle-exit` that outlives this CLI.
 *  `app` adds --app (chromeless window); used by both first-launch and restart. */
function spawnDetachedServer(port: number, opts: { app?: boolean; browser?: 'chrome' | 'edge' } = {}): boolean {
  const childArgs = [resolveEntry(), 'serve', '--idle-exit', '--port', String(port)];
  if (opts.app) childArgs.push('--app');
  if (opts.browser) childArgs.push('--browser', opts.browser);
  try {
    spawn(process.execPath, childArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export type RestartResult =
  | { status: 'restarted'; version?: string }
  | { status: 'started'; version?: string }   // nothing was running — just brought one up
  | { status: 'stop-failed' }
  | { status: 'start-timeout' };

/**
 * Supervised restart: stop the running server, wait for the port to go quiet,
 * spawn a fresh one, then poll /api/id until a DIFFERENT instanceId answers —
 * true readiness, not merely an open TCP port. The CLI process itself is the
 * supervisor (it outlives the stop→start gap), so a failed respawn is reported
 * here rather than leaving a dead window and no server. Loads the latest build.
 */
export async function restartServer(port: number, opts: { browser?: 'chrome' | 'edge' } = {}): Promise<RestartResult> {
  const before = await probeServerInfo(port);
  const wasRunning = before.ok;
  const oldInstanceId = before.instanceId; // may be undefined for a legacy server

  if (wasRunning) {
    const stopped = await stopServer(port);
    // 'not-running' = it died between our probe and the stop — fine, proceed.
    if (stopped === 'failed') return { status: 'stop-failed' };
  }

  const headless = isHeadless();
  const browser = findChromiumBrowser(opts.browser);
  const app = !headless && !!browser;

  if (!spawnDetachedServer(port, { app, browser: opts.browser })) {
    // Couldn't spawn detached — last resort, serve in the foreground (blocks).
    const { startServeServer } = await import('../serve.js');
    startServeServer(port, { open: !headless });
    return { status: wasRunning ? 'restarted' : 'started' };
  }

  // Poll for readiness: a marker server whose instanceId differs from the one we
  // just stopped. The server we spawn is always a marker build, so it always
  // reports an instanceId — no legacy-successor ambiguity. ~20s budget.
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const info = await probeServerInfo(port, 500);
    if (info.ok && info.instanceId && info.instanceId !== oldInstanceId) {
      return { status: wasRunning ? 'restarted' : 'started', version: info.version };
    }
  }
  return { status: 'start-timeout' };
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

  const running = await probeServerInfo(port);
  if (running.ok) {
    if (!headless && browser && launchAppWindow(url, { browser: opts.browser })) {
      console.log(`Opened CLD CTRL (already running at ${url}).`);
    } else {
      console.log(`CLD CTRL is running at ${url}`);
    }
    const stale = staleServerNote(running.version);
    if (stale) console.log(stale);
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
  // window (--idle-exit drains it ~15 min after the last window/PTY is gone),
  // then return so this CLI exits and frees the terminal.
  if (spawnDetachedServer(port, { app: true, browser: opts.browser })) {
    console.log(`Opening CLD CTRL…  (running at ${url} — run \`cc --tui\` for the terminal UI)`);
  } else {
    // Last resort: serve in the foreground.
    const { startServeServer } = await import('../serve.js');
    startServeServer(port, { open: true });
  }
}
