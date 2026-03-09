/**
 * Capture real TUI screenshots by rendering actual components with mock data.
 * Uses ink-testing-library to render, ansi-to-svg to convert to SVG.
 *
 * Run: FORCE_COLOR=3 npx tsx capture-screenshots.tsx
 */

// Force truecolor output even in non-TTY
process.env.FORCE_COLOR = '3';

import React from 'react';
import { render as inkRender, Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import fs from 'node:fs';
import path from 'node:path';

import { ProjectPane } from './src/tui/components/ProjectPane.js';
import { DetailPane } from './src/tui/components/DetailPane.js';
import { StatusBar } from './src/tui/components/StatusBar.js';
import { INK_COLORS, CHARS, VERSION } from './src/constants.js';
import type { Project, GitStatus, Session, Issue, GitCommit, ActiveSession, DailyUsage, UsageStats, SessionActivity } from './src/types.js';

const docsDir = path.join(import.meta.dirname, '..', '..', 'docs');

// ── Mock data ──────────────────────────────────────────────

const mockProjects: Project[] = [
  { name: 'CLDCTRL', path: 'C:\\projects\\cldctrl', pinned: true, discovered: false },
  { name: 'WebApp', path: 'C:\\projects\\webapp', pinned: true, discovered: false },
  { name: 'API-Server', path: 'C:\\projects\\api-server', pinned: true, discovered: false },
  { name: 'React Frontend', path: 'C:\\projects\\react-frontend', pinned: false, discovered: true },
  { name: 'Design System', path: 'C:\\projects\\design-system', pinned: false, discovered: true },
];

const mockGitStatuses = new Map<string, GitStatus>([
  ['C:\\projects\\cldctrl', { branch: 'master', dirty: false, ahead: 0, behind: 0, changes: 0 }],
  ['C:\\projects\\webapp', { branch: 'dev', dirty: true, ahead: 2, behind: 0, changes: 3 }],
  ['C:\\projects\\api-server', { branch: 'main', dirty: false, ahead: 0, behind: 0, changes: 0 }],
  ['C:\\projects\\react-frontend', { branch: 'main', dirty: false, ahead: 0, behind: 0, changes: 0 }],
  ['C:\\projects\\design-system', { branch: 'main', dirty: true, ahead: 0, behind: 0, changes: 1 }],
]);

const mockIssueCounts = new Map<string, number>([
  ['C:\\projects\\webapp', 3],
  ['C:\\projects\\api-server', 1],
]);

const mockActiveProcesses = new Map<string, ActiveSession>([
  ['C:\\projects\\api-server', {
    pid: 12345,
    projectPath: 'C:\\projects\\api-server',
    startTime: new Date(Date.now() - 12 * 60_000),
    sessionId: 'abc123',
    tracked: true,
    idle: false,
    currentAction: 'writing',
    stats: { tokens: 45000, messages: 18 },
  }],
]);

const mockSessions: Session[] = [
  {
    id: 'sess-1',
    dateLabel: '2h ago',
    summary: 'Fix auth middleware bug',
    richSummary: 'Fixed authentication middleware that was rejecting valid JWT tokens after DST time change. Root cause was timezone-naive Date comparison in token expiry check. Added regression test covering edge cases around midnight UTC transitions.',
    firstPrompt: undefined,
    stats: { tokens: 1200, messages: 23 },
  },
  {
    id: 'sess-2',
    dateLabel: '1d ago',
    summary: 'Add rate limiter to API endpoints',
    richSummary: 'Implemented sliding window rate limiter using Redis sorted sets. Added per-route configuration with sensible defaults. Includes bypass for internal service-to-service calls via API key authentication.',
    firstPrompt: undefined,
    stats: { tokens: 890, messages: 15 },
  },
  {
    id: 'sess-3',
    dateLabel: '2d ago',
    summary: 'Refactor database query layer',
    richSummary: undefined,
    firstPrompt: 'Can you help me refactor the database queries to use a connection pool?',
    stats: { tokens: 2100, messages: 31 },
  },
  {
    id: 'sess-4',
    dateLabel: 'Mar 1',
    summary: 'Set up CI/CD pipeline with GitHub Actions',
    richSummary: 'Created GitHub Actions workflow for CI/CD: lint, typecheck, test on PR; build and deploy to staging on merge to main. Added caching for node_modules and build artifacts.',
    firstPrompt: undefined,
    stats: { tokens: 450, messages: 8 },
  },
];

const mockIssues: Issue[] = [
  { number: 42, title: 'Login fails with SSO when session cookie is expired', labels: ['bug', 'auth'], createdAt: '2026-03-01T10:00:00Z', richSummary: 'Users report 500 errors when attempting SSO login with an expired session cookie. The auth middleware tries to refresh the token but fails to handle the expired cookie case.' },
  { number: 38, title: 'Add dark mode support to settings page', labels: ['enhancement', 'ui'], createdAt: '2026-02-28T14:30:00Z', richSummary: undefined },
  { number: 35, title: 'Rate limiter not respecting per-route config', labels: ['bug'], createdAt: '2026-02-25T09:15:00Z', richSummary: 'The sliding window rate limiter falls back to global defaults even when per-route limits are configured in routes.json.' },
];

const mockCommits: GitCommit[] = [
  { hash: 'a1b2c3d4', subject: 'Fix auth middleware token expiry', date: new Date(Date.now() - 2 * 3600_000).toISOString(), additions: 45, deletions: 12, files: ['src/auth/middleware.ts', 'tests/auth.test.ts'] },
  { hash: 'e5f6g7h8', subject: 'Add rate limiter middleware', date: new Date(Date.now() - 26 * 3600_000).toISOString(), additions: 120, deletions: 3, files: ['src/middleware/rate-limiter.ts', 'src/config/routes.json'] },
  { hash: 'i9j0k1l2', subject: 'Refactor DB connection pooling', date: new Date(Date.now() - 50 * 3600_000).toISOString(), additions: 67, deletions: 89, files: ['src/db/pool.ts', 'src/db/queries.ts', 'src/db/migrations/003.sql'] },
];

const mockSessionActivity: SessionActivity = {
  toolCalls: { writes: 8, reads: 12, bash: 3 },
  agentSpawns: 2,
  models: { 'claude-sonnet-4-5-20250514': 18, 'claude-opus-4-20250514': 5 },
  mcpCalls: {
    codeindex: { name: 'codeindex', totalCalls: 5, tools: { search: 3, annotate: 2 } },
  },
};

// Generate fake usage history (28 days)
function generateUsageHistory(): DailyUsage[] {
  const days: DailyUsage[] = [];
  const rng = (seed: number) => {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  };
  const rand = rng(42);
  for (let i = 27; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const tokens = isWeekend ? Math.floor(rand() * 30000) : Math.floor(rand() * 150000 + 20000);
    days.push({ date: dateStr, tokens, messages: Math.floor(tokens / 2500), commits: Math.floor(rand() * 5) });
  }
  return days;
}

const mockUsageHistory = generateUsageHistory();
const mockUsageStats: UsageStats = { tokens: 128000, messages: 47 };

const mockSkillsData = {
  commands: [
    { name: 'commit', description: 'Create a git commit', source: 'user' as const },
    { name: 'review-team', description: 'Multi-agent code review', source: 'project' as const },
    { name: 'simplify', description: 'Refactor for quality', source: 'project' as const },
    { name: 'init', description: 'Set up CLAUDE.md', source: 'plugin' as const },
    { name: 'review-perf', description: 'Performance review', source: 'project' as const },
    { name: 'review-security', description: 'Security review', source: 'project' as const },
    { name: 'claude-api', description: 'Build with Claude API', source: 'plugin' as const },
    { name: 'keybindings', description: 'Customize keys', source: 'plugin' as const },
  ],
  skills: [],
};

const mockCommandUsage: Record<string, number> = {
  commit: 12,
  'review-team': 5,
  simplify: 3,
  init: 1,
};

// ── Render full TUI ────────────────────────────────────────

const TERM_COLS = 110;
const TERM_ROWS = 32;
const LEFT_WIDTH = Math.floor(TERM_COLS * DEFAULTS.leftPaneWidth);
const RIGHT_WIDTH = TERM_COLS - LEFT_WIDTH;

import { DEFAULTS } from './src/constants.js';

function FullTUI() {
  return (
    <Box flexDirection="column" width={TERM_COLS}>
      <Box>
        <ProjectPane
          projects={mockProjects}
          selectedIndex={1}
          width={LEFT_WIDTH}
          height={TERM_ROWS - 1}
          gitStatuses={mockGitStatuses}
          issueCounts={mockIssueCounts}
          focused={false}
          activeProcesses={mockActiveProcesses}
          usageHistory={mockUsageHistory}
          dailyBudget={200000}
          usageStats={mockUsageStats}
          skillsData={mockSkillsData}
          commandUsage={mockCommandUsage}
        />
        <DetailPane
          project={mockProjects[1]}
          width={RIGHT_WIDTH}
          height={TERM_ROWS - 1}
          gitStatus={mockGitStatuses.get(mockProjects[1].path)}
          sessions={mockSessions}
          issues={mockIssues}
          focused={true}
          selectedSessionIndex={0}
          detailSection="sessions"
          selectedIssueIndex={0}
          selectedCommitIndex={0}
          commits={mockCommits}
          activeProcess={undefined}
          sessionActivity={mockSessionActivity}
          usageHistory={mockUsageHistory}
          commitActivity={mockUsageHistory}
        />
      </Box>
      <StatusBar
        mode="normal"
        stats={mockUsageStats}
        width={TERM_COLS}
        focusPane="details"
        dailyBudget={200000}
      />
    </Box>
  );
}

// ── Render mini TUI ────────────────────────────────────────

import { MiniProjectList } from './src/tui/components/MiniProjectList.js';
import { MiniActionMenu, MiniSessionList, buildActions } from './src/tui/components/MiniActionMenu.js';

const MINI_COLS = 48;

function MiniProjectView() {
  return (
    <Box flexDirection="column" width={MINI_COLS}>
      <Box flexDirection="column" borderStyle="single" borderColor={INK_COLORS.border} width={MINI_COLS}>
        <Box paddingX={1} justifyContent="space-between">
          <Text>
            <Text color={INK_COLORS.accent}>{'\u2584'}</Text><Text color="#e6963c">{'\u2580'}</Text><Text color={INK_COLORS.accent} backgroundColor="#e6963c">{'\u2584'}</Text><Text color="#e6963c">{'\u2580'}</Text><Text color={INK_COLORS.accent}>{'\u2584'}</Text>
            {'  '}<Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text>
          </Text>
          <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>{CHARS.separator.repeat(MINI_COLS - 4)}</Text>
        </Box>
        <Box flexDirection="column" height={12}>
          <MiniProjectList
            projects={mockProjects}
            selectedIndex={1}
            width={MINI_COLS - 2}
            height={12}
          />
        </Box>
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>{CHARS.separator.repeat(MINI_COLS - 4)}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up}{CHARS.arrow_down} nav  {CHARS.pointer} select  / filter  f full</Text>
        </Box>
      </Box>
    </Box>
  );
}

function MiniActionsView() {
  const actions = buildActions(mockSessions.length, mockIssues.length);
  return (
    <Box flexDirection="column" width={MINI_COLS}>
      <Box flexDirection="column" borderStyle="single" borderColor={INK_COLORS.border} width={MINI_COLS}>
        <Box paddingX={1} justifyContent="space-between">
          <Text>
            <Text color={INK_COLORS.accent}>{'\u2584'}</Text><Text color="#e6963c">{'\u2580'}</Text><Text color={INK_COLORS.accent} backgroundColor="#e6963c">{'\u2584'}</Text><Text color="#e6963c">{'\u2580'}</Text><Text color={INK_COLORS.accent}>{'\u2584'}</Text>
            {'  '}<Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text>
          </Text>
          <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>{CHARS.separator.repeat(MINI_COLS - 4)}</Text>
        </Box>
        <MiniActionMenu
          projectName="WebApp"
          actions={actions}
          selectedIndex={0}
          width={MINI_COLS - 2}
        />
        <Box paddingX={1}>
          <Text color={INK_COLORS.border}>{CHARS.separator.repeat(MINI_COLS - 4)}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up}{CHARS.arrow_down} nav  {CHARS.pointer} select  {'\u2190'} back</Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── ANSI-to-SVG converter with truecolor support ──────────

interface AnsiSpan {
  text: string;
  fg: string;
  bg: string | null;
  bold: boolean;
}

function parseAnsiToSpans(ansi: string): AnsiSpan[][] {
  const lines = ansi.split('\n');
  const result: AnsiSpan[][] = [];

  // ANSI SGR regex: \x1b[...m
  const sgrRe = /\x1b\[([0-9;]*)m/g;

  let currentFg = '#CCCCCC';
  let currentBg: string | null = null;
  let currentBold = false;

  for (const line of lines) {
    const spans: AnsiSpan[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    sgrRe.lastIndex = 0;

    while ((match = sgrRe.exec(line)) !== null) {
      // Capture text before this escape
      if (match.index > lastIdx) {
        const text = line.slice(lastIdx, match.index);
        if (text) spans.push({ text, fg: currentFg, bg: currentBg, bold: currentBold });
      }
      lastIdx = match.index + match[0].length;

      // Parse SGR params
      const params = match[1].split(';').map(Number);
      let i = 0;
      while (i < params.length) {
        const p = params[i];
        if (p === 0) { currentFg = '#CCCCCC'; currentBg = null; currentBold = false; }
        else if (p === 1) { currentBold = true; }
        else if (p === 22) { currentBold = false; }
        else if (p === 38 && params[i + 1] === 2) {
          // Truecolor foreground: 38;2;R;G;B
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          currentFg = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          i += 4;
        }
        else if (p === 48 && params[i + 1] === 2) {
          // Truecolor background: 48;2;R;G;B
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          currentBg = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          i += 4;
        }
        else if (p === 39) { currentFg = '#CCCCCC'; }
        else if (p === 49) { currentBg = null; }
        i++;
      }
    }

    // Remaining text after last escape
    if (lastIdx < line.length) {
      const text = line.slice(lastIdx);
      if (text) spans.push({ text, fg: currentFg, bg: currentBg, bold: currentBold });
    }

    result.push(spans);
  }

  return result;
}

function spansToSvg(lines: AnsiSpan[][], opts: { fontSize: number; bg: string }): string {
  const { fontSize, bg } = opts;
  const charW = fontSize * 0.602;  // Consolas char width ratio
  const lineH = fontSize * 1.4;
  const padX = 12;
  const padY = 10;

  // Calculate max line width in characters
  let maxCols = 0;
  for (const line of lines) {
    let cols = 0;
    for (const span of line) cols += span.text.length;
    maxCols = Math.max(maxCols, cols);
  }

  const svgW = Math.ceil(maxCols * charW + padX * 2);
  const svgH = Math.ceil(lines.length * lineH + padY * 2);

  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`);
  parts.push(`<style>text{font-family:Consolas,monospace;font-size:${fontSize}px;white-space:pre}</style>`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);

  for (let li = 0; li < lines.length; li++) {
    const y = padY + li * lineH;
    const textY = y + lineH * 0.76;  // baseline

    // First pass: draw background rects
    let charOffset = 0;
    for (const span of lines[li]) {
      if (span.bg) {
        const x = padX + charOffset * charW;
        const w = span.text.length * charW;
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${lineH.toFixed(1)}" fill="${span.bg}"/>`);
      }
      charOffset += span.text.length;
    }

    // Second pass: render text as single <text> with <tspan> for color changes
    // Use textLength on the <text> element to enforce exact monospace width
    const totalChars = charOffset;
    if (totalChars === 0) continue;

    const totalWidth = totalChars * charW;
    parts.push(`<text x="${padX}" y="${textY.toFixed(1)}" textLength="${totalWidth.toFixed(1)}" lengthAdjust="spacing">`);

    for (const span of lines[li]) {
      if (!span.text) continue;
      const weight = span.bold ? ' font-weight="bold"' : '';
      parts.push(`<tspan fill="${span.fg}"${weight}>${esc(span.text)}</tspan>`);
    }

    parts.push('</text>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

async function captureAndSave(element: React.ReactElement, filename: string) {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame();
  unmount();

  if (!frame) {
    console.error(`  ERROR: empty frame for ${filename}`);
    return;
  }

  // Parse ANSI to colored spans
  const lines = parseAnsiToSpans(frame);

  // Convert to SVG
  const svg = spansToSvg(lines, { fontSize: 14, bg: '#0c0c0c' });

  const svgPath = path.join(docsDir, filename);
  fs.writeFileSync(svgPath, svg);
  console.log(`  ${filename} (${Math.round(svg.length / 1024)}KB)`);
}

// ── Main ───────────────────────────────────────────────────

console.log('Capturing real TUI screenshots...');
console.log('');

await captureAndSave(<FullTUI />, 'screenshot_full_tui.svg');
await captureAndSave(<MiniProjectView />, 'screenshot_mini.svg');
await captureAndSave(<MiniActionsView />, 'screenshot_mini_actions.svg');

console.log('');
console.log('Done! SVG screenshots saved to docs/');
console.log('Note: Update README.md to reference .svg instead of .png if needed.');
