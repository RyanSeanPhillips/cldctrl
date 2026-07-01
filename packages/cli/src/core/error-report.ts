/**
 * Scrubbed, PII-free crash telemetry — one fire-and-forget ping per distinct
 * error to the same cld-ctrl.com analytics Worker the launch beacon uses.
 *
 * What we send: error NAME, a scrubbed one-line message, a stack SIGNATURE hash
 * (for grouping), a scrubbed short stack (basenames + line numbers only), the
 * app version, the surface (tui/browser/cli/daemon/mcp), and the OS + Node
 * version. Nothing else.
 *
 * What we NEVER send: absolute paths, home dir, usernames, project names,
 * prompts, tokens, env, or any file contents. Every string is run through
 * `scrub()` first. This is deliberately coarser than a normal error tracker —
 * it exists to answer "which crashes happen in the wild, on what version/OS,"
 * not to reconstruct a user's session.
 *
 * Default ON, disable-able (opt-out) via config `error_reporting.enabled`, the
 * `CLDCTRL_NO_TELEMETRY` env var, or the `DO_NOT_TRACK` standard. Throttled +
 * de-duplicated per process and always fail-silent — reporting a crash must
 * never itself crash or slow anything down.
 */

import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../constants.js';

export type ErrorSurface = 'tui' | 'browser' | 'cli' | 'daemon' | 'mcp';
const SURFACES = new Set<string>(['tui', 'browser', 'cli', 'daemon', 'mcp']);

// ── Enable/opt-out state ────────────────────────────────────

// Cached so error handling never blocks on disk. Read lazily from config on
// first report; the settings toggle updates it via setErrorReportingEnabled().
let enabledCache: boolean | null = null;

function envDisabled(): boolean {
  // Honor the DO_NOT_TRACK standard (https://consoledonottrack.com/) and our
  // own explicit kill switch.
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt && dnt !== '0' && dnt.toLowerCase() !== 'false') return true;
  if (process.env.CLDCTRL_NO_TELEMETRY) return true;
  return false;
}

/**
 * Set the opt-out flag from loaded config. Callers pass
 * `config.error_reporting?.enabled !== false` (default ON — only an explicit
 * `false` opts out). Also called when the settings toggle is saved so the
 * change takes effect immediately without a restart.
 */
export function setErrorReportingEnabled(enabled: boolean): void {
  enabledCache = enabled;
}

function isEnabled(): boolean {
  if (envDisabled()) return false;
  if (enabledCache !== null) return enabledCache;
  // Resolve the opt-out from disk once, lazily, WITHOUT importing config.ts
  // (which pulls in zod and would regress TUI startup). A cheap raw read.
  enabledCache = readOptOutFromDisk();
  return enabledCache;
}

/** Mirror config.ts's config-dir resolution, minus zod, for a cheap flag read. */
function configJsonPath(): string {
  const env = process.env.CLDCTRL_CONFIG_DIR ?? process.env.CLAUDEDOCK_CONFIG_DIR;
  if (env && !env.includes('..')) return path.join(path.resolve(env), 'config.json');
  const plat = os.platform();
  let dir: string;
  if (plat === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const legacy = path.join(appData, 'claudedock');
    dir = fs.existsSync(legacy) ? legacy : path.join(appData, 'cldctrl');
  } else if (plat === 'darwin') {
    const legacy = path.join(os.homedir(), '.config', 'claudedock');
    dir = fs.existsSync(legacy) ? legacy : path.join(os.homedir(), '.config', 'cldctrl');
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    const legacy = path.join(xdg, 'claudedock');
    dir = fs.existsSync(legacy) ? legacy : path.join(xdg, 'cldctrl');
  }
  return path.join(dir, 'config.json');
}

/**
 * Read error_reporting.enabled from config.json. Default ON only when there is
 * NO config yet (fresh install). If a config file EXISTS but can't be read or
 * parsed, fail CLOSED — never override a user's saved opt-out just because the
 * file was momentarily unreadable or malformed.
 */
function readOptOutFromDisk(): boolean {
  const p = configJsonPath();
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    // Absent config (never configured) → default ON. Any other read error
    // (perms, locked, etc.) → fail closed so a saved opt-out is honored.
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  try {
    return JSON.parse(text)?.error_reporting?.enabled !== false;
  } catch {
    return false; // present but malformed → fail closed
  }
}

// ── Scrubbing ───────────────────────────────────────────────

/**
 * Strip anything that could identify the user or their machine/projects from a
 * free-text string (error messages). Deliberately aggressive: when in doubt it
 * removes rather than keeps. Verified by tests/error-report.test.ts.
 */
export function __scrubForTest(input: string, keepBasename = true): string {
  return scrub(input, keepBasename);
}
/**
 * @param keepBasename  When true (stack frames), an absolute path collapses to
 *   its final segment — `.../foo.ts` → `foo.ts` — which for stack traces is our
 *   own SOURCE file and safe/useful. When false (free-text error messages), the
 *   whole path collapses to `<path>`, because a message's path usually points at
 *   a USER DATA file whose very name could be sensitive.
 */
function scrub(input: string, keepBasename = true): string {
  let s = String(input).slice(0, 4096); // hard cap before any regex work (ReDoS/CPU guard)
  // Normalize backslashes so every path rule only has to deal with '/'. This
  // also sidesteps regex backslash-escaping hazards.
  s = s.replace(/\\/g, '/');
  const home = safe(() => os.homedir()).replace(/\\/g, '/');
  const user = safe(() => os.userInfo().username);
  // ── High-confidence secret/PII redactions FIRST (before path collapsing can
  //    fragment them). These run in BOTH modes — a secret in a stack frame is
  //    just as bad as one in a message.
  s = s.replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '<jwt>'); // JWT
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>');                            // email
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, '<awskey>');                         // AWS key id
  s = s.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{6,}/gi, '<token>');
  s = s.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, '<auth>');        // auth header
  // key=value / key: value where the KEY looks sensitive → redact the value only
  s = s.replace(/\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth|access[_-]?key|client[_-]?secret|conn(?:ection)?[_-]?string)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, k, sep) => `${k}${sep}<redacted>`);
  s = s.replace(/\b[A-Fa-f0-9]{24,}\b/g, '<hex>');                                      // long hex (keys/hashes)
  // Home dir → ~
  if (home) s = replaceAllCI(s, home, '~');
  // User roots (C:/Users/<name>, /Users/<name>, /home/<name>) → ~
  s = s.replace(/[A-Za-z]:\/Users\/[^/\s"']+/gi, '~');
  s = s.replace(/\/(?:home|Users)\/[^/\s"']+/gi, '~');
  // Any remaining absolute path (optional drive, then one-or-more "/segment").
  s = s.replace(/(?:[A-Za-z]:)?(?:\/[^/\s"'()]+)+\/?/g, (m) => {
    if (!keepBasename) return '<path>';
    const seg = m.replace(/\/+$/, '').split('/');
    return seg[seg.length - 1] || '';
  });
  // A leftover "~<basename>" (home-anchored path) → also redact in message mode.
  if (!keepBasename) s = s.replace(/~[^\s"'()]+/g, '<path>');
  // Bare username token anywhere else.
  if (user && user.length > 2) s = replaceAllCI(s, user, '<user>');
  // ── Message-mode only: the highest-entropy leak surface. Aggressively redact
  //    hosts/IPs and ANY remaining quoted substring (paths/values/PII usually
  //    live in quotes). Stack frames don't get this (it'd nuke useful basenames).
  if (!keepBasename) {
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');                    // IPv4
    s = s.replace(/\b(?:[0-9a-fA-F]{0,4}:){3,}[0-9a-fA-F]{0,4}\b/g, '<ip>');  // IPv6-ish
    // host:port and dotted hostnames (2+ labels) → <host> (keep bare words).
    s = s.replace(/\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?\b/g, '<host>');
    s = s.replace(/'[^']*'/g, "'<redacted>'").replace(/"[^"]*"/g, '"<redacted>"');
  }
  return s;
}

function replaceAllCI(hay: string, needle: string, repl: string): string {
  if (!needle) return hay;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return hay.replace(new RegExp(esc, 'gi'), repl);
}

function safe(fn: () => string): string {
  try { return fn() || ''; } catch { return ''; }
}

/** cldctrl's own install dir (bundled dist) — frames under it are OUR source,
 *  so their basename is safe to keep. Everything else is treated as external. */
const APP_DIR = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/').toLowerCase(); }
  catch { return ''; }
})();

/**
 * Error.name is caller-controlled and, for a custom error CLASS, could be named
 * after a customer/project ("AcmePayrollError"). So we allowlist to known
 * built-in / common-runtime error names and collapse everything else to
 * 'Error'. Grouping doesn't suffer — the stack signature carries that.
 */
const KNOWN_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError', 'AssertionError',
  'SystemError', 'DOMException', 'AbortError',
]);
function safeErrorName(raw: unknown): string {
  const n = String(raw ?? 'Error');
  return KNOWN_ERROR_NAMES.has(n) ? n : 'Error';
}

/**
 * Classify a stack frame's raw file location:
 *  - `node:` internals  → kept verbatim (`node:fs`), trusted.
 *  - files strictly under APP_DIR → basename kept (our own source), trusted.
 *  - anything else (user scripts, plugins, eval, file://, UNC, http) → `<ext>`,
 *    UNtrusted (its basename could be a user data-file name).
 * The `trusted` flag also gates whether we keep the frame's function name, which
 * for an external frame could be a class named after a customer/project.
 */
function classifyLoc(rawFile: string, lineNo: string): { loc: string; trusted: boolean } {
  const p = rawFile.replace(/\\/g, '/');
  if (/^node:/.test(p)) return { loc: `${p}:${lineNo}`, trusted: true };
  const norm = p.replace(/^file:\/\/\/?/i, '').toLowerCase();
  // Exact-dir or true sub-path only — never a sibling like ".../dist-plugin/".
  if (APP_DIR && (norm === APP_DIR || norm.startsWith(APP_DIR + '/'))) {
    return { loc: `${basename(p)}:${lineNo}`, trusted: true };
  }
  return { loc: `<ext>:${lineNo}`, trusted: false };
}

/**
 * Reduce a stack to a stable, path-free signature + a short preview. Each frame
 * becomes `fn loc` where `loc` is a `node:`/own-source basename or `<ext>` (see
 * classifyLoc) and `fn` is sanitized to identifier chars — so no directory,
 * home path, username, or user data-file name can survive by construction.
 */
function distillStack(err: Error): { sig: string; preview: string } {
  const raw = (typeof err.stack === 'string' ? err.stack : `${safeErrorName(err.name)}: `)
    .slice(0, 32768); // cap before splitting (hostile-stack CPU guard)
  const frames = raw
    .split('\n', 200)
    .filter((l) => /^\s*at\s/.test(l))
    .map((l) => {
      // Location = last "file:line:col" token on the line (V8 uses this in both
      // "at fn (loc)" and the paren-less "at loc" forms).
      const loc = l.match(/([^\s()]+):(\d+):(\d+)\)?\s*$/);
      // Locations ONLY — no function names. A forged stack could pair a
      // sensitive fn ("AcmeImporter.load") with a trusted location to smuggle it
      // through, so we never emit fn. file:line is enough to locate a crash.
      return loc ? classifyLoc(loc[1], loc[2]).loc : '';
    })
    .filter(Boolean)
    .slice(0, 8);
  const sig = crypto
    .createHash('sha256')
    .update(safeErrorName(err.name) + '|' + frames.join('|'))
    .digest('hex')
    .slice(0, 12);
  // Preview is path-free by construction; scrub() is defense-in-depth.
  const preview = scrub(frames.slice(0, 4).join(' <- '));
  return { sig, preview };
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ── Send (throttled + deduped, fail-silent) ─────────────────

const sentSigs = new Set<string>();
let sentCount = 0;
const MAX_PER_PROCESS = 8;

/** Test-only: clear the per-process dedup/cap so each case starts fresh. */
export function __resetForTest(): void { sentSigs.clear(); sentCount = 0; }

function post(body: string): void {
  try {
    const req = https.request('https://cld-ctrl.com/px/collect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `cldctrl/${VERSION}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => { /* fail silently */ });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch { /* fail silently */ }
}

/**
 * Report one error. Coerces non-Error throws, scrubs everything, dedups by
 * signature, caps per process, and no-ops when disabled. Never throws.
 */
export function reportError(err: unknown, surface: ErrorSurface, kind = 'uncaught'): void {
  try {
    if (!isEnabled()) return;
    if (sentCount >= MAX_PER_PROCESS) return;

    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeJson(err));
    const { sig, preview } = distillStack(e);
    if (sentSigs.has(sig)) return; // one ping per distinct crash per process
    sentSigs.add(sig);
    sentCount++;

    // Error.name is caller-controlled — allowlist it (never scrub, never trust).
    const name = safeErrorName(e.name);
    // surface/kind are caller-supplied too (reportError is exported) — clamp
    // both to a fixed vocabulary so no free text can ride in via them.
    const safeSurface = SURFACES.has(surface) ? surface : 'cli';
    const safeKind = /^[a-zA-Z]{1,24}$/.test(kind) ? kind : 'uncaught';
    // Node system errors expose a clean uppercase `code` (ENOENT, ECONNREFUSED,
    // ERR_MODULE_NOT_FOUND) — high-signal for triage and PII-free by nature.
    const rawCode = (e as NodeJS.ErrnoException).code;
    const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(rawCode) ? rawCode : '';

    // ZERO free-text: we deliberately do NOT send err.message. Unquoted message
    // text (e.g. "tenant AcmeCorp user bob") isn't reliably scrub-able, so triage
    // rides on err_code + err_name + err_sig + err_stack (all structured/bounded).
    const body = JSON.stringify({
      h: 'cldctrl',
      prod: 'cldctrl',
      p: '/error/' + safeSurface,
      s: safeSurface,
      c: safeSurface,
      v: VERSION,
      e: 'error',
      // Grouping label the analytics Worker already stores: name + stack hash.
      l: `${name}:${sig}`,
      // All structured + bounded; the Worker may ignore unknown keys.
      err_kind: safeKind,
      err_name: name,
      err_code: code,
      err_sig: sig,
      err_stack: preview.slice(0, 300),
      plat: process.platform,
      node: process.version,
      osrel: safe(() => os.release()).slice(0, 24),
    });
    post(body);
  } catch { /* fail silently — telemetry must never break the app */ }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ── Install global handlers ─────────────────────────────────

let installed = false;
let currentSurface: ErrorSurface = 'cli';

/**
 * Attach process-level crash observers for a surface. Uses
 * `uncaughtExceptionMonitor`, which fires for telemetry WITHOUT suppressing
 * Node's default crash behavior (so existing exit paths are unchanged), plus a
 * passive `unhandledRejection` listener. Idempotent for the listeners, but a
 * later call refines the surface tag (e.g. a baseline 'cli' install in the
 * entrypoint is upgraded to 'tui'/'browser' once the real surface is known)
 * and, when `enabled` is passed, updates the opt-out flag immediately.
 */
export function installErrorHandlers(surface: ErrorSurface, enabled?: boolean): void {
  currentSurface = surface;
  if (typeof enabled === 'boolean') setErrorReportingEnabled(enabled);
  if (installed) return;
  installed = true;
  try {
    process.on('uncaughtExceptionMonitor', (err) => reportError(err, currentSurface, 'uncaughtException'));
    process.on('unhandledRejection', (reason) => reportError(reason, currentSurface, 'unhandledRejection'));
  } catch { /* ignore */ }
}
