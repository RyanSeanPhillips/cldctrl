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
import type { OverviewPayload, HeatCell } from '../web/types.js';

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
