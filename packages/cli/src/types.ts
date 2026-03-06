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

export interface SessionActivity {
  messages: number;
  tokens: number;
  toolCalls: { reads: number; writes: number; bash: number; other: number };
  mcpCalls: Record<string, McpServerSummary>;  // server name → summary
  agentSpawns: number;
  interruptions: number;
  models: Record<string, number>;
  thinkingTokens: number;
  duration: number;  // ms between first and last timestamp
  hourlyActivity: number[];  // 24 elements, hourly message counts
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
}

// ── Active process info ────────────────────────────────────

export interface ActiveSession {
  pid: number;
  sessionId: string;
  projectPath: string;
  startTime: Date;
  lastActivity: Date;
  currentAction?: string;
  stats: SessionActivity;
  tracked?: boolean;  // true = launched from cc with PID tracking
  idle?: boolean;     // true = tracked PID alive but JSONL stale
}

export interface UsageStats {
  tokens: number;
  messages: number;
  date: string; // ISO date string YYYY-MM-DD
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
  detailSection: 'sessions' | 'issues' | 'commits';  // which list is active in detail pane
  activeGame: string | null;
  helpIndex: number;  // selected item index in help overlay
}
