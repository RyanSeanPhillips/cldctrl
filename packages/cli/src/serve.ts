/**
 * `cc serve` — browser dashboard served by a tiny HTTP server.
 * PROTOTYPE: binds 127.0.0.1 only, no auth token yet.
 * Reuses the same core/ data layer as the TUI and MCP server.
 *
 * Write actions (launch/resume) are guarded against CSRF and DNS rebinding:
 * POSTs require the X-CLDCTRL custom header (forces a CORS preflight that
 * cross-origin pages can't pass) and every request must carry a localhost
 * Host header. Launch targets are validated against the known project list —
 * arbitrary paths from the client are rejected.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';
import { VERSION } from './constants.js';
import { loadConfig, getConfigDir } from './config.js';
import { installErrorHandlers } from './core/error-report.js';
import { buildProjectListFast, projectGroup, getSessionDir } from './core/projects.js';
import { getActiveClaudeProcesses } from './core/processes.js';
import { getActiveSessionInfo } from './core/activity.js';
import { getRollingUsageWindowed, getRecentSessions } from './core/sessions.js';
import { getDailyUsageByProject } from './core/usage.js';
import { getRecentCommits, getCommitDailyActivity } from './core/git.js';
import { getIssues, isGhAvailable, getGhInstallUrl } from './core/github.js';
import { parseGitignore, readDirectory } from './core/filetree.js';
import { searchConversations, deriveGist, cleanPrompt, isWeak, condense } from './core/conversation-search.js';
import { writeDashboardContext, readAgentSearch, readScratchOpen, isScratchPath, newScratchFile, notepadFile, newNoteFile, recordNote, listNotes, readCockpitLaunches, readCockpitInjects } from './core/dashboard-bridge.js';
import { commitNotesSoon, noteHistory, noteRevisionContent, restoreNoteRevision } from './core/notes-git.js';
import { captureScreenshot } from './core/screenshot.js';
import { createWorktree } from './core/worktree.js';
import { readDaemonCache } from './core/background.js';
import { getClaudeProjectsDir, normalizePathForCompare, openUrl, getPlatform, openInExplorer, isCommandAvailable, shellOpenFile, isExecutableFile } from './core/platform.js';
import { listAgents, agentCommand } from './core/agents.js';
import { listProviderProfiles } from './core/providers.js';
import { readClaudeTier, getTierLabel, probeRateLimits, getCachedRateLimits, formatResetEpoch } from './core/claude-usage.js';
import { launchAndTrack, getCleanEnv } from './core/launcher.js';
import { getControlDir, hasControlHistory, ensureControlWorkspace, getLatestControlActivity } from './core/control.js';
import { log, initLogger } from './core/logger.js';
import type { RateLimitInfo } from './core/claude-usage.js';

// `require` is injected by the tsup banner (createRequire) into every output
// file — used to load the native/runtime-external modules (node-pty, ws) and to
// resolve vendored xterm assets. Declared here so TypeScript accepts it in ESM.
declare const require: NodeRequire;

const RATE_PROBE_TTL_MS = 5 * 60_000;
let lastProbeAt = 0;
let lastProbe: RateLimitInfo | null = null;
// Newer published version (or null) from the startup/heartbeat update check;
// surfaced in the overview payload as an "update available" pill.
let latestUpdate: string | null = null;
// Demo mode (`cc serve --demo`) — synthetic data (well-known OSS repos) instead
// of the user's real projects; for marketing/screenshots. Set at startup.
let DEMO = false;

// Server identity — stamped into /api/overview so a probe can POSITIVELY confirm
// "this is a CLD CTRL server" before ever issuing a destructive stop/kill (a
// foreign 200-JSON service on this port must never be mistaken for us). PRODUCT
// gates the fallback port-owner kill; INSTANCE_ID lets a restart supervisor tell
// the OLD process apart from its freshly-spawned successor on the same port.
const PRODUCT = 'cldctrl';
const PROTOCOL_VERSION = 2;
const INSTANCE_ID = randomUUID();
/** The identity markers stamped into both /api/id and /api/overview — one source
 *  so the two payloads can't drift. */
function serverIdentity(): { product: string; protocolVersion: number; instanceId: string; version: string } {
  return { product: PRODUCT, protocolVersion: PROTOCOL_VERSION, instanceId: INSTANCE_ID, version: VERSION };
}

// Build identity — the content hash the build writes to dist/build-manifest.json.
// We snapshot it at startup (runningBuildId) and re-read the on-disk manifest on a
// slow timer; when it differs, a NEWER build has landed and the dashboard offers
// "restart to load". This is what turns "I rebuilt but my changes aren't showing"
// into a visible prompt instead of a silent stale server.
let runningBuildId: string | null = null;
let buildUpdateReady = false;
function readDiskBuildId(): string | null {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8'))?.buildId ?? null;
  } catch { return null; }
}

async function getRateLimits(): Promise<RateLimitInfo | null> {
  // Re-probe when our last probe is older than the TTL (the 5h window moves and
  // resets — a once-at-startup value goes badly stale, e.g. showing 12% while the
  // 5h window is actually at 97%). probeRateLimits has its own fresh-cache short
  // circuit, so calling it past the TTL is cheap when nothing changed.
  if (Date.now() - lastProbeAt < RATE_PROBE_TTL_MS) {
    return lastProbe ?? getCachedRateLimits();
  }
  lastProbeAt = Date.now();
  try {
    lastProbe = await probeRateLimits();
  } catch {
    lastProbe = null;
  }
  // Fall back to the last known value on a failed/empty probe rather than null.
  return lastProbe ?? getCachedRateLimits();
}

/** Format a Date as YYYY-MM-DD in local time (matches usage.ts bucketing). */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Aggregate the daemon cache's per-project daily usage into a single
 * last-`days` token series ending today. Zero parsing cost — reads the cache
 * the daemon already maintains. Missing days are filled with 0.
 */
function aggregateDaily(
  byProject: Record<string, Array<Record<string, any>>> | undefined,
  days: number,
  field: 'tokens' | 'commits',
): Array<{ date: string; value: number }> {
  const totals = new Map<string, number>();
  if (byProject) {
    for (const list of Object.values(byProject)) {
      for (const d of list) totals.set(d.date, (totals.get(d.date) ?? 0) + (Number(d[field]) || 0));
    }
  }
  const out: Array<{ date: string; value: number }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(now);
    dt.setDate(now.getDate() - i);
    const key = localDateStr(dt);
    out.push({ date: key, value: totals.get(key) ?? 0 });
  }
  return out;
}

function aggregateDailyTokens(
  byProject: Record<string, Array<{ date: string; tokens: number }>> | undefined,
  days: number,
): Array<{ date: string; value: number }> {
  return aggregateDaily(byProject, days, 'tokens');
}

// Fallback daily-usage cache: when the daemon isn't running (no usageByProject
// in the daemon cache), compute the series directly but only every few minutes —
// getDailyUsageByProject parses session files, so we never do it per-poll.
const DAILY_TTL_MS = 5 * 60_000;
let dailyComputedAt = 0;
let dailyComputed: Array<{ date: string; value: number }> = [];

async function getDailyTokens(
  cacheUsage: Record<string, Array<{ date: string; tokens: number }>> | undefined,
): Promise<Array<{ date: string; value: number }>> {
  if (cacheUsage && Object.keys(cacheUsage).length > 0) {
    return aggregateDailyTokens(cacheUsage, 28);
  }
  if (Date.now() - dailyComputedAt < DAILY_TTL_MS && dailyComputed.length) {
    return dailyComputed;
  }
  dailyComputedAt = Date.now();
  try {
    const byProject = await getDailyUsageByProject(28);
    dailyComputed = aggregateDailyTokens(byProject, 28);
  } catch {
    dailyComputed = aggregateDailyTokens(undefined, 28);
  }
  return dailyComputed;
}

/** Make a file path relative to its project (forward slashes) for display. */
function relativeToProject(filePath: string, projectPath: string): string {
  if (normalizePathForCompare(filePath).startsWith(normalizePathForCompare(projectPath))) {
    return filePath.slice(projectPath.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
  }
  return filePath.replace(/\\/g, '/');
}

/** Dominant model from a session's model counts, shortened (e.g. "opus 4.8"). */
function dominantModel(models: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of Object.entries(models)) {
    if (count > bestCount) { best = model; bestCount = count; }
  }
  if (!best) return null;
  return best
    .replace(/^claude-/, '')
    .replace(/-(\d{8}|\d{1,2}m)$/i, '')
    .replace(/-(\d)-(\d)/, ' $1.$2')
    .replace(/-/g, ' ');
}

/** True context window for the meter denominator. Model ids don't encode the 1M
 *  beta (e.g. `claude-opus-4-8` runs either 200k or 1M), so we infer it: any turn
 *  that exceeded 200k can ONLY exist on the 1M window — that's proof, not a guess.
 *  Falls back to the model-name "1m" tag, else 200k. */
function contextWindowFor(model: string | null, peak?: number): number {
  if ((peak ?? 0) > 200_000) return 1_000_000;
  if (model && /\b1m\b|1m]|-1m/i.test(model)) return 1_000_000;
  return 200_000;
}

// ── Session file map (server-side only — clients never send paths) ──

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const sessionFileMap = new Map<string, string>(); // sessionId -> JSONL path

// ── Overview payload ─────────────────────────────────────────

async function buildOverview(): Promise<unknown> {
  // NB: demo mode is handled by the inert-guard at the router (serve-demo.ts);
  // this real path never runs under --demo.
  fillDiscoveredSessions(); // match live 'new' tiles to the session ids their agents wrote
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const cache = readDaemonCache();
  const tier = readClaudeTier();

  const nameMap = new Map<string, string>();
  for (const p of projects) nameMap.set(normalizePathForCompare(p.path), p.name);

  const sessions = await getActiveClaudeProcesses(projects.map(p => p.path));
  for (const s of sessions) {
    try {
      if (s.sessionFilePath) {
        if (s.sessionId) sessionFileMap.set(s.sessionId, s.sessionFilePath);
        const info = await getActiveSessionInfo(s.sessionFilePath);
        if (info) {
          s.stats = info.stats;
          if (info.currentAction) s.currentAction = info.currentAction;
        }
      }
    } catch { /* serve without enrichment */ }
  }
  sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  const windowed = await getRollingUsageWindowed(getClaudeProjectsDir());
  const rate = await getRateLimits();
  const codexRate = (await import('./core/codex-stats.js')).getCodexRateLimitCached(Date.now());
  const daily = await getDailyTokens(cache?.usageByProject);

  const activePaths = new Set(sessions.map(s => normalizePathForCompare(s.projectPath)));

  // Recent Codex conversations, folded into the sidebar list (vendor:'codex').
  // Gated to KNOWN projects so the existing /ws/term path validation stays intact
  // and the list stays project-scoped. Cheap (cached in codex-stats).
  const codexSessions = (() => {
    try {
      const { listRecentCodexSessions } = require('./core/codex-stats.js') as typeof import('./core/codex-stats.js');
      return listRecentCodexSessions(Date.now(), 24 * 3600_000, 30)
        .map((c) => {
          const proj = resolveKnownProject(c.cwd);
          if (!proj) return null; // unregistered dir → skip (keeps resume valid)
          return {
            id: c.sessionId,
            project: proj.name,
            path: proj.path,
            vendor: 'codex' as const,
            status: 'idle' as const, // Codex sessions aren't live-detected — they're resumable
            currentAction: null,
            lastActivity: new Date(c.lastTs).toISOString(),
            tokens: 0, messages: 0, assistantTurns: 0, toolCalls: 0, contextSize: 0,
          };
        })
        .filter(Boolean)
        .slice(0, 12);
    } catch { return []; }
  })();

  // Recent Antigravity (`agy`) conversations — same treatment as Codex (known-
  // project gated; vendor:'antigravity'). Reads the SQLite .db store via the
  // built-in node:sqlite; no-ops on older Node / no ~/.gemini.
  const antigravitySessions = (() => {
    try {
      const { listRecentAntigravitySessions } = require('./core/antigravity-sessions.js') as typeof import('./core/antigravity-sessions.js');
      return listRecentAntigravitySessions(Date.now(), 24 * 3600_000, 20)
        .map((a) => {
          const proj = resolveKnownProject(a.cwd);
          if (!proj) return null;
          return {
            id: a.sessionId, project: proj.name, path: proj.path,
            vendor: 'antigravity' as const, status: 'idle' as const, currentAction: null,
            lastActivity: new Date(a.lastTs).toISOString(),
            tokens: 0, messages: 0, assistantTurns: 0, toolCalls: 0, contextSize: 0,
          };
        })
        .filter(Boolean)
        .slice(0, 12);
    } catch { return []; }
  })();

  return {
    ...serverIdentity(),
    updateAvailable: latestUpdate,
    buildUpdateReady,
    generatedAt: new Date().toISOString(),
    tier: getTierLabel(tier),
    features: {
      agentTerminal: AGENT_TERMINAL_AVAILABLE,
      agents: listAgents(),
      providers: listProviderProfiles(),
      openExplorer: config.launch?.explorer !== false,
      openVscode: config.launch?.vscode !== false && isCommandAvailable('code'),
    },
    usage: {
      fiveHour: {
        tokens: windowed.fiveHour.tokens,
        messages: windowed.fiveHour.messages,
        percent: rate && rate.fiveHourUtil >= 0 ? Math.round(rate.fiveHourUtil * 1000) / 10 : null,
        resetIn: rate ? (rate.fiveHourReset > 0 ? formatResetEpoch(rate.fiveHourReset) : rate.fiveHourResetIn) : null,
      },
      sevenDay: {
        tokens: windowed.sevenDay.tokens,
        messages: windowed.sevenDay.messages,
        percent: rate && rate.sevenDayUtil >= 0 ? Math.round(rate.sevenDayUtil * 1000) / 10 : null,
        resetIn: rate ? (rate.sevenDayReset > 0 ? formatResetEpoch(rate.sevenDayReset) : rate.sevenDayResetIn) : null,
      },
      live: rate !== null,
      overage: rate && rate.overageUtil > 0 ? {
        percent: Math.round(rate.overageUtil * 1000) / 10,
        status: rate.overageStatus,
        resetIn: rate.overageReset > 0 ? formatResetEpoch(rate.overageReset) : rate.overageResetIn,
      } : null,
      codex: codexRate ? {
        tokens: 0,
        messages: 0,
        percent: Math.round(codexRate.usedPercent * 10) / 10,
        resetIn: codexRate.resetsInSeconds ? formatResetEpoch(Math.floor(Date.now() / 1000) + codexRate.resetsInSeconds) : null,
      } : null,
      daily,
      dailyCommits: aggregateDaily(cache?.commitActivity, 28, 'commits'),
    },
    bridge: readAgentSearch(),
    cockpitLaunches: readCockpitLaunches(),
    cockpitInjects: readCockpitInjects(),
    // tileId -> the sessionId its 'new' agent created, so the client can persist it
    // and resume the SAME conversation after a restart (no manual /resume).
    terminalSessions: Object.fromEntries([...terminals.entries()].filter(([, s]) => s.discoveredSessionId).map(([id, s]) => [id, s.discoveredSessionId!])),
    scratch: readScratchOpen(),
    // CTRL chat lifecycle: last control activity drives the daily fresh-vs-continue
    // decision; the running control session id (once claude writes its JSONL) rides
    // along in terminalSessions['control'] via control discovery below.
    control: { lastActivity: getLatestControlActivity() || null },
    sessions: [...sessions.map(s => ({
      id: s.sessionId || null,
      project: nameMap.get(normalizePathForCompare(s.projectPath)) ?? path.basename(s.projectPath),
      path: s.projectPath,
      vendor: 'claude' as const,
      status: (s.idle ? 'idle' : 'active') as 'idle' | 'active',
      currentAction: s.currentAction ?? null,
      lastActivity: s.lastActivity.toISOString(),
      tokens: s.stats.tokens,
      messages: s.stats.messages,
      assistantTurns: s.stats.assistantTurns,
      toolCalls: s.stats.toolCalls.reads + s.stats.toolCalls.writes + s.stats.toolCalls.bash + s.stats.toolCalls.other,
      contextSize: s.stats.lastContextSize,
      contextWindow: contextWindowFor(dominantModel(s.stats.models), s.stats.maxContextSize),
      durationMs: s.stats.duration,
      model: dominantModel(s.stats.models),
      files: (s.stats.touchedFiles ?? []).slice(0, 60).map(f => ({
        path: relativeToProject(f.path, s.projectPath),
        reads: f.reads,
        writes: f.writes,
        lastTs: f.lastTs,
      })),
    })), ...codexSessions, ...antigravitySessions],
    projects: projects.map(p => {
      const git = cache?.gitStatuses?.[p.path] ?? null;
      return {
        name: p.name,
        path: p.path,
        active: activePaths.has(normalizePathForCompare(p.path)),
        branch: git?.branch ?? null,
        dirty: git?.dirty ?? 0,
        ahead: git?.ahead ?? 0,
        group: projectGroup(config, p.name, p.path),
      };
    }),
  };
}

// ── Transcript tail ──────────────────────────────────────────

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 30;
const MAX_ENTRY_CHARS = 600;

interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

interface TranscriptTail {
  entries: TranscriptEntry[];
  /** Context occupancy of the LAST assistant turn (cacheRead + input + cacheWrite),
   *  same formula as activity.ts lastContextSize — feeds the restore picker's meter. */
  contextSize: number;
  model: string | null;
}

/** Extract the last ~30 conversational turns from a session JSONL. */
function readTranscriptTail(filePath: string): TranscriptTail {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
  const buf = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }

  let lines = buf.toString('utf-8').split('\n');
  if (start > 0) lines = lines.slice(1); // first line may be partial

  const entries: TranscriptEntry[] = [];
  let contextSize = 0;
  let model: string | null = null;
  const push = (role: TranscriptEntry['role'], text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    entries.push({ role, text: t.length > MAX_ENTRY_CHARS ? t.slice(0, MAX_ENTRY_CHARS - 1) + '…' : t });
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      if (typeof c === 'string') {
        if (!c.startsWith('<')) push('user', c); // skip meta/tool-result markup
      } else if (Array.isArray(c)) {
        const text = c.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text).join(' ');
        if (text && !text.startsWith('<')) push('user', text);
      }
    } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const u = obj.message.usage;
      if (u) {
        const turnCtx = (u.cache_read_input_tokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (turnCtx > 0) contextSize = turnCtx;
      }
      if (obj.message.model) model = obj.message.model;
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          push('assistant', block.text);
        } else if (block.type === 'tool_use' && block.name) {
          const file = block.input?.file_path ?? block.input?.path;
          const fileName = file ? ` ${String(file).split(/[/\\]/).pop()}` : '';
          push('tool', `${block.name}${fileName}`);
        }
      }
    }
  }

  return { entries: entries.slice(-MAX_TRANSCRIPT_ENTRIES), contextSize, model };
}

async function handleTranscript(sessionId: string): Promise<{ status: number; body: unknown }> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return { status: 400, body: { error: 'Invalid session id' } };
  }
  // Refresh the map if the id is unknown (e.g. server restarted)
  if (!sessionFileMap.has(sessionId)) {
    const { config } = loadConfig();
    const projects = buildProjectListFast(config);
    const sessions = await getActiveClaudeProcesses(projects.map(p => p.path));
    for (const s of sessions) {
      if (s.sessionId && s.sessionFilePath) sessionFileMap.set(s.sessionId, s.sessionFilePath);
    }
  }
  // Dead-session fallback (restore picker peeks at yesterday's conversations):
  // scan the Claude projects dir directly — active-session detection won't find
  // sessions older than the 5h window.
  if (!sessionFileMap.has(sessionId)) {
    const { resolveClaudeSession } = await import('./core/handoff.js');
    const r = resolveClaudeSession(sessionId);
    if (r) sessionFileMap.set(sessionId, r.file);
  }
  const filePath = sessionFileMap.get(sessionId);
  if (!filePath) return { status: 404, body: { error: 'Session not found' } };
  try {
    const tail = readTranscriptTail(filePath);
    return { status: 200, body: { entries: tail.entries, contextSize: tail.contextSize, model: tail.model } };
  } catch (err) {
    log('error', { function: 'handleTranscript', message: String(err) });
    return { status: 500, body: { error: 'Failed to read transcript' } };
  }
}

// ── Launch ───────────────────────────────────────────────────

async function handleLaunch(body: { path?: string; prompt?: string; resume?: string }): Promise<{ status: number; body: unknown }> {
  if (typeof body.path !== 'string') {
    return { status: 400, body: { error: 'Missing project path' } };
  }
  if (body.resume !== undefined && !SAFE_SESSION_ID.test(String(body.resume))) {
    return { status: 400, body: { error: 'Invalid session id' } };
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 2000).trim() : undefined;

  // Only launch projects cldctrl already knows — never arbitrary client paths
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const target = projects.find(p => normalizePathForCompare(p.path) === normalizePathForCompare(body.path!));
  if (!target) return { status: 404, body: { error: 'Unknown project' } };

  const result = launchAndTrack({
    projectPath: target.path,
    isNew: !body.resume,
    sessionId: body.resume,
    prompt: prompt || undefined,
  });
  log('serve_launch', { project: target.name, resume: body.resume ?? null, ok: result.success });
  return { status: result.success ? 200 : 500, body: { success: result.success, message: result.message, project: target.name } };
}

// ── Project detail (commits / issues / files / sessions) ─────
// Fetched on tab-open, never on the 3s poll. git/gh are expensive, so results
// are memoized briefly to keep rapid tab-switching cheap.

/** Resolve a client-supplied path to a project cldctrl already knows, or null. */
function resolveKnownProject(p: string): { name: string; path: string } | null {
  if (!p) return null;
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  return projects.find(pr => normalizePathForCompare(pr.path) === normalizePathForCompare(p)) ?? null;
}

/** Find the known project that CONTAINS this path (for opening files inside a
 *  project, not just project roots). Normalizes separators + case. */
function resolveProjectForFile(p: string): { name: string; path: string } | null {
  if (!p) return null;
  const norm = (x: string) => normalizePathForCompare(x).replace(/\\/g, '/').replace(/\/+$/, '');
  const np = norm(p);
  const { config } = loadConfig();
  return buildProjectListFast(config).find(pr => { const root = norm(pr.path); return np === root || np.startsWith(root + '/'); }) ?? null;
}

const DETAIL_TTL_MS = 20_000;
const detailMemo = new Map<string, { at: number; data: unknown }>();
async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = detailMemo.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.data as T;
  const data = await fn();
  detailMemo.set(key, { at: Date.now(), data });
  return data;
}

/** Best available human-readable title for a session. Order: a (condensed)
 *  generated rich summary → Claude's own index summary → a gist derived from
 *  the session's prompts → a cleaned first prompt. */
function pickSummary(s: { richSummary?: string; summary?: string; firstPrompt?: string }, gist: string): string {
  const rich = (s.richSummary || '').trim();
  if (rich.length > 12) return condense(rich);
  const idx = (s.summary || '').trim();
  if (idx && !isWeak(idx)) return idx;
  if (gist) return gist;
  const fp = cleanPrompt(s.firstPrompt);
  if (fp && !isWeak(fp)) return fp;
  return gist || idx || fp || '(untitled session)';
}

interface ControlSessionSummary { id: string; summary: string; firstPrompt: string | null; modified: string; tokens: number; messages: number; }

/** Past CTRL conversations for the history dropdown. Registers each JSONL path
 *  in sessionFileMap so /api/transcript + read-aloud work on historical control
 *  chats. getRecentSessions only scans Claude session files, so the workspace's
 *  CLAUDE.md / tasks.json / recaps never appear as conversations. */
/** CTRL chats often open with a slash-command whose prompt is an XML-ish
 *  caveat/command wrapper — strip those so dropdown labels read cleanly. */
function cleanControlSummary(s: string): string {
  // A slash-command start → label with the command name (e.g. "/compact").
  const cmd = s.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/i);
  if (cmd) return '/' + cmd[1].trim();
  const t = s.replace(/<\/?[a-z-]+>/gi, ' ').replace(/\s+/g, ' ').trim();
  // Local-command caveat boilerplate (possibly truncated) has no usable human
  // summary → signal the caller to fall back to a generic date-labeled entry.
  if (/messages below were generated|Caveat:|DO NOT respond to these messages/i.test(t)) return '';
  return t.length > 3 ? t : '';
}

async function listControlSessions(limit = 20): Promise<ControlSessionSummary[]> {
  const sessions = await getRecentSessions(getControlDir(), limit);
  for (const s of sessions) { if (s.id && s.filePath) sessionFileMap.set(s.id, s.filePath); }
  return sessions.map((s) => ({
    id: s.id,
    summary: cleanControlSummary(pickSummary(s, deriveGist(s.id))) || 'CTRL conversation',
    firstPrompt: cleanControlSummary(cleanPrompt(s.firstPrompt) || '') || null,
    modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
    tokens: s.stats?.tokens ?? 0,
    messages: s.stats?.messages ?? 0,
  }));
}

async function handleProjectDetail(tab: string, rawPath: string, rawDir: string): Promise<{ status: number; body: unknown }> {
  const proj = resolveKnownProject(rawPath);
  if (!proj) return { status: 404, body: { error: 'Unknown project' } };
  try {
    if (tab === 'commits') {
      const commits = await memo('c:' + proj.path, () => getRecentCommits(proj.path, 15));
      return { status: 200, body: { commits } };
    }
    if (tab === 'issues') {
      if (!isGhAvailable()) return { status: 200, body: { issues: [], ghAvailable: false, installUrl: getGhInstallUrl() } };
      const issues = await memo('i:' + proj.path, () => getIssues(proj.path));
      return { status: 200, body: { issues, ghAvailable: true } };
    }
    if (tab === 'activity') {
      const usage = await memo('au:' + proj.path, () => getDailyUsageByProject(28));
      const key = Object.keys(usage).find(k => normalizePathForCompare(k) === normalizePathForCompare(proj.path));
      const tokens = aggregateDaily({ p: key ? usage[key] : [] }, 28, 'tokens');
      const commitsRaw = await memo('ca:' + proj.path, () => getCommitDailyActivity(proj.path, 28));
      const commits = aggregateDaily({ p: commitsRaw }, 28, 'commits');
      return { status: 200, body: { tokens, commits } };
    }
    if (tab === 'sessions') {
      const sessions = await getRecentSessions(proj.path, 14);
      // Register file paths so /api/transcript can drill into historical sessions.
      for (const s of sessions) { if (s.id && s.filePath) sessionFileMap.set(s.id, s.filePath); }
      return { status: 200, body: { sessions: sessions.map(s => ({
        id: s.id,
        summary: pickSummary(s, deriveGist(s.id)),
        firstPrompt: cleanPrompt(s.firstPrompt) || null,
        modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
        branch: s.gitBranch ?? null,
        tokens: s.stats?.tokens ?? 0,
        messages: s.stats?.messages ?? 0,
        cost: s.cost ?? null,
      })) } };
    }
    if (tab === 'files') {
      const target = path.resolve(proj.path, rawDir || '');
      if (target !== proj.path && !target.startsWith(proj.path + path.sep)) {
        return { status: 403, body: { error: 'Forbidden' } };
      }
      const isIgnored = parseGitignore(proj.path);
      const nodes = readDirectory(target, proj.path, isIgnored)
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
        .slice(0, 400)
        .map(n => ({
          name: n.name,
          relativePath: n.relativePath.replace(/\\/g, '/'),
          type: n.type,
          fileIcon: n.fileIcon,
          iconColor: n.iconColor ?? null,
          isClaude: !!n.isClaude,
          childCount: n.childCount ?? null,
        }));
      return { status: 200, body: { dir: (rawDir || '').replace(/\\/g, '/'), nodes } };
    }
    return { status: 404, body: { error: 'Unknown tab' } };
  } catch (err) {
    log('error', { function: 'handleProjectDetail', tab, message: String(err) });
    return { status: 500, body: { error: 'Failed to load ' + tab } };
  }
}

// ── File read/write (for cockpit doc tiles) ──────────────────
// Restricted to files inside a known project; text only, size-capped.
const FILE_CAP = 5 * 1024 * 1024;
const IMAGE_CAP = 25 * 1024 * 1024; // screenshots/figures can outgrow FILE_CAP
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
function normSlash(s: string): string { return s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''); }

function fileInKnownProject(filePath: string): boolean {
  if (isScratchPath(filePath)) return true; // cldctrl scratchpads are always allowed
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const f = normSlash(filePath);
  return projects.some((p) => { const pp = normSlash(p.path); return f === pp || f.startsWith(pp + '/'); });
}

function handleReadFile(filePath: string): { status: number; body: unknown } {
  if (!filePath || !fileInKnownProject(filePath)) return { status: 403, body: { error: 'Path is not inside a known project' } };
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { status: 404, body: { error: 'Not a file' } };
    if (st.size > FILE_CAP) return { status: 413, body: { error: 'File too large' } };
    return { status: 200, body: { path: filePath, content: fs.readFileSync(filePath, 'utf-8'), mtime: st.mtimeMs } };
  } catch { return { status: 404, body: { error: 'Not found' } }; }
}

function handleWriteFile(body: { path?: string; content?: string }): { status: number; body: unknown } {
  const filePath = typeof body.path === 'string' ? body.path : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (!filePath || content === null) return { status: 400, body: { error: 'path and content are required' } };
  if (!fileInKnownProject(filePath)) return { status: 403, body: { error: 'Path is not inside a known project' } };
  if (content.length > FILE_CAP) return { status: 413, body: { error: 'Content too large' } };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { status: 200, body: { ok: true, mtime: fs.statSync(filePath).mtimeMs } };
  } catch (e) { return { status: 500, body: { error: String(e) } }; }
}

// ── Request plumbing ─────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** DNS-rebinding guard: the Host must be EXACTLY a loopback name (not merely
 *  prefixed by one — `localhost.attacker.com` must NOT pass). */
function isLocalHost(req: http.IncomingMessage): boolean {
  const raw = (req.headers.host ?? '').toLowerCase().trim();
  // Strip the port, but keep the colons inside a bracketed IPv6 literal.
  const host = raw.startsWith('[') ? raw.replace(/\]:\d+$/, ']') : raw.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(host);
}

/** WebSocket CSRF defense. Browsers ALWAYS send Origin on a WS handshake and
 *  cannot set custom headers there, so the JSON APIs' `X-CLDCTRL` guard can't
 *  protect `/ws/*`. A drive-by page sends its own (non-local) Origin → rejected.
 *  A non-browser local client sends no Origin and still passes the Host guard. */
function isLocalWsOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser-driven cross-site request
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false; // malformed Origin → reject
  }
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── HTML page ────────────────────────────────────────────────

const SHELL = `<!doctype html>
<html lang="en" data-theme="daylight">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f6fa">
<script>
// Pre-paint theme: apply the SAVED theme before first render so (a) there's no
// flash of the wrong theme and (b) Chromium samples the CORRECT theme-color at
// window creation — app-window titlebars read it at birth, so setting it only
// after boot left light-theme windows with a black titlebar (and vice versa).
// The bg values MUST match the per-theme --bg in web/app.css.
(function(){try{
  var t=localStorage.getItem('cldctrl-theme')||'daylight';
  var bg={midnight:'#070a10',daylight:'#f4f6fa',paper:'#f3efe7'}[t]||'#f4f6fa';
  if(t==='midnight')document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme',t);
  document.querySelector('meta[name="theme-color"]').setAttribute('content',bg);
}catch(e){}})();
</script>
<title>⌃ CLD CTRL</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="any">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="stylesheet" href="/vendor/xterm.css">
<link rel="stylesheet" href="/web/app.css">
</head>
<body>
<div id="app"><div class="loading">Loading dashboard…</div></div>
<div id="cockpit"><div id="cockpit-grid" class="cockpit-grid cols2"></div></div>
<div id="stats"><div id="stats-body"></div></div>
<div id="lb"><span class="lb-close">✕</span><button class="lb-nav lb-prev" aria-label="Previous image">‹</button><div id="lb-imgs"></div><button class="lb-nav lb-next" aria-label="Next image">›</button><div class="lb-count"></div></div>
<div id="toast"></div>
<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script type="module" src="/web/app.js"></script>
</body>
</html>`;

// ── Docked agent terminal (xterm in browser ↔ node-pty here) ──

/** Resolve a file inside an installed package by climbing from its main entry. */
function resolvePkgFile(spec: string, rel: string): string | null {
  try {
    let dir = path.dirname(require.resolve(spec));
    for (let i = 0; i < 6; i++) {
      const cand = path.join(dir, rel);
      if (fs.existsSync(cand)) return cand;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* dependency not installed */ }
  return null;
}

const XTERM_JS = resolvePkgFile('@xterm/xterm', 'lib/xterm.js');
const XTERM_CSS = resolvePkgFile('@xterm/xterm', 'css/xterm.css');
const FIT_JS = resolvePkgFile('@xterm/addon-fit', 'lib/addon-fit.js');
// KaTeX (math in the notepad/doc previews) — lazy-loaded by the client only when
// a preview actually contains $…$ math, so normal dashboards never fetch it.
const KATEX_JS = resolvePkgFile('katex', 'dist/katex.min.js');
const KATEX_AUTO = resolvePkgFile('katex', 'dist/contrib/auto-render.min.js');
const KATEX_CSS = resolvePkgFile('katex', 'dist/katex.min.css');
const KATEX_FONTS = resolvePkgFile('katex', 'dist/fonts');
// node-pty is an OPTIONAL native dep: if its prebuilt binary isn't available for
// this platform/Node, the rest of the dashboard still works — only live terminals
// are disabled. Probe once so the client (features.agentTerminal) hides terminal
// UI cleanly instead of offering tiles that fail to spawn.
const NODE_PTY_AVAILABLE = (() => { try { require('node-pty'); return true; } catch { return false; } })();
const AGENT_TERMINAL_AVAILABLE = !!(XTERM_JS && XTERM_CSS && FIT_JS && NODE_PTY_AVAILABLE);

function serveStaticFile(res: http.ServerResponse, filePath: string | null, type: string): void {
  if (!filePath || !fs.existsSync(filePath)) { sendJson(res, 404, { error: 'Not found' }); return; }
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

// The bundled dashboard assets (app.js/app.css + sourcemaps) live in dist/web/,
// a sibling of this compiled module. Served read-only with a path-traversal guard.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
// Bundled raster app icon (package root). Chrome/Edge --app windows use a raster
// favicon for the window/taskbar icon (an SVG favicon isn't enough there).
const ICO_PATH = path.join(WEB_DIR, '..', '..', 'cldctrl.ico');
const ASSETS_DIR = path.join(WEB_DIR, '..', '..', 'assets'); // brand PNGs for the manifest
// Web app manifest → gives Chrome/Edge --app (and PWA install) a real cldctrl
// identity + icon, instead of inheriting the browser's taskbar icon.
const MANIFEST = JSON.stringify({
  name: 'CLD CTRL', short_name: 'CLD CTRL', start_url: '/?app=1', scope: '/',
  display: 'standalone', background_color: '#070a10', theme_color: '#e87632',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});
const WEB_TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

function serveWebAsset(res: http.ServerResponse, pathname: string): void {
  const rel = pathname.replace(/^\/web\//, '');
  const resolved = path.resolve(WEB_DIR, rel);
  if (resolved !== WEB_DIR && !resolved.startsWith(WEB_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const type = WEB_TYPES[path.extname(resolved)] ?? 'application/octet-stream';
  // no-cache (revalidate every load) so a rebuilt bundle shows up without a hard
  // refresh — these are tiny localhost fetches, so the cost is negligible.
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

// Named-terminal registry. Each PTY (the control-plane agent, or a resumed
// conversation in the cockpit) is shared across browser tabs and survives
// reload: reconnecting clients get a replay of recent output, and a terminal is
// only killed once no client has been attached for IDLE_KILL_MS. Keyed by id —
// 'control' for the dock agent, 'resume:<sessionId>' for cockpit conversations.
const REPLAY_CAP_BYTES = 256 * 1024;
const IDLE_KILL_MS = 10 * 60_000;
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

interface TermMeta { kind: 'control' | 'resume' | 'new'; sessionId?: string; projectPath?: string; agent?: string; prompt?: string; vendor?: 'claude' | 'codex' | 'antigravity'; }

// The port this dashboard is serving on, stamped into every PTY's env as
// CLDCTRL_DASHBOARD_PORT so an MCP server running inside the dock/cockpit knows
// it's in the web surface (and routes new launches to the cockpit, not a terminal).
let dashboardPort = 0;
interface TermSession {
  meta: TermMeta;
  term: any;                                   // node-pty instance
  clients: Set<any>;                           // attached WebSockets
  buffer: string;                              // recent output, capped, for replay
  idleTimer: ReturnType<typeof setTimeout> | null;
  spawnedAt?: number;                          // for 'new' tiles: when we spawned (to match the session file)
  cwd?: string;                                // for 'new' tiles: the agent's cwd (to find its session dir)
  discoveredSessionId?: string;                // for 'new' tiles: the sessionId claude created (so restore can --resume it)
}

/** For each live 'new' terminal we haven't yet matched, look for the session JSONL
 *  the agent wrote in its cwd's slug dir (newest file created at/after spawn). Run
 *  lazily on each overview poll — an idle `claude` doesn't write its session file
 *  until the first turn, so a one-shot poll-at-spawn would miss it. */
function fillDiscoveredSessions(): void {
  // ids already matched to a tile — never claim the same session for two tiles.
  // Include live resume: terminals' OWN session ids: `claude --resume` touches
  // that JSONL, so an undiscovered 'new' tile in the same project would otherwise
  // "discover" a conversation that already belongs to another tile.
  const claimed = new Set<string>();
  for (const s of terminals.values()) {
    if (s.discoveredSessionId) claimed.add(s.discoveredSessionId);
    if (s.meta.sessionId) claimed.add(s.meta.sessionId);
  }
  for (const s of terminals.values()) {
    const isCtrl = s.meta.kind === 'control';
    if ((s.meta.kind !== 'new' && !isCtrl) || s.discoveredSessionId || !s.cwd) continue;
    let dir: string; try { dir = getSessionDir(s.cwd); } catch { continue; }
    // 'new' tiles match a file created at/after spawn; CTRL resumes-or-creates the
    // NEWEST control session, so take the newest unclaimed file regardless of time.
    const after = isCtrl ? 0 : (s.spawnedAt ?? 0) - 4000; // clock-skew buffer
    try {
      const cand = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ id: f.slice(0, -6), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .filter((x) => x.m >= after && !claimed.has(x.id))
        .sort((a, b) => b.m - a.m)[0];
      if (cand) { s.discoveredSessionId = cand.id; claimed.add(cand.id); log('serve_term', { event: 'session_discovered', id: cand.id }); }
    } catch { /* dir not created until the agent writes its first line */ }
  }
  // Persist newly-discovered ids so a restart can rehydrate 'new' tiles whose
  // sessionId the browser hadn't yet polled (see captureTermSessions).
  captureTermSessions();
}
const terminals = new Map<string, TermSession>();

// ── 'new'-tile resume persistence ────────────────────────────
// A freshly-launched agent tile is keyed `new:<uuid>` and only becomes resumable
// once we've discovered the sessionId the agent wrote (fillDiscoveredSessions).
// The browser learns that id from the overview poll and, on reconnect after a
// PTY death, passes it back as `session=` so we `--resume` instead of spawning a
// fresh agent. That leaves a RACE across a server restart: if the tile was
// launched seconds before the restart, the browser may not have polled the id
// yet, so its reconnect carries no `session=` and the conversation is lost.
//
// Fix: persist tileId -> resume info to disk (keyed by the SAME `new:<uuid>` the
// browser reconnects with). A final capture runs synchronously at shutdown after
// a forced discovery pass, so the successor server can resume the tile even when
// the browser never learned its sessionId. Entries are pruned by age/count.
interface PersistedTermSession { sessionId: string; cwd?: string; vendor?: string; agent?: string; savedAt: number; }
const TERM_SESSIONS_TTL_MS = 7 * 24 * 60 * 60_000; // a week — resumes get stale
const TERM_SESSIONS_MAX = 200;
let persistedTermSessions: Record<string, PersistedTermSession> = {};
function termSessionsFile(): string { return path.join(getConfigDir(), 'terminal-sessions.json'); }

function loadPersistedTermSessions(): void {
  try {
    const j = JSON.parse(fs.readFileSync(termSessionsFile(), 'utf-8'));
    if (j && typeof j === 'object') {
      const cutoff = Date.now() - TERM_SESSIONS_TTL_MS;
      persistedTermSessions = {};
      for (const [k, v] of Object.entries(j as Record<string, PersistedTermSession>)) {
        if (v && typeof v.sessionId === 'string' && typeof v.savedAt === 'number' && v.savedAt >= cutoff) {
          persistedTermSessions[k] = v;
        }
      }
    }
  } catch { /* none yet / unreadable — start empty */ }
}

function savePersistedTermSessions(): void {
  // Cap to the most-recent MAX entries so the file can't grow without bound.
  const entries = Object.entries(persistedTermSessions).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, TERM_SESSIONS_MAX);
  persistedTermSessions = Object.fromEntries(entries);
  try { fs.writeFileSync(termSessionsFile(), JSON.stringify(persistedTermSessions), 'utf-8'); } catch { /* ignore */ }
}

/** Snapshot every live tile's durable resume info into the persisted map. Cheap
 *  and idempotent — only writes when something changed. Called (a) after each
 *  discovery pass and (b) synchronously at shutdown. */
function captureTermSessions(): void {
  let changed = false;
  for (const [id, s] of terminals.entries()) {
    // Only 'new'/'resume' tiles carry a resumable conversation; skip the CTRL dock.
    if (s.meta.kind === 'control') continue;
    const sid = s.discoveredSessionId || s.meta.sessionId;
    if (!sid) continue;
    const prev = persistedTermSessions[id];
    if (!prev || prev.sessionId !== sid) {
      persistedTermSessions[id] = { sessionId: sid, cwd: s.cwd, vendor: s.meta.vendor, agent: s.meta.agent, savedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) savePersistedTermSessions();
}
let termBatSeq = 0; // unique suffix for per-terminal temp .bat files (Windows)

/** cwd + claude command for a terminal kind. Returns null if it can't be built. */
function termCommand(meta: TermMeta): { cwd: string; cmd: string } | null {
  if (meta.kind === 'control') {
    try { ensureControlWorkspace(); } catch { return null; }
    return { cwd: getControlDir(), cmd: `claude ${hasControlHistory() ? '--continue' : ''}`.trim() };
  }
  if (meta.kind === 'resume' && meta.projectPath && meta.sessionId) {
    // Codex sessions resume via `codex resume <uuid>` (interactive); Claude via
    // `claude --resume`. The id is SAFE_SESSION_ID-validated; quote the resolved
    // codex path (it can live in a hashed bin dir).
    if (meta.vendor === 'codex') {
      return { cwd: meta.projectPath, cmd: `${shellQuoteArg(agentCommand('codex'))} resume ${meta.sessionId}` };
    }
    if (meta.vendor === 'antigravity') {
      // `agy --conversation <id>` resumes that Antigravity conversation interactively.
      return { cwd: meta.projectPath, cmd: `${shellQuoteArg(agentCommand('antigravity'))} --conversation ${meta.sessionId}` };
    }
    return { cwd: meta.projectPath, cmd: `claude --resume ${meta.sessionId}` };
  }
  if (meta.kind === 'new' && meta.projectPath) {
    const bin = agentCommand(meta.agent);
    // Seed an initial prompt the same way the terminal launcher does — claude
    // takes it as a positional arg (only claude; other agents launch bare).
    const seed = meta.prompt && (!meta.agent || meta.agent === 'claude') ? ' ' + shellQuoteArg(meta.prompt) : '';
    return { cwd: meta.projectPath, cmd: bin + seed };
  }
  return null;
}

/** Quote a single argument for the shell `termCommand` strings run under
 *  (`cmd /c` on Windows, `bash -lc` elsewhere). */
function shellQuoteArg(arg: string): string {
  const a = arg.replace(/[\r\n]+/g, ' ').slice(0, 4000);
  return getPlatform() === 'windows'
    ? '"' + a.replace(/(["%])/g, '') + '"'          // cmd: drop " and % (no reliable escape), keep it simple
    : "'" + a.replace(/'/g, "'\\''") + "'";          // bash: single-quote
}

/** Spawn a PTY for the given terminal id. Returns null on failure. */
function spawnTerm(id: string, meta: TermMeta): TermSession | null {
  let pty: any;
  try { pty = require('node-pty'); }
  catch (err) { log('error', { function: 'spawnTerm', message: 'node-pty load failed: ' + String(err) }); return null; }

  const spec = termCommand(meta);
  if (!spec) { log('error', { function: 'spawnTerm', message: 'bad terminal spec: ' + id }); return null; }

  const env = getCleanEnv();
  if (dashboardPort) env.CLDCTRL_DASHBOARD_PORT = String(dashboardPort);
  // Terminal identity: lets an MCP server running inside this PTY say WHICH tile
  // its agent lives in (e.g. open_scratchpad routes the notepad to the calling
  // conversation instead of guessing from operator focus).
  env.CLDCTRL_TILE_ID = id;
  // Provider profile: a tile whose agent id is an alternate Anthropic-compatible
  // provider (Kimi/GLM/…) launches the `claude` CLI (agentCommand falls back to
  // claude for unknown ids) with the endpoint env overridden. Applied for BOTH
  // new AND resume/reattach (getProviderEnv is a no-op for real agents), so a
  // resumed provider session keeps its endpoint instead of silently reverting to
  // api.anthropic.com with the user's real Claude auth.
  if (meta.agent) {
    try {
      const provEnv = (require('./core/providers.js') as typeof import('./core/providers.js')).getProviderEnv(meta.agent);
      if (provEnv) Object.assign(env, provEnv);
    } catch { /* not a provider — normal agent */ }
  }
  const isWin = getPlatform() === 'windows';
  // Windows: run the command from a temp .bat instead of `cmd /c "<string>"`.
  // `cmd /c` strips the inner quotes of a quoted argument, so a seeded prompt
  // like `claude "build a talk…"` collapsed to its first token (issue #8). A .bat
  // is read literally, preserving the quoting.
  let file: string, args: string[], batPath = '';
  if (isWin) {
    batPath = path.join(os.tmpdir(), `cldctrl-term-${id.replace(/[^a-z0-9]/gi, '_')}-${termBatSeq++}.bat`);
    try { fs.writeFileSync(batPath, '@echo off\r\n' + spec.cmd + '\r\n'); } catch { /* fall back below */ batPath = ''; }
    file = 'cmd.exe';
    args = batPath ? ['/c', batPath] : ['/c', spec.cmd];
  } else {
    file = 'bash'; args = ['-lc', spec.cmd];
  }

  let term: any;
  try {
    // useConpty: force the headless ConPTY backend on Windows. The legacy winpty
    // backend spawns a winpty-agent with a real hidden console that can briefly
    // flash a window; ConPTY (Win10 1809+) creates the pseudo-console with none.
    // Fall back to node-pty's default backend if ConPTY is unavailable — a
    // possible flash beats failing to spawn the terminal at all.
    const ptyOpts = { name: 'xterm-256color', cols: 80, rows: 24, cwd: spec.cwd, env };
    try {
      term = pty.spawn(file, args, isWin ? { ...ptyOpts, useConpty: true } : ptyOpts);
    } catch (conptyErr) {
      if (!isWin) throw conptyErr;
      log('serve_term', { event: 'conpty_fallback', id, message: String(conptyErr) });
      term = pty.spawn(file, args, ptyOpts);
    }
    if (batPath) setTimeout(() => { try { fs.unlinkSync(batPath); } catch { /* ignore */ } }, 8000);
  } catch (err) {
    log('error', { function: 'spawnTerm', message: 'spawn failed: ' + String(err) });
    return null;
  }
  log('serve_term', { event: 'spawn', id, cwd: spec.cwd });

  const session: TermSession = { meta, term, clients: new Set(), buffer: '', idleTimer: null, spawnedAt: Date.now(), cwd: spec.cwd };
  term.onData((d: string) => {
    session.buffer += d;
    if (session.buffer.length > REPLAY_CAP_BYTES) session.buffer = session.buffer.slice(session.buffer.length - REPLAY_CAP_BYTES);
    for (const c of session.clients) { try { c.send(d); } catch { /* socket closed */ } }
  });
  term.onExit(() => {
    for (const c of session.clients) {
      try { c.send('\r\n\x1b[2m[session ended]\x1b[0m\r\n'); c.close(); } catch { /* noop */ }
    }
    if (terminals.get(id) === session) terminals.delete(id);
    log('serve_term', { event: 'exit', id });
  });
  terminals.set(id, session);
  return session;
}

function killTerm(id: string): void {
  const s = terminals.get(id);
  if (!s) return;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  try { s.term.kill(); } catch { /* ignore */ }
}

/** Kill every live PTY. Called on graceful shutdown so agent processes don't
 *  outlive the server as orphans (node-pty conpty children are NOT reliably
 *  killed when this process dies externally — this covers the paths we control:
 *  Ctrl+C, SIGTERM, and idle-exit). */
function shutdownTerminals(reason: string): void {
  if (!terminals.size) return;
  log('serve_term', { event: 'shutdown_sweep', reason, count: terminals.size });
  for (const id of [...terminals.keys()]) killTerm(id);
}

/** Attach a browser WebSocket to the (lazily-spawned) terminal `id`. */
function attachTerm(ws: any, id: string, meta: TermMeta): void {
  let session = terminals.get(id);
  if (!session) {
    session = spawnTerm(id, meta) ?? undefined;
    if (!session) {
      try { ws.send('\r\n\x1b[31mTerminal unavailable (failed to start).\x1b[0m\r\n'); ws.close(); } catch { /* noop */ }
      return;
    }
  }
  const s = session;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  s.clients.add(ws);

  // Replay recent output; the client's post-connect resize makes claude repaint.
  if (s.buffer) { try { ws.send(CLEAR_SCREEN); ws.send(s.buffer); } catch { /* noop */ } }

  ws.on('message', (raw: any) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const cur = terminals.get(id);
    if (msg.type === 'input' && typeof msg.data === 'string') {
      try { cur?.term.write(msg.data); } catch { /* ignore */ }
    } else if (msg.type === 'resize') {
      const cols = Math.min(500, Math.max(2, msg.cols | 0));
      const rows = Math.min(200, Math.max(1, msg.rows | 0));
      try { cur?.term.resize(cols, rows); } catch { /* ignore */ }
    } else if (msg.type === 'restart') {
      const old = terminals.get(id);
      if (old) {
        const carried = new Set(old.clients);
        old.clients.clear();        // stop the old onExit from closing these sockets
        killTerm(id);
        const fresh = spawnTerm(id, meta);
        if (fresh) { for (const c of carried) { fresh.clients.add(c); try { c.send(CLEAR_SCREEN); } catch { /* noop */ } } }
        else { for (const c of carried) { try { c.send('\r\n\x1b[31mRestart failed.\x1b[0m\r\n'); c.close(); } catch { /* noop */ } } }
      }
    }
  });
  ws.on('close', () => {
    const cur = terminals.get(id);
    if (!cur) return;
    cur.clients.delete(ws);
    if (cur.clients.size === 0 && !cur.idleTimer) {
      cur.idleTimer = setTimeout(() => { log('serve_term', { event: 'idle_kill', id }); killTerm(id); }, IDLE_KILL_MS);
    }
    log('serve_term', { event: 'detach', id });
  });
  ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
}

/** Wire the WebSocket terminal endpoints onto the HTTP server (best-effort).
 *  /ws/agent → the control-plane agent; /ws/term?kind=resume&session=&path= → a
 *  resumed conversation in the cockpit. */
function setupAgentTerminal(server: http.Server): boolean {
  if (!AGENT_TERMINAL_AVAILABLE) return false;
  let WebSocketServer: any;
  try {
    WebSocketServer = require('ws').WebSocketServer;
  } catch (err) {
    log('error', { function: 'setupAgentTerminal', message: 'ws unavailable: ' + String(err) });
    return false;
  }
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (DEMO) { socket.destroy(); return; } // no live terminals in demo mode
      if (!isLocalHost(req)) { socket.destroy(); return; }
      // WS-CSRF: reject cross-origin (drive-by) handshakes from a browser.
      if (!isLocalWsOrigin(req)) {
        log('serve_term', { event: 'reject_origin', origin: String(req.headers.origin ?? '') });
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/ws/agent') {
        wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, 'control', { kind: 'control' }));
        return;
      }
      if (url.pathname === '/ws/term') {
        const kind = url.searchParams.get('kind');
        const proj = resolveKnownProject(url.searchParams.get('path') ?? '');
        if (!proj) { socket.destroy(); return; }
        if (kind === 'resume') {
          const session = url.searchParams.get('session') ?? '';
          if (!SAFE_SESSION_ID.test(session)) { socket.destroy(); return; }
          const vp = url.searchParams.get('vendor');
          const vendor = vp === 'codex' || vp === 'antigravity' ? vp : 'claude';
          wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, 'resume:' + session, { kind: 'resume', sessionId: session, projectPath: proj.path, vendor }));
          return;
        }
        if (kind === 'new') {
          const id = url.searchParams.get('id') ?? '';
          if (!/^new:.{1,400}$/.test(id)) { socket.destroy(); return; }
          const agent = url.searchParams.get('agent') ?? 'claude';
          // Reattach fallback: a popped-out/docked-back 'new' tile reconnecting
          // AFTER its PTY idle-died — the terminal is gone but the session it
          // created is known, so RESUME that instead of spawning a fresh agent —
          // with the RIGHT CLI (codex/agy vendor) + provider env (agent) preserved.
          // Prefer the browser-supplied `session=`; fall back to the disk-persisted
          // map (survives a server RESTART even when the browser never polled the
          // discovered sessionId — closes the launch→restart race).
          let fb = url.searchParams.get('session') ?? '';
          let fbCwd = proj.path;
          let fbVendor: 'claude' | 'codex' | 'antigravity' = agent === 'codex' || agent === 'antigravity' ? agent : 'claude';
          let fbAgent = agent; // provider-profile id (Kimi/GLM/…) drives the endpoint env
          if ((!fb || !SAFE_SESSION_ID.test(fb)) && !terminals.has(id)) {
            const persisted = persistedTermSessions[id];
            if (persisted && SAFE_SESSION_ID.test(persisted.sessionId)) {
              fb = persisted.sessionId;
              // Resume in the tile's ORIGINAL cwd (may be a worktree) when it still
              // exists — that's where the session JSONL lives; else the project.
              if (persisted.cwd) { try { if (fs.existsSync(persisted.cwd)) fbCwd = persisted.cwd; } catch { /* use proj.path */ } }
              if (persisted.vendor === 'codex' || persisted.vendor === 'antigravity' || persisted.vendor === 'claude') fbVendor = persisted.vendor;
              // Restore the persisted agent so a provider-profile tile keeps its
              // endpoint env after a restart (not the reconnect route's default).
              if (typeof persisted.agent === 'string' && persisted.agent) fbAgent = persisted.agent;
              log('serve_term', { event: 'resume_from_persisted', id, session: fb });
            }
          }
          if (!terminals.has(id) && fb && SAFE_SESSION_ID.test(fb)) {
            wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, 'resume:' + fb, { kind: 'resume', sessionId: fb, projectPath: fbCwd, vendor: fbVendor, agent: fbAgent }));
            return;
          }
          let cwd = proj.path;
          if (url.searchParams.get('worktree') === '1') {
            const wt = await createWorktree(proj.path, (url.searchParams.get('branch') || '').slice(0, 120));
            if (wt) cwd = wt.path; // fall back to the project if not a git repo / git fails
          }
          const prompt = url.searchParams.get('prompt') || undefined;
          wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, id, { kind: 'new', projectPath: cwd, agent, prompt }));
          return;
        }
      }
      socket.destroy();
    } catch { socket.destroy(); }
  });
  return true;
}

// ── Server ───────────────────────────────────────────────────

// Last time a local client touched us (HTTP request from a dashboard window —
// open windows poll /api/overview every 3s, so this stays fresh while any window
// exists). Drives idle-exit for background-spawned servers.
let lastHttpActivity = Date.now();

export function startServeServer(port: number, opts: { open?: boolean; demo?: boolean; appMode?: boolean; sharedProfile?: boolean; browser?: 'chrome' | 'edge'; idleExit?: boolean } = {}): void {
  initLogger();
  DEMO = !!opts.demo;
  // Scrubbed crash telemetry (default ON, opt-out). Browser surface.
  try {
    const { config } = loadConfig();
    installErrorHandlers('browser', config.error_reporting?.enabled !== false);
  } catch { installErrorHandlers('browser'); }
  dashboardPort = port; // stamped into PTY env so nested MCP servers know they're in the web surface
  // Rehydrate the tileId -> resume map a prior instance persisted, so 'new' tiles
  // whose sessionId the browser never polled can still --resume after a restart.
  if (!DEMO) loadPersistedTermSessions();
  // Snapshot the build we're running so a later rebuild is detectable as an update.
  runningBuildId = readDiskBuildId();

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only honor requests addressed to localhost
      if (!isLocalHost(req)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      lastHttpActivity = Date.now(); // a real local client — resets the idle-exit clock

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // Lightweight identity + readiness probe. Handled FIRST (before the demo
      // branch and before any heavy route) so it answers instantly regardless of
      // mode — the full /api/overview does rate-limit/git/usage work and can take
      // >900ms cold, which is too slow/racy for "is a CLD CTRL server here?" and
      // for a restart supervisor polling "is the NEW instance up yet?". Carries
      // the same identity markers /api/overview does. No-store so a browser never
      // serves a stale instanceId across a restart.
      if (req.method === 'GET' && url.pathname === '/api/id') {
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, serverIdentity());
        return;
      }

      // Demo mode is INERT against the real machine: only static assets + a few
      // demo-aware READ endpoints are served (synthetic data); every other
      // endpoint — launch, file, notes, reveal, screenshot, bridge, real
      // stats/search, WS terminals — is stubbed. No fs access, no agent launch,
      // no real user data can leave a `--demo` instance. (core/serve-demo.ts)
      if (DEMO) {
        const p = url.pathname, m = req.method;
        const staticGet = m === 'GET' && (p === '/' || p === '/index.html'
          || p.startsWith('/vendor/') || p.startsWith('/web/') || p === '/favicon.svg' || p === '/favicon.ico'
          || p === '/manifest.webmanifest' || p === '/icon-192.png' || p === '/icon-512.png');
        if (!staticGet) {
          const demo = await import('./core/serve-demo.js');
          if (m === 'GET' && p === '/api/overview') { sendJson(res, 200, { ...demo.buildDemoOverview(Date.now()), instanceId: INSTANCE_ID }); return; }
          if (m === 'GET' && p === '/api/stats') {
            const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 7));
            sendJson(res, 200, demo.buildDemoStats(days, Date.now())); return;
          }
          if (m === 'GET' && p === '/api/search') { sendJson(res, 200, demo.buildDemoSearch(url.searchParams.get('q') ?? '')); return; }
          if (m === 'GET' && p === '/api/conversation-image') { sendJson(res, 200, { images: [] }); return; }
          if (m === 'GET' && p === '/api/transcript') { sendJson(res, 200, { entries: [] }); return; }
          if (m === 'GET' && p.startsWith('/api/project/')) { sendJson(res, 200, { sessions: [], commits: [], issues: [], ghAvailable: false, tokens: [], files: [] }); return; }
          if (m === 'GET' && p === '/api/notes') { sendJson(res, 200, { notes: [] }); return; }
          // Everything else (all POSTs, machine-touching GETs) → inert stub.
          sendJson(res, 200, { demo: true, disabled: true }); return;
        }
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // no-cache: the shell references /web/app.js (also no-cache), so a reload
        // after a restart always revalidates and can't serve a stale bundle.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(SHELL);
      } else if (req.method === 'GET' && url.pathname === '/vendor/xterm.js') {
        serveStaticFile(res, XTERM_JS, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/vendor/xterm.css') {
        serveStaticFile(res, XTERM_CSS, 'text/css');
      } else if (req.method === 'GET' && url.pathname === '/vendor/addon-fit.js') {
        serveStaticFile(res, FIT_JS, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/vendor/katex.js') {
        serveStaticFile(res, KATEX_JS, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/vendor/katex-auto.js') {
        serveStaticFile(res, KATEX_AUTO, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/vendor/katex.css') {
        serveStaticFile(res, KATEX_CSS, 'text/css');
      } else if (req.method === 'GET' && url.pathname.startsWith('/vendor/fonts/')) {
        // KaTeX webfonts (katex.min.css references url(fonts/…) relative to itself).
        const name = url.pathname.slice('/vendor/fonts/'.length);
        if (!KATEX_FONTS || !/^[A-Za-z0-9_.-]+$/.test(name)) { res.writeHead(404).end(); return; }
        const ext = path.extname(name);
        const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : '';
        if (!mime) { res.writeHead(404).end(); return; }
        const f = path.join(KATEX_FONTS, name);
        if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
        fs.createReadStream(f).pipe(res);
      } else if (req.method === 'GET' && url.pathname === '/favicon.svg') {
        // branded favicon so the tab stands out: accent-orange tile + the ⌃ Ctrl caret
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e87632"/><path d="M6.5 21.5 L16 11 L25.5 21.5" fill="none" stroke="#0b0e15" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      } else if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(MANIFEST);
      } else if (req.method === 'GET' && (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png')) {
        const f = path.join(ASSETS_DIR, path.basename(url.pathname));
        if (fs.existsSync(f)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
          fs.createReadStream(f).pipe(res);
        } else {
          res.writeHead(404).end();
        }
      } else if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        if (fs.existsSync(ICO_PATH)) {
          res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-cache' });
          fs.createReadStream(ICO_PATH).pipe(res);
        } else {
          res.writeHead(204).end();
        }
      } else if (req.method === 'GET' && url.pathname.startsWith('/web/')) {
        serveWebAsset(res, url.pathname);
      } else if (req.method === 'GET' && url.pathname === '/api/overview') {
        sendJson(res, 200, await buildOverview());
      } else if (req.method === 'GET' && url.pathname === '/api/transcript') {
        const result = await handleTranscript(url.searchParams.get('id') ?? '');
        sendJson(res, result.status, result.body);
      } else if (req.method === 'GET' && url.pathname === '/api/file') {
        const result = handleReadFile(url.searchParams.get('path') ?? '');
        sendJson(res, result.status, result.body);
      } else if (req.method === 'GET' && url.pathname === '/api/image') {
        // Binary image serving for in-app previews (terminal link popups, the
        // lightbox). Same containment as /api/file: known project or scratch dir.
        // `sandbox` CSP so an SVG's scripts can never run if opened as a document.
        const p = url.searchParams.get('path') ?? '';
        const ext = (p.split('.').pop() ?? '').toLowerCase();
        const mime = IMAGE_MIME[ext];
        if (!p || !mime) { sendJson(res, 400, { error: 'Not an image path' }); return; }
        if (!fileInKnownProject(p)) { sendJson(res, 403, { error: 'Path is not inside a known project' }); return; }
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) { sendJson(res, 404, { error: 'Not a file' }); return; }
          if (st.size > IMAGE_CAP) { sendJson(res, 413, { error: 'Image too large' }); return; }
          res.writeHead(200, {
            'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
          });
          fs.createReadStream(p).pipe(res);
        } catch { sendJson(res, 404, { error: 'Not found' }); }
      } else if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        // Optional semantic re-rank (config search.semantic, default off) —
        // same results shape; extra `semantic` field says whether it applied.
        const { searchConversationsSmart } = await import('./core/semantic-rerank.js');
        const smart = await searchConversationsSmart(q);
        sendJson(res, 200, { results: smart.results, query: q, semantic: smart.semantic });
      } else if (req.method === 'GET' && url.pathname === '/api/stats') {
        const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 3));
        const { computeStats } = await import('./core/stats.js');
        sendJson(res, 200, await computeStats(days));
      } else if (req.method === 'GET' && url.pathname === '/api/conversation-image') {
        const { readBucketImages } = await import('./core/stats.js');
        const images = await readBucketImages(url.searchParams.get('slug') ?? '', url.searchParams.get('session') ?? '', Number(url.searchParams.get('t')) || 0);
        sendJson(res, 200, { images });
      } else if (req.method === 'GET' && url.pathname.startsWith('/api/project/')) {
        const tab = url.pathname.slice('/api/project/'.length);
        const result = await handleProjectDetail(tab, url.searchParams.get('path') ?? '', url.searchParams.get('dir') ?? '');
        sendJson(res, result.status, result.body);
      } else if (req.method === 'GET' && url.pathname === '/api/control/sessions') {
        // CTRL conversation history (for the header dropdown). Registers file
        // paths so /api/transcript + read-aloud work on historical control chats.
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        sendJson(res, 200, { sessions: await listControlSessions(limit) });
      } else if (req.method === 'POST' && url.pathname === '/api/launch') {
        // CSRF guard: the custom header forces a preflight cross-origin,
        // which this server never approves (no CORS headers are sent)
        if (req.headers['x-cldctrl'] !== '1') {
          sendJson(res, 403, { error: 'Missing X-CLDCTRL header' });
          return;
        }
        const body = await readJsonBody(req);
        const result = await handleLaunch(body);
        sendJson(res, result.status, result.body);
      } else if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        // `cc stop`: deliberate remote shutdown so a relaunch picks up a new
        // build. Kills live PTYs (agent sessions in tiles) via the same sweep
        // as Ctrl+C — the caller is expected to have warned the user.
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        log('serve', { event: 'shutdown_requested', terminals: terminals.size });
        sendJson(res, 200, { ok: true, product: PRODUCT, instanceId: INSTANCE_ID, terminals: terminals.size, version: VERSION });
        // Let the response flush before tearing down. shutdown() is idempotent,
        // so a repeat POST (or a racing signal) collapses to one teardown.
        setTimeout(() => shutdown('api'), 150);
      } else if (req.method === 'POST' && url.pathname === '/api/restart') {
        // In-dashboard restart button. We DON'T shut ourselves down here — we
        // spawn a detached `cc restart` supervisor that owns the whole sequence
        // (stop us via /api/shutdown → wait for the port → start a successor
        // WITHOUT a new window). The browser reloads onto the successor via its
        // instanceId-change detection. Reuses the tested CLI supervisor so the
        // stop→start ordering + session capture all happen exactly as in `cc
        // restart`. Refused in demo mode (no real lifecycle).
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        if (DEMO) { sendJson(res, 200, { ok: false, disabled: true }); return; }
        log('serve', { event: 'restart_requested', terminals: terminals.size });
        sendJson(res, 200, { ok: true, instanceId: INSTANCE_ID, terminals: terminals.size });
        setTimeout(async () => {
          try {
            // resolveEntry() existsSync-guards + falls back to argv[1] instead of
            // assuming index.js sits next to this bundle.
            const { resolveEntry } = await import('./core/app-launch.js');
            spawn(process.execPath, [resolveEntry(), 'restart', '--port', String(dashboardPort || port), '--no-window'],
              { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch (e) { log('error', { function: 'api_restart', message: String(e) }); }
        }, 150);
      } else if (req.method === 'POST' && url.pathname === '/api/screenshot') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const out = await captureScreenshot(body.mode === 'full' ? 'full' : 'region');
        if (!out) { sendJson(res, 500, { error: 'Capture failed or cancelled' }); return; }
        // Type the image path into the target terminal so the next prompt can use it.
        const target = typeof body.target === 'string' ? body.target : 'control';
        const t = terminals.get(target);
        if (t) { try { t.term.write(out + ' '); } catch { /* ignore */ } }
        log('serve_shot', { target, injected: !!t });
        sendJson(res, 200, { path: out, injected: !!t });
      } else if (req.method === 'POST' && url.pathname === '/api/file') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        // Doc/scratchpad writes can be large (up to FILE_CAP) — don't apply the
        // small-body cap that the other JSON endpoints use.
        const writeBody = await readJsonBody(req, FILE_CAP + 100_000);
        const result = handleWriteFile(writeBody);
        // Back up notes to git on save (throttled). Only scratch-dir files (notepads).
        if ((result.body as { ok?: boolean })?.ok && typeof writeBody.path === 'string' && isScratchPath(writeBody.path)) commitNotesSoon();
        sendJson(res, result.status, result.body);
      } else if (req.method === 'POST' && url.pathname === '/api/scratch') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        // `key` → a STABLE per-conversation notepad (docked notepad, reopens the
        // same draft on resume); otherwise mint a fresh one-off scratchpad.
        const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined;
        const title = typeof body.title === 'string' ? body.title.slice(0, 80) : undefined;
        const p = key ? notepadFile(key) : newScratchFile(title);
        // Associate with the conversation/project so it surfaces in the notes list.
        const proj = typeof body.project === 'string' ? body.project : '';
        const conv = typeof body.conversation === 'string' ? body.conversation : (key ?? '');
        if (proj || conv) recordNote(p, proj, conv);
        log('serve_scratch', { path: p, keyed: !!key });
        sendJson(res, 200, { ok: true, path: p });
      } else if (req.method === 'POST' && url.pathname === '/api/notes/new') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title.slice(0, 80) : undefined;
        const proj = typeof body.project === 'string' ? body.project : '';
        const conv = typeof body.conversation === 'string' ? body.conversation : '';
        const p = newNoteFile(title);
        recordNote(p, proj, conv);
        log('serve_note_new', { path: p });
        sendJson(res, 200, { ok: true, path: p });
      } else if (req.method === 'POST' && url.pathname === '/api/notes/record') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const p = typeof body.path === 'string' ? body.path : '';
        if (!p || !isScratchPath(p)) { sendJson(res, 400, { error: 'Not a notes path' }); return; }
        recordNote(p, typeof body.project === 'string' ? body.project : '', typeof body.conversation === 'string' ? body.conversation : '');
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'GET' && url.pathname === '/api/notes/history') {
        const p = url.searchParams.get('path') || '';
        if (!p || !isScratchPath(p)) { sendJson(res, 400, { error: 'Not a notes path' }); return; }
        sendJson(res, 200, { ok: true, revisions: await noteHistory(p) });
      } else if (req.method === 'GET' && url.pathname === '/api/notes/revision') {
        const p = url.searchParams.get('path') || '';
        const rev = url.searchParams.get('rev') || '';
        if (!p || !isScratchPath(p)) { sendJson(res, 400, { error: 'Not a notes path' }); return; }
        const content = await noteRevisionContent(p, rev);
        if (content === null) { sendJson(res, 404, { error: 'revision not found' }); return; }
        sendJson(res, 200, { ok: true, content });
      } else if (req.method === 'POST' && url.pathname === '/api/notes/restore') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const p = typeof body.path === 'string' ? body.path : '';
        const rev = typeof body.rev === 'string' ? body.rev : '';
        if (!p || !isScratchPath(p)) { sendJson(res, 400, { error: 'Not a notes path' }); return; }
        sendJson(res, 200, await restoreNoteRevision(p, rev));
      } else if (req.method === 'GET' && url.pathname === '/api/notes') {
        const proj = url.searchParams.get('project') || undefined;
        const conv = url.searchParams.get('conversation') || undefined;
        const query = url.searchParams.get('q') || undefined;
        sendJson(res, 200, { ok: true, notes: listNotes({ project: proj, conversation: conv, query }) });
      } else if (req.method === 'POST' && url.pathname === '/api/handoff-brief') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        // Build a handoff brief from a session's on-disk state (no live agent) so
        // the client can open a new sibling tile with another agent, prefilled.
        const body = await readJsonBody(req);
        const session = typeof body.session === 'string' ? body.session : '';
        const { buildHandoffBrief } = await import('./core/handoff.js');
        const r = await buildHandoffBrief(session);
        if (r.ok) log('serve_handoff', { session });
        sendJson(res, r.ok ? 200 : 400, r);
      } else if (req.method === 'POST' && url.pathname === '/api/latex-convert') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        // Markdown note → compilable LaTeX beside it, via pandoc. Restricted to
        // paths the dashboard may already read: scratch/notes files, or files
        // inside a known project. pandocMissing → the client asks the agent.
        const body = await readJsonBody(req);
        const src = typeof body.path === 'string' ? body.path : '';
        if (!src || !/\.(md|markdown|txt)$/i.test(src) || (!isScratchPath(src) && !resolveProjectForFile(src))) {
          sendJson(res, 400, { error: 'Not a convertible note path' }); return;
        }
        const { convertMarkdownToLatex } = await import('./core/latex.js');
        const result = convertMarkdownToLatex(src);
        if (result.ok) log('serve_latex', { src: path.basename(src) });
        sendJson(res, 200, result);
      } else if (req.method === 'POST' && url.pathname === '/api/popout') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        // Pop a conversation tile out into its own chromeless app window. The
        // widget URL is built SERVER-side from validated fields only — the client
        // never gets to launch an arbitrary URL through the browser spawn.
        // kind 'resume' needs a session; kind 'new' needs its terminal id (the
        // widget attaches to the same live 'new:<id>' PTY) + optionally the
        // discovered session as a reattach fallback.
        const body = await readJsonBody(req);
        const kind = body.kind === 'new' ? 'new' : 'resume';
        const session = typeof body.session === 'string' ? body.session : '';
        const tileId = typeof body.id === 'string' ? body.id : '';
        const agent = typeof body.agent === 'string' && /^[a-z0-9-]{1,20}$/i.test(body.agent) ? body.agent : '';
        const vendor = body.vendor === 'codex' || body.vendor === 'antigravity' ? body.vendor : '';
        const proj = resolveKnownProject(typeof body.path === 'string' ? body.path : '');
        const sessionOk = kind === 'resume' ? SAFE_SESSION_ID.test(session) : (!session || SAFE_SESSION_ID.test(session));
        const idOk = kind === 'resume' || /^new:.{1,400}$/.test(tileId);
        if (!proj || !sessionOk || !idOk) { sendJson(res, 400, { error: 'Unknown session or project' }); return; }
        const title = (typeof body.title === 'string' ? body.title : '').slice(0, 120);
        const params = new URLSearchParams({ widget: '1', kind, path: proj.path, title });
        if (session) params.set('session', session);
        if (kind === 'new') params.set('id', tileId);
        if (agent) params.set('agent', agent);
        if (vendor) params.set('vendor', vendor);
        const widgetUrl = `http://127.0.0.1:${dashboardPort}/?` + params.toString();
        try {
          const { launchAppWindow } = await import('./core/app-launch.js');
          if (launchAppWindow(widgetUrl)) {
            log('serve_popout', { session });
            sendJson(res, 200, { ok: true });
            return;
          }
        } catch { /* fall through to client-side popup fallback */ }
        // No Chromium (or spawn failed): let the client open a plain popup itself.
        sendJson(res, 200, { ok: false, fallback: true, url: widgetUrl });
      } else if (req.method === 'POST' && url.pathname === '/api/reveal') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const raw = typeof body.path === 'string' ? body.path : '';
        // accept either a known project root OR a file/dir inside one (clickable paths)
        const exact = resolveKnownProject(raw);
        const owner = exact ?? resolveProjectForFile(raw);
        if (!owner) { sendJson(res, 403, { error: 'Path is not in a known project' }); return; }
        let isFile = false;
        try { isFile = !exact && fs.existsSync(raw) && fs.statSync(raw).isFile(); } catch { isFile = false; }
        const openPath = exact ? exact.path : raw;
        const target = body.target === 'code' ? 'code' : body.target === 'default' ? 'default' : 'explorer';
        try {
          if (target === 'default' && isFile) {
            // OS-default app for the file type (what a double-click would do).
            // shellOpenFile refuses executables (a shell open would RUN them) —
            // fall through to a reveal-in-explorer so the click still lands somewhere.
            if (shellOpenFile(openPath)) { log('serve_reveal', { target, path: openPath, isFile }); sendJson(res, 200, { ok: true, target }); return; }
            if (!isExecutableFile(openPath)) { sendJson(res, 200, { ok: false, error: 'could not open with the default app' }); return; }
            if (getPlatform() === 'windows') {
              spawn.spawn('explorer', ['/select,' + openPath], { detached: true, stdio: 'ignore' }).unref();
            } else {
              openInExplorer(path.dirname(openPath)); // no /select on mac/linux — reveal the folder
            }
            sendJson(res, 200, { ok: true, target: 'explorer', note: 'executable — revealed instead of run' });
            return;
          }
          if (target === 'code' || target === 'default') { // 'default' on a directory behaves like explorer below
            if (target === 'code') {
              // Editor missing → degrade to the OS default app rather than a dead click.
              if (!isCommandAvailable('code')) {
                if (isFile && shellOpenFile(openPath)) { sendJson(res, 200, { ok: true, target: 'default', note: 'VS Code not on PATH — opened with the default app' }); return; }
                sendJson(res, 200, { ok: false, error: 'VS Code (code) not on PATH' }); return;
              }
              spawn.spawn('code', isFile ? ['-g', openPath] : [openPath], { detached: true, stdio: 'ignore' }).unref();
              log('serve_reveal', { target, path: openPath, isFile });
              sendJson(res, 200, { ok: true, target });
              return;
            }
            openInExplorer(openPath);
            log('serve_reveal', { target, path: openPath, isFile });
            sendJson(res, 200, { ok: true, target });
            return;
          }
          if (isFile && getPlatform() === 'windows') {
            spawn.spawn('explorer', ['/select,' + openPath], { detached: true, stdio: 'ignore' }).unref(); // highlight the file
          } else {
            openInExplorer(isFile ? path.dirname(openPath) : openPath);
          }
          log('serve_reveal', { target, path: openPath, isFile });
          sendJson(res, 200, { ok: true, target });
        } catch (e) { sendJson(res, 200, { ok: false, error: String(e) }); }
      } else if (req.method === 'POST' && url.pathname === '/api/bridge') {
        if (req.headers['x-cldctrl'] !== '1') { sendJson(res, 403, { error: 'Missing X-CLDCTRL header' }); return; }
        const body = await readJsonBody(req);
        const q = typeof body.query === 'string' ? body.query.slice(0, 500) : '';
        writeDashboardContext({
          query: q,
          results: q.trim() ? searchConversations(q, 20) : [],
          selectedProject: typeof body.selectedProject === 'string' ? body.selectedProject : null,
          ts: Date.now(),
        });
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      log('error', { function: 'serve', message: String(err) });
      sendJson(res, 500, { error: 'Internal error' });
    }
  });

  // Docked agent terminal over WebSocket (localhost only). Best-effort: if the
  // optional deps are missing, the dashboard still serves without it.
  const agentOk = setupAgentTerminal(server);

  // Notes git backup: snapshot at startup (captures pre-existing notes), then on a
  // slow tick to catch the AGENT's direct Write/Edit to a note file (those bypass
  // /api/file, which only fires for the operator's own saves). Throttled + unref'd.
  // Skipped in demo mode — a demo instance touches nothing real.
  if (!DEMO) {
    commitNotesSoon();
    const notesSnap = setInterval(() => commitNotesSoon(), 90_000);
    notesSnap.unref?.();
  }

  // Graceful shutdown: kill live PTYs so agent processes don't outlive us as
  // orphans, then exit. Covers Ctrl+C (foreground `cc serve`) and SIGTERM;
  // nothing can run on an external force-kill (Stop-Process) — that path is
  // mitigated by idle-exit draining the server when it's no longer used.
  //
  // IDEMPOTENT: four paths can trigger teardown (SIGINT, SIGTERM, idle-exit,
  // POST /api/shutdown) and they can overlap (e.g. Ctrl+C while an idle tick
  // fires). Guard so the PTY sweep + exit runs exactly once — a second sweep
  // over an already-killing terminal set is harmless but the double `exit()`
  // timers and log spam aren't worth it.
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('serve', { event: 'shutdown', reason: sig, terminals: terminals.size });
    // Last-chance session capture BEFORE the PTYs die: run a forced discovery
    // pass (catches sessions whose JSONL exists but the browser never polled),
    // then persist tileId -> resume info so the successor server can rehydrate
    // 'new' tiles that would otherwise reconnect with no sessionId → fresh agent.
    try { fillDiscoveredSessions(); captureTermSessions(); } catch { /* best-effort */ }
    shutdownTerminals(sig);
    try { server.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 250).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Idle-exit (opt-in — the DETACHED background server that bare `cc` spawns):
  // once every window is closed (no HTTP polls) and every PTY has drained (the
  // 10-min clientless kill), exit so cldctrl doesn't run forever in the
  // background. The next `cc` just starts fresh. Explicit `cc serve` (foreground,
  // possibly kept up on purpose) never idle-exits.
  const IDLE_EXIT_MS = Number(process.env.CLDCTRL_IDLE_EXIT_MS) || 15 * 60_000; // env override for tests
  if (opts.idleExit) {
    const idleTick = setInterval(() => {
      if (terminals.size === 0 && Date.now() - lastHttpActivity > IDLE_EXIT_MS) {
        log('serve', { event: 'idle_exit', idleMinutes: Math.round((Date.now() - lastHttpActivity) / 60000) });
        clearInterval(idleTick);
        shutdown('idle');
      }
    }, Math.min(60_000, Math.max(1000, Math.floor(IDLE_EXIT_MS / 3))));
    idleTick.unref?.();
  }

  // Build-update watch: re-read the on-disk manifest on a slow tick; when its
  // buildId differs from the one we started with, a newer build has landed →
  // flip the flag the overview surfaces as a "restart to load" pill. Latch-once
  // (a rebuild stays "update ready" until the server is restarted). The manifest
  // is written atomically, so a single read is always a complete build.
  if (!DEMO && runningBuildId) {
    const BUILD_CHECK_MS = Number(process.env.CLDCTRL_BUILD_CHECK_MS) || 20_000; // env override for tests
    const buildTick = setInterval(() => {
      if (buildUpdateReady) { clearInterval(buildTick); return; }
      const disk = readDiskBuildId();
      if (disk && disk !== runningBuildId) {
        buildUpdateReady = true;
        log('serve', { event: 'build_update_ready', running: runningBuildId, disk });
        clearInterval(buildTick);
      }
    }, Math.max(1000, BUILD_CHECK_MS));
    buildTick.unref?.();
  }

  // Localhost ONLY — transcripts, terminal, and launch must not reach the network.
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`CLD CTRL dashboard: ${url}`);
    console.log(`Bound to localhost only.${DEMO ? ' DEMO MODE (synthetic data).' : agentOk ? ' Agent terminal enabled.' : ''} Ctrl+C to stop.`);
    if (opts.appMode) {
      // Chromeless standalone window (Edge/Chrome --app=). Falls back to a normal
      // browser tab if no Chromium browser is found.
      import('./core/app-launch.js').then(({ launchAppWindow }) => {
        if (launchAppWindow(url, { sharedProfile: opts.sharedProfile, browser: opts.browser })) {
          console.log('Opened in app mode (chromeless window).');
        } else {
          console.log('App mode: no Chromium browser found — opening a normal tab.');
          openUrl(url);
        }
      }).catch(() => openUrl(url));
    } else if (opts.open) {
      openUrl(url);
    }
    if (DEMO) return; // demo instances stay silent — no beacon, no update check
    // Adoption ping for the browser surface: one launch hit, then a slow
    // presence heartbeat while the dashboard server stays up (same beacon as
    // the TUI, tagged client='browser' so the two surfaces can be told apart).
    // checkForUpdate also returns a newer version (or null) → surfaced in the
    // dashboard as an "update available" pill via the overview payload.
    import('./core/update-check.js').then((m) => {
      m.checkForUpdate(false, 'browser').then((v) => { latestUpdate = v; }).catch(() => { /* ignore */ });
      const hb = setInterval(() => {
        m.pingHeartbeat('browser');
        m.checkForUpdate(false, 'browser').then((v) => { latestUpdate = v; }).catch(() => { /* ignore */ });
      }, 300000);
      hb.unref?.();
    }).catch(() => { /* offline / blocked — ignore */ });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use. Try: cc serve --port ${port + 1}`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });
}
