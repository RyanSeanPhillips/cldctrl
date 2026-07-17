/**
 * Synthetic data for `cc serve --demo` — a clean, shareable dashboard with NO
 * real project names or usage. Uses well-known open-source repos (relatable,
 * nothing private) and deliberately showcases the differentiators: multi-vendor
 * sessions (Claude + Codex + Antigravity/Gemini), grouped projects, usage
 * telemetry, and the Stats view. Screenshots/marketing render against this.
 *
 * Everything is deterministic given `now` so repeated captures are stable.
 */

import { VERSION } from '../constants.js';
import type { OverviewPayload, HeatCell, SearchResult } from '../web/types.js';
import type { StatsPayload, StatsTurn, StatsImageGroup } from './stats.js';

const DEMO_ROOT = '/home/dev/code';

// ── Projects: recognizable OSS repos, grouped like a power user's machine ────
interface DemoProject {
  name: string; group: string; branch: string; dirty: number; ahead: number;
}
const DEMO_PROJECTS: DemoProject[] = [
  { name: 'next.js', group: 'Apps', branch: 'main', dirty: 4, ahead: 2 },
  { name: 'react', group: 'Apps', branch: 'main', dirty: 0, ahead: 0 },
  { name: 'sveltekit', group: 'Apps', branch: 'chore/vite-6', dirty: 1, ahead: 0 },
  { name: 'pytorch', group: 'Research', branch: 'main', dirty: 7, ahead: 1 },
  { name: 'transformers', group: 'Research', branch: 'main', dirty: 0, ahead: 0 },
  { name: 'whisper', group: 'Research', branch: 'feat/streaming', dirty: 3, ahead: 5 },
  { name: 'ripgrep', group: 'Tools', branch: 'master', dirty: 0, ahead: 0 },
  { name: 'zellij', group: 'Tools', branch: 'main', dirty: 2, ahead: 0 },
  { name: 'bat', group: 'Tools', branch: 'master', dirty: 0, ahead: 0 },
  { name: 'ollama', group: 'Exploring', branch: 'main', dirty: 0, ahead: 0 },
  { name: 'llama.cpp', group: 'Exploring', branch: 'master', dirty: 1, ahead: 0 },
];

// ── Sessions: the multi-vendor story (Claude + Codex + Gemini/Antigravity) ───
interface DemoSession {
  project: string;
  vendor: 'claude' | 'codex' | 'antigravity' | 'gemini';
  status: 'active' | 'idle';
  action: string | null;
  agoMin: number;      // minutes since last activity
  tokens: number; messages: number; turns: number; tools: number;
  ctx: number; ctxWindow: number; durMin: number; model: string;
}
const DEMO_SESSIONS: DemoSession[] = [
  { project: 'next.js', vendor: 'claude', status: 'active', action: 'Editing app/layout.tsx', agoMin: 0,
    tokens: 148_000, messages: 42, turns: 21, tools: 63, ctx: 92_000, ctxWindow: 200_000, durMin: 37, model: 'claude-opus-4-8' },
  { project: 'pytorch', vendor: 'codex', status: 'active', action: 'Running the test suite', agoMin: 1,
    tokens: 96_500, messages: 28, turns: 14, tools: 51, ctx: 71_000, ctxWindow: 272_000, durMin: 24, model: 'gpt-5-codex' },
  { project: 'whisper', vendor: 'gemini', status: 'idle', action: 'Refactoring the decoder loop', agoMin: 12,
    tokens: 61_000, messages: 19, turns: 9, tools: 22, ctx: 44_000, ctxWindow: 1_000_000, durMin: 16, model: 'gemini-3-pro' },
  { project: 'zellij', vendor: 'claude', status: 'idle', action: 'Wiring the plugin API', agoMin: 41,
    tokens: 38_500, messages: 12, turns: 6, tools: 14, ctx: 27_000, ctxWindow: 200_000, durMin: 11, model: 'claude-sonnet-5' },
];

function iso(now: number, agoMin: number): string {
  return new Date(now - agoMin * 60_000).toISOString();
}

/** 28-day heatmap ending today, with a plausible weekday-heavy rhythm. */
function heat(now: number, scale: number): HeatCell[] {
  const cells: HeatCell[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const dow = d.getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.25 : 1;
    // Deterministic pseudo-variation from the day index.
    const wave = 0.45 + 0.55 * Math.abs(Math.sin(i * 1.7));
    cells.push({ date: d.toISOString().slice(0, 10), value: Math.round(scale * weekend * wave) });
  }
  return cells;
}

/** Full synthetic `/api/overview` payload. `now` = Date.now() from the caller. */
export function buildDemoOverview(now: number): OverviewPayload {
  const activeNames = new Set(DEMO_SESSIONS.map((s) => s.project));
  return {
    product: 'cldctrl',
    version: VERSION,
    updateAvailable: null,
    generatedAt: new Date(now).toISOString(),
    tier: 'MAX 5x',
    features: {
      agentTerminal: true,
      // The multi-vendor lineup — the moat. All shown as available.
      agents: [
        { id: 'claude', label: 'Claude Code', available: true },
        { id: 'codex', label: 'Codex', available: true },
        { id: 'antigravity', label: 'Antigravity', available: true },
      ],
      openExplorer: true,
      openVscode: true,
    },
    usage: {
      fiveHour: { tokens: 2_180_000, messages: 168, percent: 42.5, resetIn: '2h 10m' },
      sevenDay: { tokens: 41_600_000, messages: 2130, percent: 61.0, resetIn: '3d 4h' },
      live: true,
      overage: null,
      codex: { tokens: 0, messages: 0, percent: 38.0, resetIn: '4h 12m' },
      daily: heat(now, 620_000),
      dailyCommits: heat(now, 9),
    },
    bridge: null,
    scratch: null,
    cockpitLaunches: [],
    cockpitInjects: [],
    terminalSessions: {},
    sessions: DEMO_SESSIONS.map((s) => ({
      id: `demo-${s.project}`,
      project: s.project,
      path: `${DEMO_ROOT}/${s.project}`,
      vendor: s.vendor,
      status: s.status,
      currentAction: s.action,
      lastActivity: iso(now, s.agoMin),
      tokens: s.tokens,
      messages: s.messages,
      assistantTurns: s.turns,
      toolCalls: s.tools,
      contextSize: s.ctx,
      contextWindow: s.ctxWindow,
      durationMs: s.durMin * 60_000,
      model: s.model,
      files: [],
    })),
    projects: DEMO_PROJECTS.map((p) => ({
      name: p.name,
      path: `${DEMO_ROOT}/${p.name}`,
      active: activeNames.has(p.name),
      branch: p.branch,
      dirty: p.dirty,
      ahead: p.ahead,
      group: p.group,
    })),
  };
}

// ── Stats view (the usage-viz launch hook) ──────────────────────────────────

const STAT_SESSIONS = [
  { id: 'demo-next', slug: 'next-js', project: 'next.js', label: 'App Router streaming refactor' },
  { id: 'demo-torch', slug: 'pytorch', project: 'pytorch', label: 'Autograd test triage (Codex)' },
  { id: 'demo-whisper', slug: 'whisper', project: 'whisper', label: 'Decoder loop rewrite (Gemini)' },
  { id: 'demo-zellij', slug: 'zellij', project: 'zellij', label: 'Plugin API wiring' },
];

/** Deterministic pseudo-random in [0,1) from an integer seed. */
function rng(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Synthetic `/api/stats` payload — a plausible multi-session usage timeline with
 * cache evictions/reloads, tool + MCP usage, multi-vendor consults, and image
 * turns. Deterministic given (days, now) so screenshots are stable.
 */
export function buildDemoStats(days: number, now: number): StatsPayload {
  const span = days * 86_400_000;
  const start = now - span;
  const turns: StatsTurn[] = [];
  const images: StatsImageGroup[] = [];
  const perSessionTotal = [0, 0, 0, 0];
  const N = Math.min(240, 24 * days); // ~a turn/hour of active work
  for (let i = 0; i < N; i++) {
    const r = rng(i + 1);
    const s = Math.floor(rng(i * 3.1 + 7) * STAT_SESSIONS.length);
    const t = Math.round(start + (i / N) * span + rng(i * 1.7) * (span / N));
    const total = Math.round(4_000 + r * 44_000);
    const billed = Math.round(total * (0.2 + rng(i * 2.3) * 0.5));
    const ctx = Math.round(30_000 + rng(i * 5.9) * 160_000);
    // ~1 in 9 turns is a cache eviction (1) or reload (2) — the cache-miss story.
    const f: 0 | 1 | 2 = rng(i * 4.2) > 0.88 ? (rng(i * 6.1) > 0.5 ? 2 : 1) : 0;
    turns.push({ t, s, k: total, b: billed, c: ctx, f });
    perSessionTotal[s] += total;
    if (rng(i * 9.3) > 0.9) images.push({ s, bucket: Math.round(t / 3_600_000) * 3_600_000, n: 1 + Math.floor(rng(i) * 6) });
  }
  const totalTokens = perSessionTotal.reduce((a, b) => a + b, 0);
  const imageCount = images.reduce((a, g) => a + g.n, 0);
  return {
    days,
    turns,
    sessions: STAT_SESSIONS.map((s, i) => ({ id: s.id, slug: s.slug, project: s.project, label: s.label, total: perSessionTotal[i] })),
    tools: [
      { name: 'Read', calls: 214, resultTokens: 1_240_000, mcp: false },
      { name: 'Edit', calls: 96, resultTokens: 210_000, mcp: false },
      { name: 'Bash', calls: 73, resultTokens: 540_000, mcp: false },
      { name: 'Grep', calls: 61, resultTokens: 180_000, mcp: false },
      // MCP tools MUST use the real mcp__server__tool naming — the Stats view
      // extracts the server via name.split('__')[1].
      { name: 'mcp__cldctrl__consult_agent', calls: 18, resultTokens: 430_000, mcp: true },
      { name: 'mcp__cldctrl__search_conversations', calls: 12, resultTokens: 95_000, mcp: true },
    ],
    images,
    apiErrors: [{ t: start + span * 0.32, s: 1 }, { t: start + span * 0.71, s: 0 }],
    toolResultTokens: 2_170_000,
    mcpResultTokens: 525_000,
    subagentRuns: 7,
    // Multi-vendor council usage — the moat, visible in Stats.
    consults: { codex: 12, gemini: 4, claude: 3 },
    totalTokens,
    tokensByVendor: { claude: Math.round(totalTokens * 0.62), codex: Math.round(totalTokens * 0.38) },
    codexRateLimit: { usedPercent: 41, windowMinutes: 300 },
    imageCount,
    limits: { fiveH: 5_000_000, sevenD: 70_000_000 },
    generatedAt: now,
  };
}

// ── Cross-vendor conversation search (the memory/search story) ───────────────

export function buildDemoSearch(query: string): { results: SearchResult[]; query: string } {
  const q = (query || 'streaming').trim();
  const base: Array<Omit<SearchResult, 'snippet'> & { snippet: string }> = [
    { sessionId: 'demo-next', project: 'next.js', projectPath: `${DEMO_ROOT}/next.js`, date: '2 days ago',
      snippet: `…switched the route handler to a streaming Response so the ${q} chunks flush incrementally…`, count: 6, vendor: 'claude' },
    { sessionId: 'demo-torch', project: 'pytorch', projectPath: `${DEMO_ROOT}/pytorch`, date: '4 hours ago',
      snippet: `…Codex traced the ${q} regression to a stale autograd cache and proposed the guard…`, count: 4, vendor: 'codex' },
    { sessionId: 'demo-whisper', project: 'whisper', projectPath: `${DEMO_ROOT}/whisper`, date: 'yesterday',
      snippet: `…the ${q} decoder now yields partial transcripts every 200ms without re-running the encoder…`, count: 3, vendor: 'claude' },
  ];
  return { results: base, query: q };
}

