/**
 * Demo mode: synthetic data for screenshots and GIF recording.
 * Activated with `cldctrl --demo` — loads fake projects, sessions, issues, etc.
 * into the real TUI so users can take screenshots of a fully populated app.
 */

import type {
  Config, Project, GitStatus, Session, SessionStats, Issue,
  GitCommit, DailyUsage, UsageStats, ActiveSession, SessionActivity,
  McpServerSummary,
} from '../types.js';
import type { CommandUsageCounts } from './command-usage.js';

// ── Global flag + variant ───────────────────────────────────

export type DemoVariant = 'full' | 'fresh' | 'no-github' | 'minimal';

let _demoMode = false;
let _variant: DemoVariant = 'full';
export function isDemoMode(): boolean { return _demoMode; }
export function setDemoMode(variant: DemoVariant = 'full'): void { _demoMode = true; _variant = variant; }
export function getDemoVariant(): DemoVariant { return _variant; }

// ── Helpers ──────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3600_000);
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Config ──────────────────────────────────────────────────

export const DEMO_CONFIG: Config = {
  config_version: 4,
  projects: [
    { name: 'CLD CTRL', path: '/home/dev/cldctrl' },
    { name: 'Acme API', path: '/home/dev/acme-api' },
    { name: 'React Dashboard', path: '/home/dev/react-dashboard' },
    { name: 'ML Pipeline', path: '/home/dev/ml-pipeline' },
  ],
  hidden_projects: [],
  launch: { explorer: true, vscode: true, claude: true },
  icon_color: '#DA8F4E',
  global_hotkey: { modifiers: 'Ctrl', key: 'Up' },
  project_manager: { enabled: true },
  notifications: {
    github_issues: { enabled: true, poll_interval_minutes: 5 },
    usage_stats: { enabled: true, show_tooltip: true },
  },
  daily_budget_tokens: 5_000_000,
};

// ── Projects ────────────────────────────────────────────────

export const DEMO_PROJECTS: Project[] = [
  { name: 'CLD CTRL', path: '/home/dev/cldctrl', slug: 'cldctrl', pinned: true, discovered: false },
  { name: 'Acme API', path: '/home/dev/acme-api', slug: 'acme-api', pinned: true, discovered: false },
  { name: 'React Dashboard', path: '/home/dev/react-dashboard', slug: 'react-dashboard', pinned: true, discovered: false },
  { name: 'ML Pipeline', path: '/home/dev/ml-pipeline', slug: 'ml-pipeline', pinned: true, discovered: false },
  { name: 'Design System', path: '/home/dev/design-system', slug: 'design-system', pinned: false, discovered: true },
  { name: 'Docs Site', path: '/home/dev/docs-site', slug: 'docs-site', pinned: false, discovered: true },
  { name: 'Infrastructure', path: '/home/dev/infra', slug: 'infra', pinned: false, discovered: true },
];

// ── Git statuses ────────────────────────────────────────────

export const DEMO_GIT_STATUSES = new Map<string, GitStatus>([
  ['/home/dev/cldctrl', { branch: 'main', dirty: 3, ahead: 1, behind: 0, available: true }],
  ['/home/dev/acme-api', { branch: 'feature/auth', dirty: 0, ahead: 0, behind: 2, available: true }],
  ['/home/dev/react-dashboard', { branch: 'develop', dirty: 7, ahead: 0, behind: 0, available: true }],
  ['/home/dev/ml-pipeline', { branch: 'main', dirty: 0, ahead: 0, behind: 0, available: true }],
  ['/home/dev/design-system', { branch: 'main', dirty: 1, ahead: 0, behind: 0, available: true }],
  ['/home/dev/docs-site', { branch: 'main', dirty: 0, ahead: 3, behind: 0, available: true }],
  ['/home/dev/infra', { branch: 'main', dirty: 0, ahead: 0, behind: 0, available: true }],
]);

// ── Sessions ────────────────────────────────────────────────

function makeStats(messages: number, tokens: number): SessionStats {
  return { messages, tokens };
}

export const DEMO_SESSIONS: Record<string, Session[]> = {
  '/home/dev/cldctrl': [
    {
      id: 'demo-s1', filePath: '/demo/s1.jsonl', modified: hoursAgo(1),
      summary: 'Add mini TUI popup with 3-phase wizard', firstPrompt: 'Build the mini TUI mode',
      richSummary: 'Implemented the mini TUI popup with project selection, action menu, and session browser. Added --mini flag detection, keyboard navigation with arrow keys, and filter mode. Startup time under 400ms using daemon cache.',
      dateLabel: '1h ago', stats: makeStats(47, 128_000),
    },
    {
      id: 'demo-s2', filePath: '/demo/s2.jsonl', modified: hoursAgo(4),
      summary: 'Fix session activity parsing for MCP calls', firstPrompt: 'MCP tool usage not showing up',
      richSummary: 'Fixed MCP tool usage tracking by parsing tool_use blocks with server prefixes. Added McpServerSummary type and aggregation logic. Now correctly shows codeindex, filesystem, and custom MCP server usage in session previews.',
      dateLabel: '4h ago', stats: makeStats(23, 64_000),
    },
    {
      id: 'demo-s3', filePath: '/demo/s3.jsonl', modified: daysAgo(1),
      summary: 'Add calendar heatmap and usage history', firstPrompt: 'Add a usage heatmap',
      richSummary: 'Built a 28-day calendar heatmap component showing daily token usage with 5-tier color intensity. Added per-project and aggregate views. Integrated with usage history scanning from JSONL session files.',
      dateLabel: 'Yesterday', stats: makeStats(35, 96_000),
    },
    {
      id: 'demo-s4', filePath: '/demo/s4.jsonl', modified: daysAgo(3),
      summary: 'Implement AI session summaries with Sonnet', firstPrompt: 'Auto-summarize sessions',
      dateLabel: '3 days ago', stats: makeStats(18, 42_000),
    },
    {
      id: 'demo-s5', filePath: '/demo/s5.jsonl', modified: daysAgo(5),
      summary: 'Set up project auto-discovery from ~/.claude', firstPrompt: 'Discover projects automatically',
      dateLabel: '5 days ago', stats: makeStats(12, 28_000),
    },
  ],
  '/home/dev/acme-api': [
    {
      id: 'demo-s6', filePath: '/demo/s6.jsonl', modified: hoursAgo(2),
      summary: 'Add OAuth2 refresh token rotation', firstPrompt: 'Implement token rotation',
      richSummary: 'Added refresh token rotation with sliding window expiry. Tokens are now invalidated after single use and replaced with a new token on each refresh. Added migration for the tokens table to track rotation chain.',
      dateLabel: '2h ago', stats: makeStats(31, 85_000),
    },
    {
      id: 'demo-s13', filePath: '/demo/s13.jsonl', modified: hoursAgo(5),
      summary: 'Add data validation pipeline for CSV imports', firstPrompt: 'Validate CSV uploads',
      dateLabel: '5h ago', stats: makeStats(14, 36_000),
      subfolder: 'data', projectPath: '/home/dev/acme-api/data',
    },
    {
      id: 'demo-s7', filePath: '/demo/s7.jsonl', modified: daysAgo(1),
      summary: 'Fix rate limiter for WebSocket connections', firstPrompt: 'Rate limiting broken on WS',
      dateLabel: 'Yesterday', stats: makeStats(15, 38_000),
    },
    {
      id: 'demo-s14', filePath: '/demo/s14.jsonl', modified: daysAgo(1),
      summary: 'Normalize address fields in migration script', firstPrompt: 'Clean up address data',
      dateLabel: 'Yesterday', stats: makeStats(9, 22_000),
      subfolder: 'data', projectPath: '/home/dev/acme-api/data',
    },
    {
      id: 'demo-s8', filePath: '/demo/s8.jsonl', modified: daysAgo(2),
      summary: 'Add pagination to /users endpoint', firstPrompt: 'Users endpoint needs pagination',
      dateLabel: '2 days ago', stats: makeStats(22, 55_000),
    },
  ],
  '/home/dev/react-dashboard': [
    {
      id: 'demo-s9', filePath: '/demo/s9.jsonl', modified: hoursAgo(6),
      summary: 'Build chart component with D3 integration', firstPrompt: 'Create interactive charts',
      richSummary: 'Built a reusable Chart component wrapping D3.js with React lifecycle management. Supports line, bar, and area chart types with responsive resizing, tooltips, and animated transitions. Uses useRef for D3 DOM access.',
      dateLabel: '6h ago', stats: makeStats(42, 115_000),
    },
    {
      id: 'demo-s10', filePath: '/demo/s10.jsonl', modified: daysAgo(1),
      summary: 'Refactor state management to Zustand', firstPrompt: 'Migrate from Redux',
      dateLabel: 'Yesterday', stats: makeStats(28, 72_000),
    },
  ],
  '/home/dev/ml-pipeline': [
    {
      id: 'demo-s11', filePath: '/demo/s11.jsonl', modified: daysAgo(2),
      summary: 'Add batch inference endpoint', firstPrompt: 'Batch prediction API',
      dateLabel: '2 days ago', stats: makeStats(19, 48_000),
    },
  ],
  '/home/dev/design-system': [],
  '/home/dev/docs-site': [
    {
      id: 'demo-s12', filePath: '/demo/s12.jsonl', modified: daysAgo(4),
      summary: 'Add API reference auto-generation', firstPrompt: 'Generate API docs from types',
      dateLabel: '4 days ago', stats: makeStats(16, 35_000),
    },
  ],
  '/home/dev/infra': [],
};

// ── Issues ──────────────────────────────────────────────────

export const DEMO_ISSUES: Record<string, Issue[]> = {
  '/home/dev/cldctrl': [
    {
      number: 12, title: 'Support macOS global hotkey with skhd',
      state: 'open', url: 'https://github.com/demo/cldctrl/issues/12',
      createdAt: daysAgo(2).toISOString(), labels: ['enhancement', 'macos'], author: 'macos-fan',
      richSummary: 'Request to support macOS hotkeys via skhd or Hammerspoon. Requires platform detection and shell script generation for key binding registration.',
    },
    {
      number: 8, title: 'Session list shows stale data after git checkout',
      state: 'open', url: 'https://github.com/demo/cldctrl/issues/8',
      createdAt: daysAgo(5).toISOString(), labels: ['bug'], author: 'devuser42',
      richSummary: 'Session list does not refresh after switching branches. The project slug mapping uses the old branch path, so sessions from other branches appear mixed.',
    },
    {
      number: 15, title: 'Add Linux desktop integration for hotkey',
      state: 'open', url: 'https://github.com/demo/cldctrl/issues/15',
      createdAt: daysAgo(1).toISOString(), labels: ['enhancement', 'linux'], author: 'tux-lover',
    },
  ],
  '/home/dev/acme-api': [
    {
      number: 142, title: 'WebSocket connections leak on reconnect',
      state: 'open', url: 'https://github.com/demo/acme-api/issues/142',
      createdAt: daysAgo(1).toISOString(), labels: ['bug', 'P1'], author: 'sre-oncall',
      richSummary: 'WebSocket handler does not properly close the old connection when a client reconnects with the same session ID. Causes memory growth and file descriptor exhaustion under load.',
    },
    {
      number: 139, title: 'Add OpenAPI 3.1 spec generation',
      state: 'open', url: 'https://github.com/demo/acme-api/issues/139',
      createdAt: daysAgo(7).toISOString(), labels: ['enhancement'], author: 'api-team',
    },
  ],
  '/home/dev/react-dashboard': [
    {
      number: 67, title: 'Charts render blank on Safari 16',
      state: 'open', url: 'https://github.com/demo/dashboard/issues/67',
      createdAt: daysAgo(3).toISOString(), labels: ['bug', 'browser-compat'], author: 'qa-safari',
    },
  ],
  '/home/dev/ml-pipeline': [],
  '/home/dev/design-system': [],
  '/home/dev/docs-site': [],
  '/home/dev/infra': [],
};

// ── Git commits ─────────────────────────────────────────────

export const DEMO_COMMITS: Record<string, GitCommit[]> = {
  '/home/dev/cldctrl': [
    { hash: 'a1b2c3d', subject: 'Add mini TUI popup with 3-phase wizard', date: hoursAgo(1).toISOString(), additions: 342, deletions: 18, files: ['src/tui/MiniApp.tsx', 'src/tui/hooks/useMiniState.ts', 'src/index.ts'] },
    { hash: 'e4f5g6h', subject: 'Fix session activity parsing for MCP calls', date: hoursAgo(4).toISOString(), additions: 67, deletions: 23, files: ['src/core/activity.ts'] },
    { hash: 'i7j8k9l', subject: 'Add calendar heatmap component', date: daysAgo(1).toISOString(), additions: 189, deletions: 4, files: ['src/tui/components/CalendarHeatmap.tsx', 'src/core/usage.ts'] },
    { hash: 'm0n1o2p', subject: 'Implement AI session summaries', date: daysAgo(3).toISOString(), additions: 156, deletions: 12, files: ['src/core/summaries.ts', 'src/tui/components/DetailPane.tsx'] },
    { hash: 'q3r4s5t', subject: 'Add GitHub issue tracking', date: daysAgo(5).toISOString(), additions: 98, deletions: 7, files: ['src/core/github.ts'] },
  ],
  '/home/dev/acme-api': [
    { hash: 'u6v7w8x', subject: 'Add OAuth2 refresh token rotation', date: hoursAgo(2).toISOString(), additions: 234, deletions: 45, files: ['src/auth/tokens.ts', 'migrations/005_token_rotation.sql'] },
    { hash: 'y9z0a1b', subject: 'Fix rate limiter for WebSocket connections', date: daysAgo(1).toISOString(), additions: 38, deletions: 12, files: ['src/middleware/rate-limit.ts'] },
    { hash: 'c2d3e4f', subject: 'Add pagination to /users endpoint', date: daysAgo(2).toISOString(), additions: 89, deletions: 15, files: ['src/routes/users.ts', 'src/utils/paginate.ts'] },
  ],
  '/home/dev/react-dashboard': [
    { hash: 'g5h6i7j', subject: 'Build chart component with D3 integration', date: hoursAgo(6).toISOString(), additions: 412, deletions: 8, files: ['src/components/Chart.tsx', 'src/hooks/useD3.ts'] },
    { hash: 'k8l9m0n', subject: 'Refactor state management to Zustand', date: daysAgo(1).toISOString(), additions: 156, deletions: 287, files: ['src/store.ts', 'src/components/Dashboard.tsx'] },
  ],
  '/home/dev/ml-pipeline': [
    { hash: 'o1p2q3r', subject: 'Add batch inference endpoint', date: daysAgo(2).toISOString(), additions: 178, deletions: 23, files: ['src/inference/batch.py', 'src/api/routes.py'] },
  ],
  '/home/dev/design-system': [],
  '/home/dev/docs-site': [
    { hash: 's4t5u6v', subject: 'Add API reference auto-generation', date: daysAgo(4).toISOString(), additions: 245, deletions: 0, files: ['scripts/gen-api-docs.ts', 'docs/api/README.md'] },
  ],
  '/home/dev/infra': [],
};

// ── Active sessions (live) ──────────────────────────────────

const demoActivity: SessionActivity = {
  messages: 12,
  tokens: 34_500,
  tokenBreakdown: { input: 18_000, output: 12_000, cacheRead: 3_500, cacheWrite: 1_000 },
  inputPerMessage: [1200, 1800, 2400, 3100, 3800, 4500, 5200, 5900, 6600, 7300, 8000, 8700],
  toolCalls: { reads: 18, writes: 5, bash: 3, other: 2 },
  mcpCalls: {
    codeindex: {
      name: 'codeindex',
      tools: { search: 4, get_context: 2, callers: 1 },
      totalCalls: 7,
    },
  },
  agentSpawns: 2,
  interruptions: 0,
  models: { 'claude-sonnet-4-20250514': 12 },
  thinkingTokens: 8_200,
  duration: 1_800_000,
  assistantTurns: 38,    // ~3.2 turns per user message
  toolUseTurns: 28,      // ~74% of turns use tools
  hourlyActivity: (() => {
    // Populate around the current hour so timeline shows data
    const h = new Array(24).fill(0);
    const now = new Date().getHours();
    h[(now - 4 + 24) % 24] = 2;
    h[(now - 3 + 24) % 24] = 5;
    h[(now - 2 + 24) % 24] = 8;
    h[(now - 1 + 24) % 24] = 4;
    h[now] = 6;
    return h;
  })(),
};

export const DEMO_ACTIVE_SESSIONS = new Map<string, ActiveSession>([
  ['/home/dev/cldctrl', {
    pid: 12345,
    sessionId: 'demo-s1', // matches first session in DEMO_SESSIONS
    projectPath: '/home/dev/cldctrl',
    startTime: minutesAgo(32),
    lastActivity: minutesAgo(1),
    currentAction: 'Writing src/tui/MiniApp.tsx',
    stats: demoActivity,
    tracked: true,
    idle: false,
    roundSummaries: [
      'Added cross-platform hotkey setup for macOS and Linux',
      'Fixed diff renderer flicker by clamping to terminal height',
      'Added animated token counter with ease-out curve to status bar',
    ],
  }],
  ['/home/dev/acme-api', {
    pid: 12346,
    sessionId: 'demo-s6', // matches first session in acme-api DEMO_SESSIONS
    projectPath: '/home/dev/acme-api',
    startTime: minutesAgo(15),
    lastActivity: minutesAgo(3),
    currentAction: 'Reading src/auth/tokens.ts',
    stats: { ...demoActivity, messages: 6, tokens: 18_200, tokenBreakdown: { input: 10_000, output: 6_000, cacheRead: 1_800, cacheWrite: 400 }, inputPerMessage: [1500, 2200, 3000, 3800, 4500, 5200], toolCalls: { reads: 8, writes: 2, bash: 1, other: 0 }, hourlyActivity: (() => { const h = new Array(24).fill(0); const now = new Date().getHours(); h[(now - 1 + 24) % 24] = 3; h[now] = 3; return h; })() },
    tracked: true,
    idle: false,
    roundSummaries: [
      'Fixed JWT refresh token rotation vulnerability in auth flow',
      'Added rate limiting middleware to all auth endpoints',
    ],
  }],
  ['/home/dev/react-dashboard', {
    pid: 12347,
    sessionId: 'demo-s9',
    projectPath: '/home/dev/react-dashboard',
    startTime: hoursAgo(3),
    lastActivity: hoursAgo(2),
    currentAction: undefined,
    stats: {
      ...demoActivity,
      messages: 42,
      tokens: 145_000,
      tokenBreakdown: { input: 89_000, output: 42_000, cacheRead: 11_200, cacheWrite: 2_800 },
      inputPerMessage: Array.from({ length: 42 }, (_, i) => 1200 + i * 250 + Math.floor(Math.random() * 500)),
      toolCalls: { reads: 56, writes: 23, bash: 8, other: 3 },
      hourlyActivity: (() => { const h = new Array(24).fill(0); const now = new Date().getHours(); h[(now - 4 + 24) % 24] = 6; h[(now - 3 + 24) % 24] = 12; h[(now - 2 + 24) % 24] = 18; h[(now - 1 + 24) % 24] = 4; h[now] = 2; return h; })(),
    },
    tracked: true,
    idle: true,
    roundSummaries: [
      'Built chart component with D3 integration',
      'Added responsive resize handler and tooltip overlay',
      'Refactored state management from Redux to Zustand',
    ],
  }],
  ['/home/dev/ml-pipeline', {
    pid: 12348,
    sessionId: 'demo-s11',
    projectPath: '/home/dev/ml-pipeline',
    startTime: minutesAgo(8),
    lastActivity: minutesAgo(1),
    currentAction: 'Bash python train.py',
    stats: {
      ...demoActivity,
      messages: 3,
      tokens: 4_200,
      tokenBreakdown: { input: 2_100, output: 1_500, cacheRead: 400, cacheWrite: 200 },
      hourlyActivity: (() => { const h = new Array(24).fill(0); h[new Date().getHours()] = 3; return h; })(),
      inputPerMessage: [1200, 1800, 2100],
      toolCalls: { reads: 2, writes: 1, bash: 3, other: 0 },
    },
    tracked: true,
    idle: false,
    roundSummaries: [
      'Set up batch inference endpoint with streaming response',
    ],
  }],
]);

// ── Usage stats ─────────────────────────────────────────────

export const DEMO_USAGE_STATS: UsageStats = {
  tokens: 2_847_000,
  messages: 186,
  date: isoDate(new Date()),
};

// ── Usage history (28-day heatmap) ──────────────────────────

function generateUsageHistory(): Record<string, DailyUsage[]> {
  const projects: Record<string, DailyUsage[]> = {};
  const slugs = [
    '-home-dev-cldctrl',
    '-home-dev-acme-api',
    '-home-dev-react-dashboard',
    '-home-dev-ml-pipeline',
  ];

  for (const slug of slugs) {
    const days: DailyUsage[] = [];
    for (let i = 27; i >= 0; i--) {
      const d = daysAgo(i);
      // Simulate realistic usage patterns — busier on weekdays
      const dayOfWeek = d.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const baseTokens = isWeekend ? 50_000 : 200_000;
      const variance = Math.floor(Math.random() * 150_000);
      const skip = Math.random() < (isWeekend ? 0.4 : 0.1);

      if (!skip) {
        const tokens = baseTokens + variance;
        days.push({
          date: isoDate(d),
          tokens,
          messages: Math.floor(tokens / 2000),
          commits: Math.floor(Math.random() * 4),
        });
      }
    }
    projects[slug] = days;
  }

  return projects;
}

export const DEMO_USAGE_HISTORY = generateUsageHistory();

// ── Commit activity (28-day) ────────────────────────────────

function generateCommitActivity(path: string): DailyUsage[] {
  const days: DailyUsage[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = daysAgo(i);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const commits = isWeekend
      ? (Math.random() < 0.6 ? 0 : Math.floor(Math.random() * 2) + 1)
      : Math.floor(Math.random() * 5);
    if (commits > 0) {
      days.push({ date: isoDate(d), tokens: 0, messages: 0, commits });
    }
  }
  return days;
}

export const DEMO_COMMIT_ACTIVITY: Record<string, DailyUsage[]> = {
  '/home/dev/cldctrl': generateCommitActivity('/home/dev/cldctrl'),
  '/home/dev/acme-api': generateCommitActivity('/home/dev/acme-api'),
  '/home/dev/react-dashboard': generateCommitActivity('/home/dev/react-dashboard'),
  '/home/dev/ml-pipeline': generateCommitActivity('/home/dev/ml-pipeline'),
  '/home/dev/design-system': generateCommitActivity('/home/dev/design-system'),
  '/home/dev/docs-site': generateCommitActivity('/home/dev/docs-site'),
  '/home/dev/infra': generateCommitActivity('/home/dev/infra'),
};

// ── Session activity (for detail preview) ────────────────────

export const DEMO_SESSION_ACTIVITY: SessionActivity = {
  messages: 47,
  tokens: 128_000,
  tokenBreakdown: { input: 72_000, output: 38_000, cacheRead: 14_000, cacheWrite: 4_000 },
  inputPerMessage: Array.from({ length: 47 }, (_, i) => 1200 + i * 180 + Math.floor(Math.random() * 400)),
  toolCalls: { reads: 42, writes: 18, bash: 12, other: 5 },
  mcpCalls: {
    codeindex: {
      name: 'codeindex',
      tools: { search: 8, get_context: 12, callers: 3, file_summary: 2 },
      totalCalls: 25,
    },
    filesystem: {
      name: 'filesystem',
      tools: { read_file: 6, list_directory: 4 },
      totalCalls: 10,
    },
  },
  agentSpawns: 4,
  interruptions: 1,
  models: {
    'claude-sonnet-4-20250514': 38,
    'claude-haiku-4-5-20251001': 9,
  },
  thinkingTokens: 24_600,
  duration: 5_400_000, // 1.5 hours
  assistantTurns: 156,   // ~3.3 turns per user message
  toolUseTurns: 112,     // ~72% of turns use tools
  hourlyActivity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 8, 12, 6, 4, 8, 5, 2, 0, 0, 0, 0, 0, 0, 0],
};

// ── Command usage ───────────────────────────────────────────

export const DEMO_COMMAND_USAGE: CommandUsageCounts = {
  '/commit': 42,
  '/review-pr': 18,
  '/simplify': 15,
  '/review-security': 8,
  '/review-perf': 6,
  '/review-team': 5,
  '/commit --amend': 3,
};

// ── Issue counts (for project list badges) ──────────────────

export const DEMO_ISSUE_COUNTS = new Map<string, number>([
  ['/home/dev/cldctrl', 3],
  ['/home/dev/acme-api', 2],
  ['/home/dev/react-dashboard', 1],
]);

// ── Skills data ─────────────────────────────────────────────

export const DEMO_SKILLS_DATA = {
  commands: [
    { name: '/commit', source: 'built-in', description: 'Create a git commit with AI-generated message' },
    { name: '/review-pr', source: 'built-in', description: 'Review a pull request' },
    { name: '/simplify', source: 'project', description: 'Review changed code for reuse and quality' },
    { name: '/review-security', source: 'project', description: 'Security-focused code review' },
    { name: '/review-perf', source: 'project', description: 'Performance-focused code review' },
    { name: '/review-team', source: 'project', description: 'Multi-agent team code review' },
  ],
  skills: [],
};

// ══════════════════════════════════════════════════════════════
// Demo variants: fresh, no-github, minimal
// ══════════════════════════════════════════════════════════════

// ── "fresh" — first-time user, no projects ───────────────────

const FRESH_CONFIG: Config = {
  config_version: 4,
  projects: [],
  hidden_projects: [],
  launch: { explorer: true, vscode: true, claude: true },
  icon_color: '#DA8F4E',
  global_hotkey: { modifiers: 'Ctrl', key: 'Up' },
  project_manager: { enabled: true },
  notifications: {
    github_issues: { enabled: true, poll_interval_minutes: 5 },
    usage_stats: { enabled: true, show_tooltip: true },
  },
};

// ── "minimal" — 2 projects, few sessions, no live sessions ───

const MINIMAL_CONFIG: Config = {
  ...DEMO_CONFIG,
  projects: [
    { name: 'My App', path: '/home/dev/my-app' },
  ],
};

const MINIMAL_PROJECTS: Project[] = [
  { name: 'My App', path: '/home/dev/my-app', slug: 'my-app', pinned: true, discovered: false },
  { name: 'Side Project', path: '/home/dev/side-project', slug: 'side-project', pinned: false, discovered: true },
];

const MINIMAL_GIT_STATUSES = new Map<string, GitStatus>([
  ['/home/dev/my-app', { branch: 'main', dirty: 2, ahead: 0, behind: 0, available: true }],
  ['/home/dev/side-project', { branch: 'main', dirty: 0, ahead: 0, behind: 0, available: true }],
]);

const MINIMAL_SESSIONS: Record<string, Session[]> = {
  '/home/dev/my-app': [
    {
      id: 'min-s1', filePath: '/demo/min-s1.jsonl', modified: hoursAgo(3),
      summary: 'Set up project structure and initial components', firstPrompt: 'Help me scaffold the app',
      dateLabel: '3h ago', stats: makeStats(12, 32_000),
    },
    {
      id: 'min-s2', filePath: '/demo/min-s2.jsonl', modified: daysAgo(1),
      summary: 'Add authentication flow', firstPrompt: 'Add login and signup pages',
      dateLabel: 'Yesterday', stats: makeStats(8, 18_000),
    },
  ],
  '/home/dev/side-project': [],
};

const MINIMAL_ISSUES: Record<string, Issue[]> = {
  '/home/dev/my-app': [
    {
      number: 1, title: 'Add dark mode support',
      state: 'open', url: 'https://github.com/demo/my-app/issues/1',
      createdAt: daysAgo(1).toISOString(), labels: ['enhancement'], author: 'new-user',
    },
  ],
  '/home/dev/side-project': [],
};

const MINIMAL_COMMITS: Record<string, GitCommit[]> = {
  '/home/dev/my-app': [
    { hash: 'abc1234', subject: 'Set up project structure', date: hoursAgo(3).toISOString(), additions: 145, deletions: 0, files: ['src/App.tsx', 'src/index.ts'] },
    { hash: 'def5678', subject: 'Add authentication flow', date: daysAgo(1).toISOString(), additions: 89, deletions: 5, files: ['src/auth/login.tsx'] },
  ],
  '/home/dev/side-project': [],
};

const MINIMAL_USAGE_STATS: UsageStats = {
  tokens: 185_000,
  messages: 24,
  date: isoDate(new Date()),
};

const MINIMAL_ISSUE_COUNTS = new Map<string, number>([
  ['/home/dev/my-app', 1],
]);

// ── "no-github" — projects + sessions, but no gh CLI ─────────

const NO_GITHUB_ISSUES: Record<string, Issue[]> = {
  '/home/dev/cldctrl': [],
  '/home/dev/acme-api': [],
  '/home/dev/react-dashboard': [],
  '/home/dev/ml-pipeline': [],
  '/home/dev/design-system': [],
  '/home/dev/docs-site': [],
  '/home/dev/infra': [],
};

// ══════════════════════════════════════════════════════════════
// Variant-aware getters (called from hooks)
// ══════════════════════════════════════════════════════════════

export function demoConfig(): Config {
  switch (_variant) {
    case 'fresh': return FRESH_CONFIG;
    case 'minimal': return MINIMAL_CONFIG;
    default: return DEMO_CONFIG;
  }
}

/** Returns true if the variant should show the welcome screen */
export function demoIsNewUser(): boolean {
  return _variant === 'fresh';
}

export function demoProjects(): Project[] {
  switch (_variant) {
    case 'fresh': return [];
    case 'minimal': return MINIMAL_PROJECTS;
    default: return DEMO_PROJECTS;
  }
}

export function demoGitStatuses(): Map<string, GitStatus> {
  switch (_variant) {
    case 'fresh': return new Map();
    case 'minimal': return MINIMAL_GIT_STATUSES;
    default: return DEMO_GIT_STATUSES;
  }
}

export function demoSessions(path: string): Session[] {
  switch (_variant) {
    case 'fresh': return [];
    case 'minimal': return MINIMAL_SESSIONS[path] ?? [];
    default: return DEMO_SESSIONS[path] ?? [];
  }
}

export function demoIssues(path: string): Issue[] {
  switch (_variant) {
    case 'fresh': return [];
    case 'no-github': return [];
    case 'minimal': return MINIMAL_ISSUES[path] ?? [];
    default: return DEMO_ISSUES[path] ?? [];
  }
}

export function demoUsageStats(): UsageStats {
  switch (_variant) {
    case 'fresh': return { tokens: 0, messages: 0, date: isoDate(new Date()) };
    case 'minimal': return MINIMAL_USAGE_STATS;
    default: return DEMO_USAGE_STATS;
  }
}

export function demoActiveSessions(): Map<string, ActiveSession> {
  switch (_variant) {
    case 'fresh':
    case 'minimal':
      return new Map();
    default: return DEMO_ACTIVE_SESSIONS;
  }
}

export function demoCommits(path: string): GitCommit[] {
  switch (_variant) {
    case 'fresh': return [];
    case 'minimal': return MINIMAL_COMMITS[path] ?? [];
    default: return DEMO_COMMITS[path] ?? [];
  }
}

export function demoCommitActivity(path: string): DailyUsage[] {
  switch (_variant) {
    case 'fresh': return [];
    case 'minimal': return [];
    default: return DEMO_COMMIT_ACTIVITY[path] ?? [];
  }
}

export function demoUsageHistory(): Record<string, DailyUsage[]> {
  switch (_variant) {
    case 'fresh': return {};
    case 'minimal': return {};
    default: return DEMO_USAGE_HISTORY;
  }
}

export function demoIssueCounts(): Map<string, number> {
  switch (_variant) {
    case 'fresh': return new Map();
    case 'no-github': return new Map();
    case 'minimal': return MINIMAL_ISSUE_COUNTS;
    default: return DEMO_ISSUE_COUNTS;
  }
}

export function demoCommandUsage(): CommandUsageCounts {
  switch (_variant) {
    case 'fresh': return {};
    case 'minimal': return { '/commit': 3 };
    default: return DEMO_COMMAND_USAGE;
  }
}
