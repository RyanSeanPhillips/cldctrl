/**
 * Shared constants: version, color palettes, unicode characters, defaults.
 */

export const VERSION = '0.1.0';
export const APP_NAME = 'CLD CTRL';
export const APP_CMD = 'cldctrl';
export const APP_TAGLINE = 'Mission control for Claude Code';
export const CONFIG_VERSION = 4;

// ── Color detection ─────────────────────────────────────────

const isTruecolor =
  process.env.COLORTERM === 'truecolor' ||
  process.env.COLORTERM === '24bit';

// Truecolor palette (matches PowerShell GDI+ colors)
const TRUECOLOR = {
  bg: '\x1b[38;2;12;12;12m',
  highlight: '\x1b[38;2;35;95;40m',
  highlightBg: '\x1b[48;2;35;95;40m',
  border: '\x1b[38;2;48;48;48m',
  accent: '\x1b[38;2;204;120;50m',
  text: '\x1b[38;2;204;204;204m',
  textDim: '\x1b[38;2;128;128;128m',
  green: '\x1b[38;2;22;198;12m',
  red: '\x1b[38;2;204;60;60m',
  yellow: '\x1b[38;2;204;204;60m',
  blue: '\x1b[38;2;60;120;204m',
  reset: '\x1b[0m',
} as const;

// 256-color fallback for SSH, Terminal.app, PuTTY
const FALLBACK_256 = {
  bg: '\x1b[38;5;233m',
  highlight: '\x1b[38;5;22m',
  highlightBg: '\x1b[48;5;22m',
  border: '\x1b[38;5;239m',
  accent: '\x1b[38;5;172m',
  text: '\x1b[38;5;252m',
  textDim: '\x1b[38;5;244m',
  green: '\x1b[38;5;40m',
  red: '\x1b[38;5;160m',
  yellow: '\x1b[38;5;226m',
  blue: '\x1b[38;5;69m',
  reset: '\x1b[0m',
} as const;

export const COLORS = isTruecolor ? TRUECOLOR : FALLBACK_256;

// Ink-compatible hex colors (for React TUI components)
export const INK_COLORS = {
  bg: '#06080d',
  highlight: '#235F28',
  border: '#303030',
  accent: '#e87632',       // CLD orange
  accentLight: '#e8edf5',  // CTRL white
  text: '#CCCCCC',
  textDim: '#808080',
  green: '#2dd4bf',        // teal success
  red: '#CC3C3C',
  yellow: '#f59e0b',       // amber warning
  blue: '#388cff',         // secondary UI blue
} as const;

// ── Unicode characters ──────────────────────────────────────

export const CHARS = {
  pointer: '›',
  bullet: '•',
  check: '✓',
  cross: '✗',
  warning: '⚠',
  arrow_up: '↑',
  arrow_down: '↓',
  pin: '*',
  ellipsis: '…',
  separator: '─',
  vertical: '│',
  top_left: '┌',
  top_right: '┐',
  bottom_left: '└',
  bottom_right: '┘',
  tee_right: '├',
  tee_left: '┤',
  tee_down: '┬',
  tee_up: '┴',
  cross_char: '┼',
} as const;

// ── Defaults ────────────────────────────────────────────────

export const DEFAULTS = {
  pollIntervalMs: 30_000,       // 30s background polling
  gitPollIntervalMs: 10_000,    // 10s for visible project git status
  issuePollIntervalMs: 300_000, // 5 min for GitHub issues
  maxSessions: 10,
  maxSessionFileSize: 50 * 1024 * 1024, // 50MB
  logMaxSize: 5 * 1024 * 1024,          // 5MB log rotation
  concurrencyLimit: 5,                   // p-limit for git/gh spawns
  leftPaneWidth: 0.4,                    // 40% of terminal width
  maxProjectNameLength: 24,
  issuePromptMaxLength: 200,
} as const;
