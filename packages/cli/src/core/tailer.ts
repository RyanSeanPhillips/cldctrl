/**
 * Real-time JSONL session tailing via fs.watchFile + incremental byte-offset parsing.
 * Provides live token counts, tool calls, and current action for active sessions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionDir, getNewestSessionFile } from './projects.js';
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
  return getNewestSessionFile(projectPath)?.filePath ?? null;
}

// ── Incremental JSONL tailer ─────────────────────────────────

export interface TailState {
  activity: SessionActivity;
  currentAction?: string;
  sessionId?: string;
  filePath: string;
  /** One-line summaries of completed rounds (most recent last, max 5). */
  roundSummaries: string[];
}

const MAX_ROUND_SUMMARIES = 5;
const MAX_PROMPT_LENGTH = 200;
const MAX_TOOL_ACTIONS = 8;

/** Data collected during a single user→assistant round. */
interface RoundData {
  userPrompt: string;
  toolActions: string[];       // e.g., "Edit DetailPane.tsx", "Read tailer.ts"
  assistantSnippet: string;    // first ~200 chars of assistant text
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
  // Round tracking
  currentRound: {
    userPrompt: string;
    toolActions: string[];
    assistantText: string;
  };
  pendingRounds: RoundData[];    // completed rounds awaiting summary generation
  roundSummaries: string[];      // one-line round summaries
  roundCount: number;            // total rounds seen
}

function createEmptyActivity(): SessionActivity {
  return {
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

    // Finalize the previous round (if it has tool actions)
    if (state.currentRound.toolActions.length > 0 || state.currentRound.assistantText) {
      state.pendingRounds.push({
        userPrompt: state.currentRound.userPrompt,
        toolActions: state.currentRound.toolActions.slice(0, MAX_TOOL_ACTIONS),
        assistantSnippet: state.currentRound.assistantText.slice(0, MAX_PROMPT_LENGTH),
      });
      state.roundCount++;
    }

    // Start a new round — extract user prompt text
    const msg = obj.message;
    let text = '';
    if (msg) {
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join(' ');
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_PROMPT_LENGTH) text = text.slice(0, MAX_PROMPT_LENGTH - 3) + '...';
    state.currentRound = { userPrompt: text, toolActions: [], assistantText: '' };
  } else if (obj.type === 'assistant' && obj.message) {
    state.lastWasAssistant = true;
    state.activity.assistantTurns++;
    const msg = obj.message;

    // Model tracking
    if (msg.model) {
      state.activity.models[msg.model] = (state.activity.models[msg.model] || 0) + 1;
    }

    // Token counting
    if (msg.usage) {
      const inp = msg.usage.input_tokens || 0;
      const out = msg.usage.output_tokens || 0;
      const cacheR = msg.usage.cache_read_input_tokens || 0;
      const cacheW = msg.usage.cache_creation_input_tokens || 0;
      state.activity.tokens += inp + out + cacheR + cacheW;
      state.activity.tokenBreakdown.input += inp;
      state.activity.tokenBreakdown.output += out;
      state.activity.tokenBreakdown.cacheRead += cacheR;
      state.activity.tokenBreakdown.cacheWrite += cacheW;
      state.activity.inputPerMessage.push(inp);
    }

    // Collect assistant text output for round summaries
    let hasToolUse = false;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text && state.currentRound.assistantText.length < MAX_PROMPT_LENGTH) {
          state.currentRound.assistantText += (state.currentRound.assistantText ? ' ' : '') + block.text;
        }
        if (block.type !== 'tool_use') continue;
        hasToolUse = true;
        const name = block.name;
        if (!name) continue;

        classifyToolUse(name, state.activity);

        // Track current action (last tool_use seen)
        state.currentAction = name;
        let actionStr = name;
        if (block.input) {
          const filePath = block.input.file_path || block.input.path;
          if (filePath) {
            const parts = String(filePath).split(/[/\\]/);
            const fileName = parts[parts.length - 1];
            state.currentAction += ` ${fileName}`;
            actionStr += ` ${fileName}`;
          }
        }

        // Record for round summary (deduplicate)
        if (state.currentRound.toolActions.length < MAX_TOOL_ACTIONS
            && !state.currentRound.toolActions.includes(actionStr)) {
          state.currentRound.toolActions.push(actionStr);
        }
      }
    }
    if (hasToolUse) state.activity.toolUseTurns++;
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

    // Cap initial read to last 1MB to avoid OOM on large session files
    const MAX_INITIAL_BYTES = 1_048_576;
    if (state.byteOffset === 0 && fileSize > MAX_INITIAL_BYTES) {
      state.byteOffset = fileSize - MAX_INITIAL_BYTES;
      state.partialLine = '';
    }

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

// ── Round summarization (template-based, no API calls) ──────

/**
 * Build a concise round summary from the user prompt + tool activity.
 * Format: "user request — edited X, Y" or just "user request" or just "edited X, Y"
 */
function buildRoundSummary(round: RoundData): string {
  // Build tool activity suffix
  const writes = round.toolActions
    .filter(a => a.startsWith('Edit') || a.startsWith('Write'))
    .map(a => a.split(' ').slice(1).join(' '))
    .filter(Boolean);
  const bashCount = round.toolActions.filter(a => a.startsWith('Bash')).length;

  const activityParts: string[] = [];
  if (writes.length > 0) {
    // Show up to 3 filenames
    const shown = writes.slice(0, 3);
    const suffix = writes.length > 3 ? ` +${writes.length - 3}` : '';
    activityParts.push(`edited ${shown.join(', ')}${suffix}`);
  }
  if (bashCount > 0) activityParts.push(`${bashCount} cmd${bashCount > 1 ? 's' : ''}`);

  const activity = activityParts.join(', ');

  // Prefer the user prompt as the primary description
  if (round.userPrompt) {
    const prompt = round.userPrompt.length > 80
      ? round.userPrompt.slice(0, 77) + '...'
      : round.userPrompt;
    // Append activity if there's room
    if (activity && prompt.length + activity.length < 100) {
      return `${prompt} — ${activity}`;
    }
    return prompt;
  }

  // No user prompt — use activity only
  return activity || '';
}

/** Process all pending rounds into summaries (synchronous, no API calls). */
function drainPendingRounds(state: TailerInternal): void {
  while (state.pendingRounds.length > 0) {
    const round = state.pendingRounds.shift()!;
    const summary = buildRoundSummary(round);
    if (!summary) continue;
    state.roundSummaries.push(summary);
    if (state.roundSummaries.length > MAX_ROUND_SUMMARIES) {
      state.roundSummaries.shift();
    }
  }
}

function buildTailState(state: TailerInternal): TailState {
  return {
    activity: { ...state.activity },
    currentAction: state.currentAction,
    sessionId: state.sessionId,
    filePath: state.filePath,
    roundSummaries: [...state.roundSummaries],
  };
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
    currentRound: { userPrompt: '', toolActions: [], assistantText: '' },
    pendingRounds: [],
    roundSummaries: [],
    roundCount: 0,
  };

  // Do an initial full read and summarize all completed rounds
  readNewBytes(state);
  drainPendingRounds(state);
  onUpdate(buildTailState(state));

  // Watch for changes at 1s interval
  const listener = () => {
    const changed = readNewBytes(state);
    if (changed) {
      drainPendingRounds(state);
      onUpdate(buildTailState(state));
    }
  };

  fs.watchFile(filePath, { interval: 1000 }, listener);

  return () => {
    fs.unwatchFile(filePath, listener);
  };
}
