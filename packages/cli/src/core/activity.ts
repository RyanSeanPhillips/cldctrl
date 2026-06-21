/**
 * JSONL activity parser: rich stats, hourly activity, current action.
 * Incremental byte-offset parsing (same pattern as tailer.ts): running totals
 * are kept per file, and only appended bytes are parsed on subsequent calls —
 * a live session costs KBs per poll instead of a full re-parse of the file.
 * Uses JSON parsing (not regex) to avoid inflated counts from streaming/progress lines.
 */

import fs from 'node:fs';
import { DEFAULTS } from '../constants.js';
import { log } from './logger.js';
import { classifyToolUse } from './tailer.js';
import type { SessionActivity } from '../types.js';

// ── Incremental parse state ──────────────────────────────────

const MAX_CACHE_SIZE = 100;
const HOURLY_WINDOW_MS = 5 * 60 * 60_000; // 5h — matches ACTIVE_THRESHOLD_MS
const HOUR_MS = 60 * 60_000;
const READ_CHUNK_BYTES = 1 << 20; // 1MB per read — yields between chunks

interface ParseState {
  byteOffset: number;
  /** Raw bytes after the last newline — may end mid-multi-byte-char, so kept as Buffer */
  partialBuf: Buffer;
  mtimeMs: number;
  size: number;
  /** Running totals. hourlyActivity here is unused — rebuilt from hourEvents per snapshot. */
  activity: SessionActivity;
  /** Timestamped event counts by hour-start epoch, for the rolling hourly window */
  hourEvents: Map<number, number>;
  /** Per-file touch counts from tool_use inputs (absolute paths) */
  touched: Map<string, { reads: number; writes: number; lastTs: number }>;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastWasAssistant: boolean;
  /** Last returned snapshot — reused (same ref) when the file hasn't changed */
  snapshot: SessionActivity | null;
}

const stateCache = new Map<string, ParseState>();

function newParseState(): ParseState {
  return {
    byteOffset: 0,
    partialBuf: Buffer.alloc(0),
    mtimeMs: 0,
    size: 0,
    activity: {
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
    },
    hourEvents: new Map(),
    touched: new Map(),
    firstTimestamp: null,
    lastTimestamp: null,
    lastWasAssistant: false,
    snapshot: null,
  };
}

function cacheSetState(filePath: string, state: ParseState): void {
  if (!stateCache.has(filePath) && stateCache.size >= MAX_CACHE_SIZE) {
    const firstKey = stateCache.keys().next().value;
    if (firstKey) stateCache.delete(firstKey);
  }
  stateCache.set(filePath, state);
}

// ── Line processing ──────────────────────────────────────────

function processLine(line: string, state: ParseState): void {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }

  const activity = state.activity;

  // Timestamp
  if (obj.timestamp) {
    const ts = new Date(obj.timestamp).getTime();
    if (!isNaN(ts)) {
      if (state.firstTimestamp === null) state.firstTimestamp = ts;
      state.lastTimestamp = ts;
      const hourStart = ts - (ts % HOUR_MS);
      state.hourEvents.set(hourStart, (state.hourEvents.get(hourStart) ?? 0) + 1);
    }
  }

  if (obj.type === 'user') {
    activity.messages++;
    if (state.lastWasAssistant) activity.interruptions++;
    state.lastWasAssistant = false;
  } else if (obj.type === 'assistant' && obj.message) {
    state.lastWasAssistant = true;
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

        // Track which file this tool touched
        const fp = block.input?.file_path ?? block.input?.notebook_path ?? block.input?.path;
        if (typeof fp === 'string' && fp.length > 0 && fp.length < 1024) {
          const isWrite = name === 'Write' || name === 'Edit' || name === 'NotebookEdit';
          const t = state.touched.get(fp) ?? { reads: 0, writes: 0, lastTs: 0 };
          if (isWrite) t.writes++; else t.reads++;
          if (state.lastTimestamp !== null) t.lastTs = state.lastTimestamp;
          state.touched.set(fp, t);
        }
      }
    }
    if (hasToolUse) activity.toolUseTurns++;
  }
}

// ── Incremental file reading ─────────────────────────────────

/**
 * Read bytes from state.byteOffset to targetSize, feeding complete lines to
 * processLine. Splits on the last newline per chunk so multi-byte UTF-8
 * characters are never decoded across a chunk boundary.
 */
async function readAppended(filePath: string, state: ParseState, targetSize: number): Promise<void> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, targetSize - state.byteOffset));
    while (state.byteOffset < targetSize) {
      const want = Math.min(buf.length, targetSize - state.byteOffset);
      const { bytesRead } = await fh.read(buf, 0, want, state.byteOffset);
      if (bytesRead <= 0) break;
      state.byteOffset += bytesRead;

      const chunk = state.partialBuf.length > 0
        ? Buffer.concat([state.partialBuf, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        state.partialBuf = Buffer.from(chunk); // copy — buf is reused next iteration
        continue;
      }
      state.partialBuf = Buffer.from(chunk.subarray(lastNewline + 1));

      const lines = chunk.toString('utf-8', 0, lastNewline).split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processLine(trimmed, state);
      }
    }
  } finally {
    await fh.close();
  }
}

// ── Snapshot building ────────────────────────────────────────

/** Build an immutable copy of the running totals (callers compare by reference). */
function buildSnapshot(state: ParseState, now: number): SessionActivity {
  const a = state.activity;

  // Rolling hourly window: prune buckets outside 5h, bin the rest by hour-of-day
  const cutoff = now - HOURLY_WINDOW_MS;
  const hourlyActivity = new Array(24).fill(0);
  for (const [hourStart, count] of state.hourEvents) {
    if (hourStart + HOUR_MS <= cutoff) {
      state.hourEvents.delete(hourStart);
    } else {
      hourlyActivity[new Date(hourStart).getHours()] += count;
    }
  }

  const mcpCalls: SessionActivity['mcpCalls'] = {};
  for (const [server, info] of Object.entries(a.mcpCalls)) {
    mcpCalls[server] = { name: info.name, totalCalls: info.totalCalls, tools: { ...info.tools } };
  }

  return {
    messages: a.messages,
    tokens: a.tokens,
    tokenBreakdown: { ...a.tokenBreakdown },
    inputPerMessage: a.inputPerMessage.slice(),
    toolCalls: { ...a.toolCalls },
    mcpCalls,
    agentSpawns: a.agentSpawns,
    interruptions: a.interruptions,
    models: { ...a.models },
    thinkingTokens: a.thinkingTokens,
    duration: state.firstTimestamp !== null && state.lastTimestamp !== null
      ? state.lastTimestamp - state.firstTimestamp
      : 0,
    hourlyActivity,
    assistantTurns: a.assistantTurns,
    toolUseTurns: a.toolUseTurns,
    lastContextSize: a.lastContextSize,
    touchedFiles: [...state.touched.entries()]
      .map(([p, t]) => ({ path: p, reads: t.reads, writes: t.writes, lastTs: t.lastTs }))
      .sort((x, y) => y.lastTs - x.lastTs)
      .slice(0, 200),
  };
}

// ── Main parser ──────────────────────────────────────────────

export async function parseSessionActivity(filePath: string): Promise<SessionActivity | null> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return null;

    let state = stateCache.get(filePath);

    // Reset on truncation or in-place rewrite (mtime changed but size didn't grow)
    if (state && (stat.size < state.byteOffset
      || (stat.size === state.size && stat.mtimeMs !== state.mtimeMs))) {
      state = undefined;
    }

    if (!state) {
      state = newParseState();
      cacheSetState(filePath, state);
    }

    // Unchanged since last call — return the same snapshot (stable reference)
    if (state.snapshot && stat.size === state.size && stat.mtimeMs === state.mtimeMs) {
      return state.snapshot;
    }

    if (stat.size > state.byteOffset) {
      await readAppended(filePath, state, stat.size);
    }
    state.mtimeMs = stat.mtimeMs;
    state.size = stat.size;

    state.snapshot = buildSnapshot(state, Date.now());
    return state.snapshot;
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
