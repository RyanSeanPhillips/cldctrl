/**
 * Structured JSONL logging with 5MB rotation.
 * Mirrors the PowerShell Write-DockLog function.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../constants.js';
import { getConfigDir } from '../config.js';

let logPath: string | null = null;
let verbose = false;

export function initLogger(opts: { verbose?: boolean } = {}): void {
  verbose = opts.verbose ?? false;
  const configDir = getConfigDir();
  logPath = path.join(configDir, 'debug.log');
}

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function log(event: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };

  if (verbose) {
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  if (!logPath) return;

  try {
    // Rotation check
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > DEFAULTS.logMaxSize) {
        const rotatedPath = logPath + '.1';
        try { fs.unlinkSync(rotatedPath); } catch { /* ignore */ }
        fs.renameSync(logPath, rotatedPath);
      }
    } catch {
      // File doesn't exist yet — fine
    }

    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Logging should never crash the app
  }
}
