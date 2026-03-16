/**
 * Shared type definitions for CLD CTRL CLI.
 * Mirrors the PowerShell config schema (v4) and data structures.
 */

// ── Config ──────────────────────────────────────────────────

export interface ProjectConfig {
  name: string;
  path: string;
  hotkey?: string;
  alias?: string;
}

export interface LaunchConfig {
  explorer: boolean;
  vscode: boolean;
  claude: boolean;
}

export interface GlobalHotkeyConfig {
  modifiers: string;
  key: string;
}

export interface NotificationsConfig {
  github_issues: {
    enabled: boolean;
    poll_interval_minutes: number;
  };
  usage_stats: {
    enabled: boolean;
    show_tooltip: boolean;
  };
}

export interface FeaturesConfig {
  /** Show rate limit bars (5h, 7d) in project pane. */
  rate_limit_bars: boolean;
  /** Show estimated dollar costs per session and daily. */
  cost_estimates: boolean;
  /** Show lines added/deleted per day in stats panel. */
  code_stats: boolean;
  /** Show calendar heatmap in project pane. */
  calendar_heatmap: boolean;
  /** Enable live session tailing (round summaries, token counter). */
  live_session_tailing: boolean;
  /** Enable project auto-discovery from ~/.claude/projects/. */
  auto_discovery: boolean;
  /** Show commands/skills section in project pane. */
  commands_section: boolean;
  /** Pulsing animations (active badges, today highlight). */
  animations: boolean;
}

export interface Config {
  config_version: number;
  projects: ProjectConfig[];
  hidden_projects: string[];
  launch: LaunchConfig;
  icon_color: string;
  global_hotkey: GlobalHotkeyConfig;
  project_manager: { enabled: boolean };
  notifications: NotificationsConfig;
  daily_budget_tokens?: number;
  features?: Partial<FeaturesConfig>;
}

// ── Runtime ─────────────────────────────────────────────────

export interface Project {
  name: string;
  path: string;
  slug: string;
  pinned: boolean;
  discovered: boolean;
  gitStatus?: GitStatus;
  issueCount?: number;
  lastActivity?: Date;
}

export interface GitStatus {
  branch: string;
  dirty: number;    // count of modified/untracked files
  ahead: number;    // commits ahead of remote
  behind: number;   // commits behind remote
  available: boolean;
}

export interface Session {
  id: string;
  filePath: string;
  modified: Date;
  summary: string;
  firstPrompt?: string;
  richSummary?: string;
  dateLabel: string;
  stats?: SessionStats;
  gitBranch?: string;
  /** Actual USD cost from Claude's stats (not estimated). */
  cost?: number;
}

export interface SessionStats {
  messages: number;
  tokens: number;
}

// ── Extended session activity ──────────────────────────────

export interface McpToolUsage {
  server: string;   // MCP server name (e.g. "codeindex", "app")
  tool: string;     // tool name (e.g. "get_context", "app_screenshot")
  count: number;
}

export interface McpServerSummary {
  name: string;
  tools: Record<string, number>;  // tool name → call count
  totalCalls: number;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionActivity {
  messages: number;
  tokens: number;
  tokenBreakdown: TokenBreakdown;
  inputPerMessage: number[];   // input_tokens for each assistant msg (for context health)
  toolCalls: { reads: number; writes: number; bash: number; other: number };
  mcpCalls: Record<string, McpServerSummary>;  // server name → summary
  agentSpawns: number;
  interruptions: number;
  models: Record<string, number>;
  thinkingTokens: number;
  duration: number;  // ms between first and last timestamp
  hourlyActivity: number[];  // 24 elements, hourly message counts
  assistantTurns: number;    // total assistant API responses (each is an API round-trip)
  toolUseTurns: number;      // assistant turns that contained at least one tool_use block
}

// ── Git commits ────────────────────────────────────────────

export interface GitCommit {
  hash: string;
  subject: string;
  date: string;       // ISO
  additions: number;
  deletions: number;
  files?: string[];
}

// ── Daily usage bucket for heatmaps ────────────────────────

export interface DailyUsage {
  date: string;  // YYYY-MM-DD
  tokens: number;
  messages: number;
  commits?: number;
  additions?: number;
  deletions?: number;
}

// ── Active process info ────────────────────────────────────

export interface ActiveSession {
  pid: number;
  sessionId: string;
  projectPath: string;
  /** Full path to the session's JSONL file (for per-session enrichment). */
  sessionFilePath?: string;
  startTime: Date;
  lastActivity: Date;
  currentAction?: string;
  stats: SessionActivity;
  tracked?: boolean;  // true = launched from cc with PID tracking
  idle?: boolean;     // true = tracked PID alive but JSONL stale
  /** One-line summaries of completed rounds (most recent last). */
  roundSummaries?: string[];
}

export interface UsageStats {
  tokens: number;
  messages: number;
  date: string; // ISO date string YYYY-MM-DD
}

export interface UsageBudget {
  /** Effective daily token limit (auto-detected from tier or user-configured). */
  limit: number;
  /** Current token usage (from rolling 5h window). */
  used: number;
  /** Percentage used (0-100+). */
  percent: number;
  /** Subscription tier label (e.g. "Max 5x", "Pro", "Free"). */
  tierLabel: string;
  /** Whether limit was auto-detected (true) or user-configured (false). */
  autoDetected: boolean;
  /** Live API rate limit data (from probe). Null if not yet fetched. */
  rateLimits?: {
    /** 5-hour window utilization (0-100%). */
    fiveHourPercent: number;
    /** 7-day window utilization (0-100%). */
    sevenDayPercent: number;
    /** Human-readable time until 5h window resets. */
    fiveHourResetIn: string;
    /** Human-readable time until 7d window resets. */
    sevenDayResetIn: string;
    /** Whether the API allows requests. */
    status: string;
    /** Whether a fallback model is available. */
    fallbackAvailable: boolean;
    /** True when using paid extra tokens beyond plan limit. */
    usingExtraTokens: boolean;
    /** The threshold percentage at which fallback/extra kicks in. */
    fallbackThreshold: number;
    /** Overage (extra tokens) utilization percentage (0-100%). */
    overagePercent: number;
    /** Whether overage/extra tokens are enabled for this account. */
    overageEnabled: boolean;
    /** Human-readable time until overage window resets. */
    overageResetIn: string;
  } | null;
}

export interface Issue {
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  createdAt: string;
  labels: string[];
  repository?: string;
  richSummary?: string;
}

// ── Daemon cache ────────────────────────────────────────────

export interface DaemonCache {
  lastUpdated: string;
  gitStatuses: Record<string, GitStatus>;
  issues: Record<string, Issue[]>;
  usageStats?: UsageStats;
  usageByProject?: Record<string, DailyUsage[]>;
  recentCommits?: Record<string, GitCommit[]>;
  commitActivity?: Record<string, DailyUsage[]>;
}

// ── Navigation ──────────────────────────────────────────────

export type FocusPane = 'projects' | 'details';
export type AppMode = 'normal' | 'filter' | 'help' | 'settings' | 'welcome' | 'prompt' | 'game';
export type LeftSection = 'projects' | 'conversations';

export interface AppState {
  config: Config;
  projects: Project[];
  selectedIndex: number;
  focusPane: FocusPane;
  mode: AppMode;
  filterText: string;
  promptText: string;
  scrollOffset: number;
  detailIndex: number;  // selected item index in detail pane
  detailSection: 'sessions' | 'issues' | 'commits' | 'files';  // which list is active in detail pane
  scanning: boolean;  // true while project scanner is running
  activeGame: string | null;
  helpIndex: number;  // selected item index in help overlay
  settingsIndex: number;  // selected item index in settings editor
  settingsTab: 'general' | 'permissions';  // which tab is active in settings
  permissionsIndex: number;  // selected item index in permissions tab
  leftSection: LeftSection;  // which section of the left pane has the cursor
  conversationIndex: number;  // selected conversation in conversations section
  expandedConversation: boolean;  // true = show single conversation detail in right pane
  showHidden: boolean;  // true = include hidden projects in the project list
}
