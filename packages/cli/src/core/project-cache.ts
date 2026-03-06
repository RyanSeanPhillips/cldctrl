/**
 * Persistent project name cache to avoid expensive git/metadata lookups on every launch.
 * Stored at %APPDATA%/cldctrl/project-names.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'cldctrl',
);
const CACHE_PATH = path.join(CACHE_DIR, 'project-names.json');

interface ProjectNameCache {
  [projectPath: string]: string;
}

export function readProjectNameCache(): ProjectNameCache {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeProjectNameCache(cache: ProjectNameCache): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {}
}
