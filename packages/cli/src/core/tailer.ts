/**
 * Real-time JSONL session tailing via fs.watchFile + incremental byte-offset parsing.
 * Provides live token counts, tool calls, and current action for active sessions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionDir } from './projects.js';
import { log } from './logger.js';
import type { SessionActivity } from '../types.js';

// ── Tool classification (shared with activity.ts) ────────────

const MCP_PREFIX = 'mcp__';
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function classifyToolUse(
  name: string,
  activity: SessionActivity,
): void {
  if (name.startsWith(MCP_PREFIX)) {
    const parts = name.slice(MCP_PREFIX.length).split('__');
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolName = parts.slice(1).join('__');
      if (!activity.mcpCalls[serverName]) {
        activity.mcpCalls[serverName] = { name: serverName, tools: {}, totalCalls: 0 };
      }
      activity.mcpCalls[serverName].tools[toolName] =
        (activity.mcpCalls[serverName].tools[toolName] || 0) + 1;
      activity.mcpCalls[serverName].totalCalls++;
    }
  } else if (name === 'Task' || name === 'Agent') {
    activity.agentSpawns++;
  } else if (READ_TOOLS.has(name)) {
    activity.toolCalls.reads++;
  } else if (WRITE_TOOLS.has(name)) {
    activity.toolCalls.writes++;
  } else if (name === 'Bash') {
    activity.toolCalls.bash++;
  } else {
    activity.toolCalls.other++;
  }
}

// ── Find active session file ─────────────────────────────────

/**
 * Find the most recently modified .jsonl file in a project's session dir.
 * Returns null if no session files exist.
 */
export function getActiveSessionFile(projectPath: string): string | null {
  try {
    const sessionDir = getSessionDir(projectPath);
    if (!fs.existsSync(sessionDir)) return null;

    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(sessionDir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { path: fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; mtimeMs: number } => f !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files[0]?.path ?? null;
  } catch (err) {
    log('error', { function: 'getActiveSessionFile', message: String(err) });
    return null;
  }
}

// ── Incremental JSONL tailer ─────────────────────────────────

export interface TailState {
  activity: SessionActivity;
  currentAction?: string;
  sessionId?: string;
  filePath: string;
}

interface TailerInternal {
  filePath: string;
  byteOffset: number;
  partialLine: string;
  activity: SessionActivity;
  currentAction?: string;
  sessionId?: string;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastWasAssistant: boolean;
}

function createEmptyActivity(): SessionActivity {
  return {
    messages: 0,
    tokens: 0,
    toolCalls: { reads: 0, writes: 0, bash: 0, other: 0 },
    mcpCalls: {},
    agentSpawns: 0,
    interruptions: 0,
    models: {},
    thinkingTokens: 0,
    duration: 0,
    hourlyActivity: new Array(24).fill(0),
  };
}

function processLine(line: string, state: TailerInternal): void {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }

  // Timestamp
  if (obj.timestamp) {
    const ts = new Date(obj.timestamp).getTime();
    if (!isNaN(ts)) {
      if (state.firstTimestamp === null) state.firstTimestamp = ts;
      state.lastTimestamp = ts;
      state.activity.hourlyActivity[new Date(ts).getHours()]++;
    }
  }

  // Session ID from uuid field
  if (obj.uuid && !state.sessionId) {
    state.sessionId = obj.uuid;
  }

  if (obj.type === 'user') {
    state.activity.messages++;
    if (state.lastWasAssistant) state.activity.interruptions++;
    state.lastWasAssistant = false;
  } else if (obj.type === 'assistant' && obj.message) {
    state.lastWasAssistant = true;
    const msg = obj.message;

    // Model tracking
    if (msg.model) {
      state.activity.models[msg.model] = (state.activity.models[msg.model] || 0) + 1;
    }

    // Token counting
    if (msg.usage) {
      state.activity.tokens += (msg.usage.input_tokens || 0)
        + (msg.usage.output_tokens || 0)
        + (msg.usage.cache_read_input_tokens || 0)
        + (msg.usage.cache_creation_input_tokens || 0);
    }

    // Tool use from content array — also track current action
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        const name = block.name;
        if (!name) continue;

        classifyToolUse(name, state.activity);

        // Track current action (last tool_use seen)
        state.currentAction = name;
        if (block.input) {
          const filePath = block.input.file_path || block.input.path;
          if (filePath) {
            const parts = String(filePath).split(/[/\\]/);
            state.currentAction += ` ${parts[parts.length - 1]}`;
          }
        }
      }
    }
  }

  // Update duration
  if (state.firstTimestamp !== null && state.lastTimestamp !== null) {
    state.activity.duration = state.lastTimestamp - state.firstTimestamp;
  }
}

function readNewBytes(state: TailerInternal): boolean {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(state.filePath);
    const fileSize = stat.size;

    // File truncated — reset
    if (fileSize < state.byteOffset) {
      state.byteOffset = 0;
      state.partialLine = '';
      state.activity = createEmptyActivity();
      state.currentAction = undefined;
      state.firstTimestamp = null;
      state.lastTimestamp = null;
      state.lastWasAssistant = false;
    }

    // No new data
    if (fileSize <= state.byteOffset) return false;

    const bytesToRead = fileSize - state.byteOffset;
    const buf = Buffer.alloc(bytesToRead);

    fd = fs.openSync(state.filePath, 'r');
    fs.readSync(fd, buf, 0, bytesToRead, state.byteOffset);
    fs.closeSync(fd);
    fd = null;

    state.byteOffset = fileSize;

    const text = state.partialLine + buf.toString('utf-8');
    const lines = text.split('\n');

    // Last element may be partial — buffer it
    state.partialLine = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) processLine(trimmed, state);
    }

    return true;
  } catch (err: any) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    // EBUSY on Windows/Dropbox — skip this tick
    if (err.code === 'EBUSY') return false;
    log('error', { function: 'readNewBytes', message: String(err) });
    return false;
  }
}

/**
 * Start tailing a JSONL file. Calls onUpdate with incremental state on each change.
 * Returns a cleanup function that stops watching.
 */
export function tailSessionFile(
  filePath: string,
  onUpdate: (state: TailState) => void,
): () => void {
  const state: TailerInternal = {
    filePath,
    byteOffset: 0,
    partialLine: '',
    activity: createEmptyActivity(),
    currentAction: undefined,
    sessionId: undefined,
    firstTimestamp: null,
    lastTimestamp: null,
    lastWasAssistant: false,
  };

  // Do an initial full read
  readNewBytes(state);
  onUpdate({
    activity: { ...state.activity },
    currentAction: state.currentAction,
    sessionId: state.sessionId,
    filePath: state.filePath,
  });

  // Watch for changes at 1s interval
  const listener = () => {
    const changed = readNewBytes(state);
    if (changed) {
      onUpdate({
        activity: { ...state.activity },
        currentAction: state.currentAction,
        sessionId: state.sessionId,
      });
    }
  };

  fs.watchFile(filePath, { interval: 1000 }, listener);

  return () => {
    fs.unwatchFile(filePath, listener);
  };
}
