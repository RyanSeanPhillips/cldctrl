/**
 * Shared type definitions for CLD CTRL CLI.
 * Mirrors the PowerShell config schema (v4) and data structures.
 */

// ── Config ──────────────────────────────────────────────────

export interface ProjectConfig {
  name: string;
  path: string;
  hotkey?: string;
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
  dateLabel: string;
  stats?: SessionStats;
}

export interface SessionStats {
  messages: number;
  tokens: number;
}

export interface UsageStats {
  tokens: number;
  messages: number;
  date: string; // ISO date string YYYY-MM-DD
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  labels: string[];
  repository?: string;
}

// ── Daemon cache ────────────────────────────────────────────

export interface DaemonCache {
  lastUpdated: string;
  gitStatuses: Record<string, GitStatus>;
  issues: Record<string, Issue[]>;
  usageStats?: UsageStats;
}

// ── Navigation ──────────────────────────────────────────────

export type FocusPane = 'projects' | 'details';
export type AppMode = 'normal' | 'filter' | 'help' | 'settings' | 'welcome';

export interface AppState {
  config: Config;
  projects: Project[];
  selectedIndex: number;
  focusPane: FocusPane;
  mode: AppMode;
  filterText: string;
  scrollOffset: number;
  detailIndex: number;  // selected session index in detail pane
}
