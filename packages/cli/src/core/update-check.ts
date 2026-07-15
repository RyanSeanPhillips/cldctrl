/**
 * Check npm registry for newer versions of cldctrl.
 * Non-blocking, cached for 24 hours, fails silently.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { getConfigDir } from '../config.js';
import { VERSION } from '../constants.js';
import { telemetryEnabled } from './error-report.js';

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCachePath(): string {
  return path.join(getConfigDir(), 'update-check.json');
}

function readCache(): UpdateCache | null {
  try {
    const data = JSON.parse(fs.readFileSync(getCachePath(), 'utf-8'));
    if (data.checkedAt && Date.now() - data.checkedAt < CACHE_TTL) {
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(latestVersion: string): void {
  try {
    const cachePath = getCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ latestVersion, checkedAt: Date.now() }));
  } catch { /* ignore */ }
}

/**
 * Cookieless, region-level launch analytics — one fire-and-forget ping per run
 * to the usage Worker. The Worker derives city/country + a daily anonymized
 * visitor hash from the request edge-side (raw IP never stored) and tags this
 * as the cldctrl CLI. Replaces the old cld-ctrl.com/version.json request-count
 * trick, which was limited to ~8 days of Cloudflare free-plan retention, had no
 * unique-user signal, and was polluted by scanners hitting the public path.
 */
/** Which surface produced the ping, so adoption can be split TUI vs browser vs
 *  bare CLI. Sent as `s` (the worker's surface/site field) + `c` (explicit). */
export type ClientKind = 'tui' | 'browser' | 'cli';

function beacon(client: ClientKind, extra: Record<string, unknown>): void {
  try {
    // One telemetry switch governs everything that phones home: honor the same
    // opt-out as crash reporting (DO_NOT_TRACK / CLDCTRL_NO_TELEMETRY / the
    // config's error_reporting.enabled=false). Disclosed in README "Telemetry".
    if (!telemetryEnabled()) return;
    // Field names match the analytics Worker (app-analytics): `s` → site/surface,
    // `v` → app version (the worker's `ver` column; it was previously sent as `l`,
    // which the worker reads as an event label, so version never recorded — fixed).
    const body = JSON.stringify({ h: 'cldctrl', p: '/' + client, s: client, c: client, prod: 'cldctrl', v: VERSION, ...extra });
    const req = https.request('https://cld-ctrl.com/px/collect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `cldctrl/${VERSION}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, res => { res.resume(); });
    req.on('error', () => { /* fail silently */ });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch { /* fail silently */ }
}

/** Launch ping — one beacon per app start (recorded as a usage hit). */
function pingAnalytics(client: ClientKind): void {
  beacon(client, { a: 1 });
}

/** Heartbeat — keeps an instance shown as "live" while it stays open (presence
 *  only; not a new launch). Call on an interval. Defaults to the TUI surface. */
export function pingHeartbeat(client: ClientKind = 'tui'): void {
  beacon(client, { e: 'ping', a: 1 });
}

/**
 * Version check against our own endpoint, which doubles as the adoption signal:
 * a single GET that returns the latest published version AND is logged
 * server-side for the same cookieless, geo-only stats as the beacon (the `c`
 * client tag + `l` current version ride along as query params). Returns null if
 * the endpoint is unavailable/old — the caller then falls back to npm, so update
 * checking never depends on this. The Worker should answer with `{version:"x.y.z"}`.
 */
function fetchVersionFromHome(client: ClientKind): Promise<string | null> {
  return new Promise(resolve => {
    const qs = `prod=cldctrl&v=${encodeURIComponent(VERSION)}&c=${client}&a=1`;
    const req = https.get(`https://cld-ctrl.com/px/version?${qs}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': `cldctrl/${VERSION}` },
      timeout: 4000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const v = json.version ?? json.latest ?? null;
          resolve(typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Fetch actual latest version from npm registry (fallback source of truth). */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise(resolve => {
    const req = https.get('https://registry.npmjs.org/cldctrl/latest', {
      headers: { 'Accept': 'application/json', 'User-Agent': `cldctrl/${VERSION}` },
      timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.version ?? null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Check for updates. Returns the latest version if newer, null otherwise.
 * Prefers our own version endpoint (which also records the geo-only adoption
 * hit) and fires it every launch; falls back to a bare analytics ping + the
 * npm registry (cached 24h) if the endpoint is unavailable.
 */
export async function checkForUpdate(force = false, client: ClientKind = 'cli'): Promise<string | null> {
  // One request that both checks the version and records the launch — so with
  // telemetry opted out, skip our endpoint entirely (it logs adoption stats
  // server-side) and resolve the version from cache/npm only.
  let latest = telemetryEnabled() ? await fetchVersionFromHome(client) : null;

  if (!latest) {
    // Endpoint down/missing — still count the launch, then resolve the version
    // from cache (unless forced) or npm so update checking keeps working.
    pingAnalytics(client);
    if (!force) {
      const cached = readCache();
      if (cached) latest = cached.latestVersion;
    }
    if (!latest) latest = await fetchLatestVersion();
  }

  if (latest) {
    writeCache(latest);
    return isNewer(latest, VERSION) ? latest : null;
  }

  return null;
}
