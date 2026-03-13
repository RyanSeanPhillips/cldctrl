/**
 * Snapshot renderer: renders one frame of the TUI to stdout as text.
 * Used for visual testing without a real TTY.
 *
 * Usage: node --loader ts-node/esm src/tui/snapshot.tsx
 * Or via: cldctrl --snapshot
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { loadConfig } from '../config.js';
import { buildProjectList } from '../core/projects.js';
import { formatGitStatus } from '../core/git.js';
import { formatTokenCount } from '../core/sessions.js';
import { INK_COLORS, CHARS, DEFAULTS, APP_NAME, VERSION } from '../constants.js';
import { ProjectPane } from './components/ProjectPane.js';
import { DetailPane } from './components/DetailPane.js';
import { StatusBar } from './components/StatusBar.js';
import type { Project, GitStatus, Session, Issue } from '../types.js';

interface SnapshotProps {
  width: number;
  height: number;
  selectedIndex?: number;
  mockGit?: boolean;
  mockIssues?: boolean;
  mockSessions?: boolean;
  focusDetails?: boolean;
  detailIndex?: number;
}

/**
 * Generate mock git statuses for visual testing.
 */
function mockGitStatuses(projects: Project[]): Map<string, GitStatus> {
  const statuses = new Map<string, GitStatus>();
  const mocks: Array<Partial<GitStatus>> = [
    { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
    { branch: 'main', dirty: 3, ahead: 0, behind: 0 },
    { branch: 'dev', dirty: 0, ahead: 2, behind: 0 },
    { branch: 'feature/auth', dirty: 5, ahead: 1, behind: 3 },
    { branch: 'main', dirty: 0, ahead: 0, behind: 1 },
  ];
  projects.forEach((p, i) => {
    const mock = mocks[i % mocks.length];
    statuses.set(p.path, { ...mock, available: true } as GitStatus);
  });
  return statuses;
}

/**
 * Generate mock sessions for the detail pane.
 */
function mockSessions(): Session[] {
  return [
    { id: 'abc123', filePath: '', modified: new Date('2026-03-01'), summary: 'Fix auth bug in login flow', dateLabel: 'Mar 1', stats: { messages: 24, tokens: 42_000 } },
    { id: 'def456', filePath: '', modified: new Date('2026-02-28'), summary: 'Add unit tests for config', dateLabel: 'Feb 28', stats: { messages: 12, tokens: 18_000 } },
    { id: 'ghi789', filePath: '', modified: new Date('2026-02-27'), summary: 'Refactor session parser...', dateLabel: 'Feb 27', stats: { messages: 45, tokens: 91_000 } },
    { id: 'jkl012', filePath: '', modified: new Date('2026-02-25'), summary: 'Initial project setup', dateLabel: 'Feb 25', stats: { messages: 8, tokens: 5_200 } },
  ];
}

/**
 * Generate mock issues.
 */
function mockIssues(): Issue[] {
  return [
    { number: 42, title: 'Login fails on Safari with 2FA enabled', state: 'open', url: '', createdAt: '', labels: ['bug'] },
    { number: 38, title: 'Add dark mode support', state: 'open', url: '', createdAt: '', labels: ['enhancement'] },
    { number: 35, title: 'Improve error messages for config validation', state: 'open', url: '', createdAt: '', labels: [] },
  ];
}

function SnapshotApp({ width, height, selectedIndex = 0, mockGit = true, mockIssues: showMockIssues = true, mockSessions: showMockSessions = true, focusDetails = false, detailIndex = 0 }: SnapshotProps) {
  const { config } = loadConfig();
  const projects = buildProjectList(config);

  const leftWidth = Math.floor(width * DEFAULTS.leftPaneWidth);
  const rightWidth = width - leftWidth;
  const bodyHeight = height - 3; // header + status bar

  const gitStatuses = mockGit ? mockGitStatuses(projects) : new Map();
  const issueCounts = new Map<string, number>();
  const selectedProject = projects[selectedIndex];

  const sessions = showMockSessions ? mockSessions() : [];
  const issues = showMockIssues ? mockIssues() : [];

  if (selectedProject && showMockIssues) {
    issueCounts.set(selectedProject.path, issues.length);
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text><Text bold color={INK_COLORS.accent}>CLD</Text><Text bold color={INK_COLORS.accentLight}> CTRL</Text></Text>
        <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
      </Box>
      <Box flexDirection="row" height={bodyHeight}>
        <ProjectPane
          projects={projects}
          selectedIndex={selectedIndex}
          width={leftWidth}
          height={bodyHeight}
          gitStatuses={gitStatuses}
          issueCounts={issueCounts}
          focused={!focusDetails}
          />
        <DetailPane
          project={selectedProject}
          width={rightWidth}
          height={bodyHeight}
          gitStatus={selectedProject ? gitStatuses.get(selectedProject.path) : undefined}
          sessions={sessions}
          issues={issues}
          focused={focusDetails}
          selectedSessionIndex={detailIndex}
          detailSection="sessions"
        />
      </Box>
      <StatusBar
        mode="normal"
        stats={{ messages: 1008, tokens: 117_600_000, date: '2026-03-02' }}
        width={width}
        focusPane={focusDetails ? 'details' : 'projects'}
      />
    </Box>
  );
}

/**
 * Render a snapshot and return the text output.
 */
export function renderSnapshot(opts: SnapshotProps = { width: 100, height: 24 }): string {
  // Use ink-testing-library for string rendering
  const { render: testRender } = require('ink-testing-library') as typeof import('ink-testing-library');
  const instance = testRender(
    <SnapshotApp {...opts} />
  );
  const frame = instance.lastFrame() ?? '';
  instance.unmount();
  return frame;
}

/**
 * CLI entry point for snapshot mode.
 */
export function runSnapshot(): void {
  const width = parseInt(process.env.COLUMNS ?? '100', 10);
  const height = parseInt(process.env.LINES ?? '24', 10);
  const selectedIndex = parseInt(process.env.SNAPSHOT_INDEX ?? '0', 10);
  const focusDetails = process.env.SNAPSHOT_FOCUS === 'details';

  const output = renderSnapshot({ width, height, selectedIndex, focusDetails });
  process.stdout.write(output + '\n');
}
