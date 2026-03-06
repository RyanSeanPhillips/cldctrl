/**
 * Persistent project name cache to avoid expensive git/metadata lookups on every launch.
 * Stored at %APPDATA%/cldctrl/project-names.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';

const CACHE_PATH_FILENAME = 'project-names.json';

interface ProjectNameCache {
  [projectPath: string]: string;
}

export function readProjectNameCache(): ProjectNameCache {
  try {
    const cachePath = path.join(getConfigDir(), CACHE_PATH_FILENAME);
    if (!fs.existsSync(cachePath)) return {};
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeProjectNameCache(cache: ProjectNameCache): void {
  try {
    const cachePath = path.join(getConfigDir(), CACHE_PATH_FILENAME);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch { /* non-critical */ }
}
