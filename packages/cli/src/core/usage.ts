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
            const dateStr = stat.mtime.toISOString().slice(0, 10);
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

/**
 * Single-project daily usage for the detail pane calendar.
 */
export async function getProjectDailyUsage(
  projectPath: string,
  days: number = 28
): Promise<DailyUsage[]> {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();

  // Use exact slug matching
  const slug = getProjectSlug(projectPath);

  // Collect tasks
  const tasks: Array<{ filePath: string; dateStr: string }> = [];

  try {
    const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const dir of slugDirs) {
      if (!dir.isDirectory()) continue;
      if (dir.name !== slug) continue;  // exact match

      const slugPath = path.join(projectsDir, dir.name);
      const files = fs.readdirSync(slugPath).filter(f => f.endsWith('.jsonl'));

      for (const f of files) {
        const filePath = path.join(slugPath, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoffMs) continue;
          if (stat.size > DEFAULTS.maxSessionFileSize) continue;
          const dateStr = stat.mtime.toISOString().slice(0, 10);
          tasks.push({ filePath, dateStr });
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    log('error', { function: 'getProjectDailyUsage', message: String(err) });
    return [];
  }

  // Process in parallel
  const results = await Promise.all(tasks.map(t => limit(async () => {
    const stats = await getSessionStats(t.filePath);
    return { ...t, stats };
  })));

  // Aggregate
  const dailyMap = new Map<string, DailyUsage>();
  for (const r of results) {
    if (!r.stats) continue;
    const existing = dailyMap.get(r.dateStr) || { date: r.dateStr, tokens: 0, messages: 0 };
    existing.tokens += r.stats.tokens;
    existing.messages += r.stats.messages;
    dailyMap.set(r.dateStr, existing);
  }

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}
