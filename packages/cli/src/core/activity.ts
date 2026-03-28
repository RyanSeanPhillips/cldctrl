/**
 * JSONL activity parser: rich stats, hourly activity, current action.
 * Streaming readline with LRU cache (same pattern as sessions.ts).
 * Uses JSON parsing (not regex) to avoid inflated counts from streaming/progress lines.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { DEFAULTS } from '../constants.js';
import { log } from './logger.js';
import { classifyToolUse } from './tailer.js';
import type { SessionActivity } from '../types.js';

// Timestamp regex — only used by getActiveSessionInfo which reads raw tail
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

// ── Cache ────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 100;
const activityCache = new Map<string, SessionActivity>();

function getCacheKey(filePath: string, stat: fs.Stats): string {
  return `${filePath}|${stat.mtimeMs}|${stat.size}`;
}

function cacheSet(key: string, value: SessionActivity): void {
  if (activityCache.size >= MAX_CACHE_SIZE) {
    const firstKey = activityCache.keys().next().value;
    if (firstKey) activityCache.delete(firstKey);
  }
  activityCache.set(key, value);
}

// ── Main parser ──────────────────────────────────────────────

export async function parseSessionActivity(filePath: string): Promise<SessionActivity | null> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return null;

    const cacheKey = getCacheKey(filePath, stat);
    const cached = activityCache.get(cacheKey);
    if (cached) return cached;

    const activity: SessionActivity = {
      messages: 0,
      tokens: 0,
      tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      inputPerMessage: [],
      toolCalls: { reads: 0, writes: 0, bash: 0, other: 0 },
      mcpCalls: {},
      agentSpawns: 0,
      interruptions: 0,
      models: {},
      thinkingTokens: 0,
      duration: 0,
      hourlyActivity: new Array(24).fill(0),
      assistantTurns: 0,
      toolUseTurns: 0,
      lastContextSize: 0,
    };

    let firstTimestamp: number | null = null;
    let lastTimestamp: number | null = null;
    let lastWasAssistant = false;
    const now = Date.now();
    const hourlyWindowMs = 5 * 60 * 60_000; // 5h — matches ACTIVE_THRESHOLD_MS

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        // Timestamp
        if (obj.timestamp) {
          const ts = new Date(obj.timestamp).getTime();
          if (!isNaN(ts)) {
            if (firstTimestamp === null) firstTimestamp = ts;
            lastTimestamp = ts;
            if (now - ts <= hourlyWindowMs) {
              activity.hourlyActivity[new Date(ts).getHours()]++;
            }
          }
        }

        if (obj.type === 'user') {
          activity.messages++;
          if (lastWasAssistant) activity.interruptions++;
          lastWasAssistant = false;
        } else if (obj.type === 'assistant' && obj.message) {
          lastWasAssistant = true;
          activity.assistantTurns++;
          const msg = obj.message;

          // Model tracking
          if (msg.model) {
            activity.models[msg.model] = (activity.models[msg.model] || 0) + 1;
          }

          // Token counting from usage object
          if (msg.usage) {
            const inp = msg.usage.input_tokens || 0;
            const out = msg.usage.output_tokens || 0;
            const cacheR = msg.usage.cache_read_input_tokens || 0;
            const cacheW = msg.usage.cache_creation_input_tokens || 0;
            activity.tokens += inp + out + cacheR + cacheW;
            activity.tokenBreakdown.input += inp;
            activity.tokenBreakdown.output += out;
            activity.tokenBreakdown.cacheRead += cacheR;
            activity.tokenBreakdown.cacheWrite += cacheW;
            activity.inputPerMessage.push(inp);
            const turnCtx = cacheR + inp + cacheW;
            if (turnCtx > 0) activity.lastContextSize = turnCtx;
          }

          // Tool use from content array
          let hasToolUse = false;
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type !== 'tool_use') continue;
              hasToolUse = true;
              const name = block.name;
              if (!name) continue;
              classifyToolUse(name, activity);
            }
          }
          if (hasToolUse) activity.toolUseTurns++;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    if (firstTimestamp !== null && lastTimestamp !== null) {
      activity.duration = lastTimestamp - firstTimestamp;
    }

    cacheSet(cacheKey, activity);
    return activity;
  } catch (err) {
    log('error', { function: 'parseSessionActivity', message: String(err) });
    return null;
  }
}

// ── Active session info (last ~20 lines) ─────────────────────

export async function getActiveSessionInfo(filePath: string): Promise<{ currentAction?: string; stats: SessionActivity } | null> {
  const stats = await parseSessionActivity(filePath);
  if (!stats) return null;

  let currentAction: string | undefined;
  try {
    const stat = fs.statSync(filePath);
    // Read last chunk of the file
    const chunkSize = Math.min(stat.size, 16384);
    const buf = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, chunkSize, Math.max(0, stat.size - chunkSize));
      const text = buf.toString('utf-8');
      const lines = text.split('\n').filter(l => l.trim());
      // Find last tool_use
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const line = lines[i];
        if (line.includes('"tool_use"')) {
          const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
          if (nameMatch) {
            currentAction = nameMatch[1];
            // Try to get file path from input
            const fileMatch = line.match(/"file_path"\s*:\s*"([^"]+)"/);
            if (fileMatch) {
              const parts = fileMatch[1].split(/[/\\]/);
              currentAction += ` ${parts[parts.length - 1]}`;
            }
            break;
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore, just return stats without currentAction
  }

  return { currentAction, stats };
}
