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
    fs.writeFileSync(getCachePath(), JSON.stringify({ latestVersion, checkedAt: Date.now() }));
  } catch { /* ignore */ }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise(resolve => {
    // Check cld-ctrl.com/version.json — lightweight, cacheable, trackable via Cloudflare
    const req = https.get('https://cld-ctrl.com/version.json', {
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
  // Check cache first (skip if forced)
  if (!force) {
    const cached = readCache();
    if (cached) {
      return isNewer(cached.latestVersion, VERSION) ? cached.latestVersion : null;
    }
  }

  // Fetch from npm (non-blocking, 5s timeout)
  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache(latest);
    return isNewer(latest, VERSION) ? latest : null;
  }

  return null;
}
