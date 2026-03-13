/**
 * Usage aggregation: per-project daily usage buckets for heatmaps.
 */

import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { getClaudeProjectsDir } from './platform.js';
import { getProjectSlug } from './projects.js';
import { getSessionStats } from './sessions.js';
import { log } from './logger.js';
import { DEFAULTS } from '../constants.js';
import type { DailyUsage } from '../types.js';

const limit = pLimit(5);

/** Format a Date as YYYY-MM-DD in local time (not UTC). */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Get daily usage stats for all projects over the last N days.
 * Returns a map of project slug → DailyUsage[].
 */
export async function getDailyUsageByProject(
  days: number = 28
): Promise<Record<string, DailyUsage[]>> {
  const projectsDir = getClaudeProjectsDir();
  const result: Record<string, DailyUsage[]> = {};

  if (!fs.existsSync(projectsDir)) return result;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();

  try {
    const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    // Collect all (dir, file, date) tasks
    const tasks: Array<{ dirName: string; filePath: string; dateStr: string }> = [];

    for (const dir of slugDirs) {
      if (!dir.isDirectory()) continue;
      const slugPath = path.join(projectsDir, dir.name);

      try {
        const files = fs.readdirSync(slugPath).filter(f => f.endsWith('.jsonl'));

        for (const f of files) {
          const filePath = path.join(slugPath, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoffMs) continue;
            if (stat.size > DEFAULTS.maxSessionFileSize) continue;
            const dateStr = localDateStr(stat.mtime);
            tasks.push({ dirName: dir.name, filePath, dateStr });
          } catch { /* skip file */ }
        }
      } catch { /* skip dir */ }
    }

    // Process in parallel
    const results = await Promise.all(tasks.map(t => limit(async () => {
      const stats = await getSessionStats(t.filePath);
      return { ...t, stats };
    })));

    // Aggregate results
    for (const r of results) {
      if (!r.stats) continue;
      if (!result[r.dirName]) result[r.dirName] = [];

      let existing = result[r.dirName].find(d => d.date === r.dateStr);
      if (!existing) {
        existing = { date: r.dateStr, tokens: 0, messages: 0 };
        result[r.dirName].push(existing);
      }
      existing.tokens += r.stats.tokens;
      existing.messages += r.stats.messages;
    }

    // Sort each project's daily entries
    for (const key of Object.keys(result)) {
      result[key].sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch (err) {
    log('error', { function: 'getDailyUsageByProject', message: String(err) });
  }

  return result;
}

