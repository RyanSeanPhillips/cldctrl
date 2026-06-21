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
import { fileURLToPath } from 'node:url';
import { VERSION } from './constants.js';
import { loadConfig } from './config.js';
import { buildProjectListFast } from './core/projects.js';
import { getActiveClaudeProcesses } from './core/processes.js';
import { getActiveSessionInfo } from './core/activity.js';
import { getRollingUsageWindowed, getRecentSessions } from './core/sessions.js';
import { getDailyUsageByProject } from './core/usage.js';
import { getRecentCommits, getCommitDailyActivity } from './core/git.js';
import { getIssues, isGhAvailable, getGhInstallUrl } from './core/github.js';
import { parseGitignore, readDirectory } from './core/filetree.js';
import { searchConversations, deriveGist, cleanPrompt, isWeak, condense } from './core/conversation-search.js';
import { writeDashboardContext, readAgentSearch } from './core/dashboard-bridge.js';
import { captureScreenshot } from './core/screenshot.js';
import { createWorktree } from './core/worktree.js';
import { readDaemonCache } from './core/background.js';
import { getClaudeProjectsDir, normalizePathForCompare, openUrl, getPlatform } from './core/platform.js';
import { readClaudeTier, getTierLabel, probeRateLimits, getCachedRateLimits, formatResetEpoch } from './core/claude-usage.js';
import { launchAndTrack, getCleanEnv } from './core/launcher.js';
import { getControlDir, hasControlHistory, ensureControlWorkspace } from './core/control.js';
import { log, initLogger } from './core/logger.js';
import type { RateLimitInfo } from './core/claude-usage.js';

// `require` is injected by the tsup banner (createRequire) into every output
// file — used to load the native/runtime-external modules (node-pty, ws) and to
// resolve vendored xterm assets. Declared here so TypeScript accepts it in ESM.
declare const require: NodeRequire;

const RATE_PROBE_TTL_MS = 5 * 60_000;
let lastProbeAt = 0;
let lastProbe: RateLimitInfo | null = null;

async function getRateLimits(): Promise<RateLimitInfo | null> {
  const cached = getCachedRateLimits();
  if (cached) return cached;
  if (Date.now() - lastProbeAt < RATE_PROBE_TTL_MS) return lastProbe;
  lastProbeAt = Date.now();
  try {
    lastProbe = await probeRateLimits();
  } catch {
    lastProbe = null;
  }
  return lastProbe;
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

// ── Session file map (server-side only — clients never send paths) ──

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const sessionFileMap = new Map<string, string>(); // sessionId -> JSONL path

// ── Overview payload ─────────────────────────────────────────

async function buildOverview(): Promise<unknown> {
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
  const daily = await getDailyTokens(cache?.usageByProject);

  const activePaths = new Set(sessions.map(s => normalizePathForCompare(s.projectPath)));

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    tier: getTierLabel(tier),
    features: { agentTerminal: AGENT_TERMINAL_AVAILABLE },
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
      daily,
      dailyCommits: aggregateDaily(cache?.commitActivity, 28, 'commits'),
    },
    bridge: readAgentSearch(),
    sessions: sessions.map(s => ({
      id: s.sessionId || null,
      project: nameMap.get(normalizePathForCompare(s.projectPath)) ?? path.basename(s.projectPath),
      path: s.projectPath,
      status: s.idle ? 'idle' : 'active',
      currentAction: s.currentAction ?? null,
      lastActivity: s.lastActivity.toISOString(),
      tokens: s.stats.tokens,
      messages: s.stats.messages,
      assistantTurns: s.stats.assistantTurns,
      toolCalls: s.stats.toolCalls.reads + s.stats.toolCalls.writes + s.stats.toolCalls.bash + s.stats.toolCalls.other,
      contextSize: s.stats.lastContextSize,
      durationMs: s.stats.duration,
      model: dominantModel(s.stats.models),
      files: (s.stats.touchedFiles ?? []).slice(0, 60).map(f => ({
        path: relativeToProject(f.path, s.projectPath),
        reads: f.reads,
        writes: f.writes,
        lastTs: f.lastTs,
      })),
    })),
    projects: projects.map(p => {
      const git = cache?.gitStatuses?.[p.path] ?? null;
      return {
        name: p.name,
        path: p.path,
        active: activePaths.has(normalizePathForCompare(p.path)),
        branch: git?.branch ?? null,
        dirty: git?.dirty ?? 0,
        ahead: git?.ahead ?? 0,
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

/** Extract the last ~30 conversational turns from a session JSONL. */
function readTranscriptTail(filePath: string): TranscriptEntry[] {
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

  return entries.slice(-MAX_TRANSCRIPT_ENTRIES);
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
  const filePath = sessionFileMap.get(sessionId);
  if (!filePath) return { status: 404, body: { error: 'Session not found' } };
  try {
    return { status: 200, body: { entries: readTranscriptTail(filePath) } };
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

// ── Request plumbing ─────────────────────────────────────────

function isLocalHost(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) { reject(new Error('Body too large')); req.destroy(); }
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
<title>CLD CTRL</title>
<link rel="stylesheet" href="/vendor/xterm.css">
<link rel="stylesheet" href="/web/app.css">
</head>
<body>
<div id="app"><div class="loading">Loading dashboard…</div></div>
<div id="cockpit">
  <div id="cockpit-bar">
    <span id="cockpit-title">Cockpit</span>
    <button class="btn primary" data-act="cockpit-add-toggle" title="Add a session">+ Add</button>
    <div class="cp-layouts">
      <button class="btn icon" data-act="cockpit-layout" data-layout="cols1" title="Single column">&#9647;</button>
      <button class="btn icon" data-act="cockpit-layout" data-layout="cols2" title="Two columns">&#9707;</button>
      <button class="btn icon" data-act="cockpit-layout" data-layout="grid" title="Grid">&#9638;</button>
    </div>
    <span class="sp"></span>
    <button class="btn" data-act="cockpit-close" title="Back to dashboard">&#10005; Close cockpit</button>
  </div>
  <div id="cockpit-grid" class="cockpit-grid cols2"></div>
</div>
<aside id="dock" class="dock">
  <button class="dock-rail" data-act="dockToggle" title="Agent control plane">
    <span class="dot" id="dock-dot-rail"></span>
    <span class="rail-label">Agent</span>
  </button>
  <div class="dock-panel">
    <div class="dock-head">
      <span class="dot" id="dock-dot"></span>
      <span class="dock-title">Agent · control plane</span>
      <span class="sp"></span>
      <button class="btn icon" data-act="dock-shot" title="Screenshot into this session">&#128247;</button>
      <button class="btn icon" data-act="dockRestart" title="Restart session">↻</button>
      <button class="btn icon" data-act="dockClose" title="Close">✕</button>
    </div>
    <div id="dock-term"></div>
    <div id="dock-status">disconnected</div>
  </div>
</aside>
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
const AGENT_TERMINAL_AVAILABLE = !!(XTERM_JS && XTERM_CSS && FIT_JS);

function serveStaticFile(res: http.ServerResponse, filePath: string | null, type: string): void {
  if (!filePath || !fs.existsSync(filePath)) { sendJson(res, 404, { error: 'Not found' }); return; }
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

// The bundled dashboard assets (app.js/app.css + sourcemaps) live in dist/web/,
// a sibling of this compiled module. Served read-only with a path-traversal guard.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
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
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'max-age=3600' });
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

interface TermMeta { kind: 'control' | 'resume' | 'new'; sessionId?: string; projectPath?: string; }
interface TermSession {
  meta: TermMeta;
  term: any;                                   // node-pty instance
  clients: Set<any>;                           // attached WebSockets
  buffer: string;                              // recent output, capped, for replay
  idleTimer: ReturnType<typeof setTimeout> | null;
}
const terminals = new Map<string, TermSession>();

/** cwd + claude command for a terminal kind. Returns null if it can't be built. */
function termCommand(meta: TermMeta): { cwd: string; cmd: string } | null {
  if (meta.kind === 'control') {
    try { ensureControlWorkspace(); } catch { return null; }
    return { cwd: getControlDir(), cmd: `claude ${hasControlHistory() ? '--continue' : ''}`.trim() };
  }
  if (meta.kind === 'resume' && meta.projectPath && meta.sessionId) {
    return { cwd: meta.projectPath, cmd: `claude --resume ${meta.sessionId}` };
  }
  if (meta.kind === 'new' && meta.projectPath) {
    return { cwd: meta.projectPath, cmd: 'claude' };
  }
  return null;
}

/** Spawn a PTY for the given terminal id. Returns null on failure. */
function spawnTerm(id: string, meta: TermMeta): TermSession | null {
  let pty: any;
  try { pty = require('node-pty'); }
  catch (err) { log('error', { function: 'spawnTerm', message: 'node-pty load failed: ' + String(err) }); return null; }

  const spec = termCommand(meta);
  if (!spec) { log('error', { function: 'spawnTerm', message: 'bad terminal spec: ' + id }); return null; }

  const env = getCleanEnv();
  const isWin = getPlatform() === 'windows';
  const file = isWin ? 'cmd.exe' : 'bash';
  const args = isWin ? ['/c', spec.cmd] : ['-lc', spec.cmd];

  let term: any;
  try {
    term = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: spec.cwd, env });
  } catch (err) {
    log('error', { function: 'spawnTerm', message: 'spawn failed: ' + String(err) });
    return null;
  }
  log('serve_term', { event: 'spawn', id, cwd: spec.cwd });

  const session: TermSession = { meta, term, clients: new Set(), buffer: '', idleTimer: null };
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
      if (!isLocalHost(req)) { socket.destroy(); return; }
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
          wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, 'resume:' + session, { kind: 'resume', sessionId: session, projectPath: proj.path }));
          return;
        }
        if (kind === 'new') {
          const id = url.searchParams.get('id') ?? '';
          if (!/^new:.{1,400}$/.test(id)) { socket.destroy(); return; }
          let cwd = proj.path;
          if (url.searchParams.get('worktree') === '1') {
            const wt = await createWorktree(proj.path, (url.searchParams.get('branch') || '').slice(0, 120));
            if (wt) cwd = wt.path; // fall back to the project if not a git repo / git fails
          }
          wss.handleUpgrade(req, socket, head, (ws: any) => attachTerm(ws, id, { kind: 'new', projectPath: cwd }));
          return;
        }
      }
      socket.destroy();
    } catch { socket.destroy(); }
  });
  return true;
}

// ── Server ───────────────────────────────────────────────────

export function startServeServer(port: number, opts: { open?: boolean } = {}): void {
  initLogger();

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only honor requests addressed to localhost
      if (!isLocalHost(req)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SHELL);
      } else if (req.method === 'GET' && url.pathname === '/vendor/xterm.js') {
        serveStaticFile(res, XTERM_JS, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/vendor/xterm.css') {
        serveStaticFile(res, XTERM_CSS, 'text/css');
      } else if (req.method === 'GET' && url.pathname === '/vendor/addon-fit.js') {
        serveStaticFile(res, FIT_JS, 'text/javascript');
      } else if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end(); // no favicon; avoid a noisy 404 in the console
      } else if (req.method === 'GET' && url.pathname.startsWith('/web/')) {
        serveWebAsset(res, url.pathname);
      } else if (req.method === 'GET' && url.pathname === '/api/overview') {
        sendJson(res, 200, await buildOverview());
      } else if (req.method === 'GET' && url.pathname === '/api/transcript') {
        const result = await handleTranscript(url.searchParams.get('id') ?? '');
        sendJson(res, result.status, result.body);
      } else if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        sendJson(res, 200, { results: searchConversations(q), query: q });
      } else if (req.method === 'GET' && url.pathname.startsWith('/api/project/')) {
        const tab = url.pathname.slice('/api/project/'.length);
        const result = await handleProjectDetail(tab, url.searchParams.get('path') ?? '', url.searchParams.get('dir') ?? '');
        sendJson(res, result.status, result.body);
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

  // Localhost ONLY — transcripts, terminal, and launch must not reach the network.
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`CLD CTRL dashboard: ${url}`);
    console.log(`Bound to localhost only.${agentOk ? ' Agent terminal enabled.' : ''} Ctrl+C to stop.`);
    if (opts.open) openUrl(url);
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
