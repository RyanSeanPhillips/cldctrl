/**
 * Component snapshot tests — renders each TUI component to text
 * so we can visually verify layout without a real terminal.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ProjectPane } from '../src/tui/components/ProjectPane.js';
import { DetailPane } from '../src/tui/components/DetailPane.js';
import { FilterBar } from '../src/tui/components/FilterBar.js';
import { StatusBar } from '../src/tui/components/StatusBar.js';
import { Welcome } from '../src/tui/components/Welcome.js';
import { HelpOverlay } from '../src/tui/components/HelpOverlay.js';
import type { Project, GitStatus, Session, Issue } from '../src/types.js';

// ── Test data ───────────────────────────────────────────────

const mockProjects: Project[] = [
  { name: 'NeuronForge', path: '/home/user/neuronforge', slug: 'neuronforge', pinned: true, discovered: false },
  { name: 'CldCtrl', path: '/home/user/cldctrl', slug: 'cldctrl', pinned: true, discovered: false },
  { name: 'WebApp', path: '/home/user/webapp', slug: 'webapp', pinned: false, discovered: true },
  { name: 'my-script', path: '/home/user/my-script', slug: 'my-script', pinned: false, discovered: true },
];

const mockGitStatuses = new Map<string, GitStatus>([
  ['/home/user/neuronforge', { branch: 'main', dirty: 0, ahead: 0, behind: 0, available: true }],
  ['/home/user/cldctrl', { branch: 'main', dirty: 3, ahead: 0, behind: 0, available: true }],
  ['/home/user/webapp', { branch: 'dev', dirty: 0, ahead: 2, behind: 0, available: true }],
]);

const mockIssueCounts = new Map<string, number>([
  ['/home/user/neuronforge', 2],
]);

const mockSessions: Session[] = [
  { id: 'abc', filePath: '', modified: new Date('2026-03-01'), summary: 'Fix auth bug...', dateLabel: 'Mar 1', stats: { messages: 24, tokens: 42000 } },
  { id: 'def', filePath: '', modified: new Date('2026-02-28'), summary: 'Add tests...', dateLabel: 'Feb 28', stats: { messages: 12, tokens: 18000 } },
  { id: 'ghi', filePath: '', modified: new Date('2026-02-27'), summary: 'Refactor...', dateLabel: 'Feb 27', stats: { messages: 45, tokens: 91000 } },
];

const mockIssues: Issue[] = [
  { number: 42, title: 'Login fails on Safari', state: 'open', url: '', createdAt: '', labels: ['bug'] },
  { number: 38, title: 'Add dark mode', state: 'open', url: '', createdAt: '', labels: ['enhancement'] },
];

// ── Component tests ─────────────────────────────────────────

describe('ProjectPane', () => {
  it('renders project list with git status', () => {
    const { lastFrame } = render(
      <ProjectPane
        projects={mockProjects}
        selectedIndex={0}
        width={40}
        height={12}
        gitStatuses={mockGitStatuses}
        issueCounts={mockIssueCounts}
        focused={true}
        />
    );
    const frame = lastFrame()!;
    console.log('=== ProjectPane ===\n' + frame + '\n');
    expect(frame).toContain('NeuronForge');
    expect(frame).toContain('CldCtrl');
    expect(frame).toContain('Projects');
    expect(frame).toContain('main');
  });

  it('renders with filter text', () => {
    const { lastFrame } = render(
      <ProjectPane
        projects={mockProjects}
        selectedIndex={0}
        width={40}
        height={12}
        gitStatuses={mockGitStatuses}
        issueCounts={mockIssueCounts}
        focused={true}
        filterText="neuro"
      />
    );
    const frame = lastFrame()!;
    console.log('=== ProjectPane (filtered) ===\n' + frame + '\n');
    expect(frame).toContain('/neuro');
  });
});

describe('DetailPane', () => {
  it('renders project details with sessions and issues', () => {
    const { lastFrame } = render(
      <DetailPane
        project={mockProjects[0]}
        width={50}
        height={18}
        gitStatus={mockGitStatuses.get('/home/user/neuronforge')}
        sessions={mockSessions}
        issues={mockIssues}
        focused={false}
      />
    );
    const frame = lastFrame()!;
    console.log('=== DetailPane ===\n' + frame + '\n');
    expect(frame).toContain('NeuronForge');
    expect(frame).toContain('/home/user/neuronforge');
    expect(frame).toContain('Recent sessions');
    expect(frame).toContain('Fix auth bug');
    expect(frame).toContain('#42');
  });

  it('renders empty state', () => {
    const { lastFrame } = render(
      <DetailPane
        project={undefined}
        width={50}
        height={18}
        gitStatus={undefined}
        sessions={[]}
        issues={[]}
        focused={false}
      />
    );
    const frame = lastFrame()!;
    console.log('=== DetailPane (empty) ===\n' + frame + '\n');
    expect(frame).toContain('No project selected');
  });
});

describe('FilterBar', () => {
  it('renders when visible', () => {
    const { lastFrame } = render(
      <FilterBar visible={true} text="neuro" resultCount={1} />
    );
    const frame = lastFrame()!;
    console.log('=== FilterBar ===\n' + frame + '\n');
    expect(frame).toContain('/');
    expect(frame).toContain('neuro');
    expect(frame).toContain('1 matches');
  });

  it('renders nothing when hidden', () => {
    const { lastFrame } = render(
      <FilterBar visible={false} text="" resultCount={0} />
    );
    expect(lastFrame()).toBe('');
  });
});

describe('StatusBar', () => {
  it('renders keyboard hints and stats', () => {
    const { lastFrame } = render(
      <StatusBar
        mode="normal"
        stats={{ messages: 42, tokens: 85000, date: '2026-03-02' }}
        width={80}
      />
    );
    const frame = lastFrame()!;
    console.log('=== StatusBar ===\n' + frame + '\n');
    expect(frame).toContain('j/k:nav');
    expect(frame).toContain('42 msgs');
    expect(frame).toContain('85k');
    expect(frame).toContain('tok');
  });

  it('renders filter mode hints', () => {
    const { lastFrame } = render(
      <StatusBar mode="filter" width={80} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Type to filter');
  });
});

describe('Welcome', () => {
  it('renders onboarding screen', () => {
    const { lastFrame } = render(<Welcome />);
    const frame = lastFrame()!;
    console.log('=== Welcome ===\n' + frame + '\n');
    expect(frame).toContain('Welcome to');
    expect(frame).toContain('CLD');
    expect(frame).toContain('CTRL');
    expect(frame).toContain('cldctrl add');
  });
});

describe('HelpOverlay', () => {
  it('renders keyboard shortcuts', () => {
    const { lastFrame } = render(
      <HelpOverlay width={70} height={25} />
    );
    const frame = lastFrame()!;
    console.log('=== HelpOverlay ===\n' + frame + '\n');
    expect(frame).toContain('Keyboard Shortcuts');
    expect(frame).toContain('Launch project');
    expect(frame).toContain('Filter projects');
  });
});
