/**
 * Shared shape of the `/api/overview` payload. Imported by BOTH the server
 * (`serve.ts` `buildOverview()`) and the browser client so they cannot drift.
 */

export interface UsageWindow {
  tokens: number;
  messages: number;
  percent: number | null; // null = no live rate data yet (show est. tokens)
  resetIn: string | null;
}

export interface HeatCell {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface TouchedFile {
  path: string; // project-relative, forward slashes
  reads: number;
  writes: number;
  lastTs: number;
}

export interface SessionInfo {
  id: string | null;
  project: string;
  path: string;
  status: 'active' | 'idle';
  currentAction: string | null;
  lastActivity: string; // ISO
  tokens: number;
  messages: number;
  assistantTurns: number;
  toolCalls: number;
  contextSize: number;
  contextWindow?: number; // true window (server infers 1M beta from observed peak)
  durationMs: number;
  model: string | null;
  files: TouchedFile[];
}

export interface ProjectInfo {
  name: string;
  path: string;
  active: boolean;
  branch: string | null;
  dirty: number;
  ahead: number;
  group: string;
}

export interface OverviewPayload {
  version: string;
  generatedAt: string; // ISO
  tier: string | null;
  features: { agentTerminal: boolean; agents: Array<{ id: string; label: string; available: boolean }>; openExplorer?: boolean; openVscode?: boolean };
  usage: {
    fiveHour: UsageWindow;
    sevenDay: UsageWindow;
    live: boolean;
    overage: { percent: number; status: string; resetIn: string } | null;
    daily: HeatCell[];
    dailyCommits: HeatCell[];
  };
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  /** A search the control-plane agent pushed to the dashboard (agent → dashboard). */
  bridge: { query: string; note?: string; results: SearchResult[]; ts: number } | null;
  /** A scratchpad the agent asked to pop open (agent → dashboard). */
  scratch: { path: string; title: string; ts: number } | null;
  /** A new session CTRL asked to open as a cockpit tile (agent → dashboard). */
  cockpitLaunches?: Array<{ projectPath: string; project?: string; prompt?: string; ts: number }>;
  /** Messages to inject into a running cockpit session (agent → dashboard, #9). */
  cockpitInjects?: Array<{ sessionId: string; text: string; autoSend?: boolean; note?: string; ts: number }>;
  /** tileId → the sessionId its 'new' agent created (so the client can resume it after a restart). */
  terminalSessions?: Record<string, string>;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

// ── project detail (fetched on tab open) ─────────────────────

export interface ProjectCommit {
  hash: string;
  subject: string;
  date: string;
  additions: number;
  deletions: number;
}

export interface ProjectIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
  author?: string;
}

export interface ProjectSessionRow {
  id: string;
  summary: string;
  firstPrompt: string | null;
  modified: string;
  branch: string | null;
  tokens: number;
  messages: number;
  cost: number | null;
}

export interface ProjectActivity {
  tokens: HeatCell[];
  commits: HeatCell[];
}

export interface FileEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  fileIcon: string;
  iconColor: string | null;
  isClaude: boolean;
  childCount: number | null;
}

export type DetailTab = 'sessions' | 'commits' | 'issues' | 'files';

export interface SearchResult {
  sessionId: string;
  project: string;
  projectPath: string;
  date: string;
  snippet: string;
  count: number;
  vendor?: 'claude' | 'codex'; // which CLI the session belongs to (Codex resume isn't cockpit-wired yet)
}

// ── Notes (/api/notes) — a project's notepads across its conversations ──
export interface NoteEntry { path: string; title: string; preview: string; project: string; conversation: string; updated: number; }

// ── Stats tab (/api/stats) — mirror of core/stats.ts StatsPayload ──
export interface StatsTurn { t: number; s: number; k: number; b: number; c: number; f: 0 | 1 | 2; }
export interface StatsSession { id: string; slug: string; project: string; label: string; total: number; }
export interface StatsTool { name: string; calls: number; resultTokens: number; mcp: boolean; }
export interface StatsImageGroup { s: number; bucket: number; n: number; }
export interface StatsErr { t: number; s: number; }
export interface StatsPayload {
  days: number;
  turns: StatsTurn[];
  sessions: StatsSession[];
  tools: StatsTool[];
  images: StatsImageGroup[];
  apiErrors: StatsErr[];
  toolResultTokens: number;
  mcpResultTokens: number;
  subagentRuns: number;
  consults: Record<string, number>;
  totalTokens: number;
  imageCount: number;
  limits: { fiveH: number | null; sevenD: number | null };
  generatedAt: number;
}
