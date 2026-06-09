/**
 * Check npm registry for newer versions of cldctrl.
 * Non-blocking, cached for 24 hours, fails silently.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { getConfigDir } from '../config.js';
import { VERSION } from '../constants.js';

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
function beacon(extra: Record<string, unknown>): void {
  try {
    const body = JSON.stringify({ h: 'cli', p: '/launch', s: 'cli', prod: 'cldctrl', l: VERSION, ...extra });
    const req = https.request('https://ryansphillips.com/px/collect', {
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
function pingAnalytics(): void {
  beacon({ a: 1 });
}

/** Heartbeat — keeps this instance shown as "live" while the TUI stays open
 *  (presence only; not counted as a new launch). Call on an interval. */
export function pingHeartbeat(): void {
  beacon({ e: 'ping', a: 1 });
}

/** Fetch actual latest version from npm registry (source of truth) */
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
 * Uses a 24h cache to avoid spamming npm on every launch.
 */
export async function checkForUpdate(force = false): Promise<string | null> {
  // Always ping for analytics (fire-and-forget, once per app launch)
  pingAnalytics();

  // Check cache first (skip if forced)
  if (!force) {
    const cached = readCache();
    if (cached) {
      return isNewer(cached.latestVersion, VERSION) ? cached.latestVersion : null;
    }
  }

  // Fetch actual version from npm (non-blocking, 5s timeout)
  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache(latest);
    return isNewer(latest, VERSION) ? latest : null;
  }

  return null;
}
