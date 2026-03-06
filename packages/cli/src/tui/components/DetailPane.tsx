/**
 * Right pane: project info, sessions, commits, issues with preview area.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import { CalendarHeatmap } from './CalendarHeatmap.js';
import { ActivityTrace } from './ActivityTrace.js';
import { ActiveBadge } from './ActiveBadge.js';
import type { Project, GitStatus, Session, Issue, GitCommit, ActiveSession, SessionActivity, DailyUsage } from '../../types.js';

// ── Scroll window utility ──────────────────────────────────

function computeScrollWindow(selectedIndex: number, itemCount: number, maxVisible: number) {
  let offset = 0;
  if (selectedIndex >= offset + maxVisible) {
    offset = selectedIndex - maxVisible + 1;
  }
  if (selectedIndex < offset) {
    offset = selectedIndex;
  }
  offset = Math.max(0, Math.min(offset, Math.max(0, itemCount - maxVisible)));
  return {
    offset,
    hasAbove: offset > 0,
    hasBelow: offset + maxVisible < itemCount,
  };
}

// ── Session list with scroll ───────────────────────────────

function SessionList({ sessions, selectedIndex, focused, active, width, maxVisible = 6 }: {
  sessions: Session[];
  selectedIndex: number;
  focused: boolean;
  active: boolean;
  width: number;
  maxVisible?: number;
}) {
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    sessions.length,
    maxVisible,
  );
  const visible = sessions.slice(offset, offset + maxVisible);

  return (
    <>
      {hasAbove && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} {offset} more above</Text>
        </Box>
      )}
      {visible.map((session, vi) => {
        const realIndex = offset + vi;
        const isSelected = focused && active && realIndex === selectedIndex;
        const dateCol = session.dateLabel.padEnd(7);
        const tokenStr = session.stats ? formatTokenCount(session.stats.tokens) : '';
        const tokenCol = tokenStr.padStart(6);
        const summaryMax = Math.max(10, width - 25);
        const summary = session.summary.length > summaryMax
          ? session.summary.slice(0, summaryMax - 3) + '...'
          : session.summary.padEnd(summaryMax);
        const pointer = isSelected ? CHARS.pointer : ' ';
        return (
          <Box key={session.id} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {pointer} {dateCol} "{summary}" {tokenCol}
            </Text>
          </Box>
        );
      })}
      {hasBelow && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} {sessions.length - offset - maxVisible} more below</Text>
        </Box>
      )}
    </>
  );
}

// ── Commit list with scroll ──────────────────────────────────

function CommitList({ commits, selectedIndex, focused, active, width, maxVisible = 6 }: {
  commits: GitCommit[];
  selectedIndex: number;
  focused: boolean;
  active: boolean;
  width: number;
  maxVisible?: number;
}) {
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    commits.length,
    maxVisible,
  );
  const visible = commits.slice(offset, offset + maxVisible);

  return (
    <>
      {hasAbove && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} {offset} more above</Text>
        </Box>
      )}
      {visible.map((commit, vi) => {
        const realIndex = offset + vi;
        const isSelected = focused && active && realIndex === selectedIndex;
        const pointer = isSelected ? CHARS.pointer : ' ';
        const timeAgo = formatTimeAgo(commit.date);
        const subjectMax = Math.max(10, width - 28);
        const subject = commit.subject.length > subjectMax
          ? commit.subject.slice(0, subjectMax - 3) + '...'
          : commit.subject;
        const diffStr = `+${commit.additions} -${commit.deletions}`;
        return (
          <Box key={commit.hash} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {pointer} {timeAgo.padEnd(7)} {subject.padEnd(subjectMax)}{' '}
              <Text color={INK_COLORS.green}>+{commit.additions}</Text>
              {' '}
              <Text color={INK_COLORS.red}>-{commit.deletions}</Text>
            </Text>
          </Box>
        );
      })}
      {hasBelow && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} {commits.length - offset - maxVisible} more below</Text>
        </Box>
      )}
    </>
  );
}

// ── Issue list with scroll ──────────────────────────────────

function IssueList({ issues, selectedIndex, focused, active, width, maxVisible = 6 }: {
  issues: Issue[];
  selectedIndex: number;
  focused: boolean;
  active: boolean;
  width: number;
  maxVisible?: number;
}) {
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    issues.length,
    maxVisible,
  );
  const visible = issues.slice(offset, offset + maxVisible);

  return (
    <>
      {hasAbove && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} {offset} more above</Text>
        </Box>
      )}
      {visible.map((issue, vi) => {
        const realIndex = offset + vi;
        const isSelected = focused && active && realIndex === selectedIndex;
        const pointer = isSelected ? CHARS.pointer : ' ';
        const titleMax = Math.max(10, width - 14);
        const title = issue.title.length > titleMax
          ? issue.title.slice(0, titleMax - 3) + '...'
          : issue.title;
        const summaryMax = Math.max(10, width - 8);
        const summaryText = issue.richSummary
          ? (issue.richSummary.length > summaryMax
            ? issue.richSummary.slice(0, summaryMax - 3) + '...'
            : issue.richSummary)
          : undefined;
        return (
          <Box key={issue.number} paddingX={1} flexDirection="column">
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {pointer} <Text color={INK_COLORS.accent}>#{issue.number}</Text> {title}
            </Text>
            {summaryText && (
              <Text color={INK_COLORS.textDim} dimColor>
                {'    '}{summaryText}
              </Text>
            )}
          </Box>
        );
      })}
      {hasBelow && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} {issues.length - offset - maxVisible} more below</Text>
        </Box>
      )}
    </>
  );
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Props ────────────────────────────────────────────────────

interface DetailPaneProps {
  project: Project | undefined;
  width: number;
  height: number;
  gitStatus: GitStatus | undefined;
  sessions: Session[];
  issues: Issue[];
  focused: boolean;
  selectedSessionIndex?: number;
  detailSection: 'sessions' | 'issues' | 'commits';
  selectedIssueIndex?: number;
  selectedCommitIndex?: number;
  commits?: GitCommit[];
  activeProcess?: ActiveSession;
  sessionActivity?: SessionActivity | null;
  usageHistory?: DailyUsage[];
  commitActivity?: DailyUsage[];
}

// ── Preview area ─────────────────────────────────────────────

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

function PreviewArea({ detailSection, sessions, selectedSessionIndex, issues, selectedIssueIndex, commits, selectedCommitIndex, sessionActivity, width, height }: {
  detailSection: 'sessions' | 'issues' | 'commits';
  sessions: Session[];
  selectedSessionIndex: number;
  issues: Issue[];
  selectedIssueIndex: number;
  commits: GitCommit[];
  selectedCommitIndex: number;
  sessionActivity?: SessionActivity | null;
  width: number;
  height?: number;
}) {
  const previewWidth = Math.max(10, width - 6);
  const maxLineChars = Math.max(10, previewWidth);
  // Scale text allowance with available height (default to ~4 lines)
  const previewLines = Math.max(4, (height ?? 8) - 3);
  const maxPromptChars = maxLineChars * previewLines;

  if (detailSection === 'sessions' && sessions[selectedSessionIndex]) {
    const s = sessions[selectedSessionIndex];
    const tc = sessionActivity?.toolCalls;
    const toolStr = tc
      ? [
          tc.writes > 0 ? `${tc.writes}w` : '',
          tc.reads > 0 ? `${tc.reads}r` : '',
          tc.bash > 0 ? `${tc.bash}bash` : '',
        ].filter(Boolean).join(' ')
      : '';
    const modelStr = sessionActivity
      ? Object.entries(sessionActivity.models).map(([m, c]) => {
          const short = m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : m.slice(0, 10);
          return short;
        }).join('/')
      : '';

    return (
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={INK_COLORS.text}>
            {s.dateLabel}
            {s.stats
              ? ` · ${formatTokenCount(s.stats.tokens)} tok · ${s.stats.messages} msgs`
              : ''}
            {toolStr ? ` · ${toolStr}` : ''}
            {sessionActivity?.agentSpawns ? ` · ${sessionActivity.agentSpawns} agents` : ''}
            {modelStr ? ` · ${modelStr}` : ''}
          </Text>
          {/* MCP server usage */}
          {sessionActivity && Object.keys(sessionActivity.mcpCalls).length > 0 && (
            <Box flexDirection="column">
              {Object.values(sessionActivity.mcpCalls).map(server => {
                const topTools = Object.entries(server.tools)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([t, c]) => `${t}(${c})`)
                  .join(' ');
                return (
                  <Text key={server.name} color={INK_COLORS.blue}>
                    {truncateText(`MCP ${server.name}: ${server.totalCalls} calls${topTools ? ` — ${topTools}` : ''}`, maxLineChars)}
                  </Text>
                );
              })}
            </Box>
          )}
          {s.richSummary ? (
            <Text color={INK_COLORS.text} wrap="wrap">
              {truncateText(s.richSummary, maxPromptChars)}
            </Text>
          ) : (
            <>
              <Text color={INK_COLORS.text} wrap="wrap">
                {truncateText(s.summary, maxPromptChars)}
              </Text>
              {s.firstPrompt && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color={INK_COLORS.textDim}>First prompt:</Text>
                  <Text color={INK_COLORS.textDim} wrap="wrap">
                    {truncateText(s.firstPrompt, maxPromptChars)}
                  </Text>
                </Box>
              )}
              <Text color={INK_COLORS.textDim} dimColor>
                (summary pending...)
              </Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  if (detailSection === 'commits' && commits[selectedCommitIndex]) {
    const commit = commits[selectedCommitIndex];
    const total = commit.additions + commit.deletions;
    const barWidth = Math.min(30, Math.max(4, previewWidth - 10));
    const addBar = total > 0 ? Math.round((commit.additions / total) * barWidth) : 0;
    const delBar = barWidth - addBar;

    return (
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={INK_COLORS.text}>{truncateText(commit.subject, previewWidth)}</Text>
          <Text color={INK_COLORS.textDim}>{commit.hash.slice(0, 8)} · {formatTimeAgo(commit.date)}</Text>
          <Box marginTop={1}>
            <Text color={INK_COLORS.green}>+{commit.additions}</Text>
            <Text color={INK_COLORS.textDim}> / </Text>
            <Text color={INK_COLORS.red}>-{commit.deletions}</Text>
          </Box>
          <Box>
            <Text color={INK_COLORS.green}>{'█'.repeat(addBar)}</Text>
            <Text color={INK_COLORS.red}>{'█'.repeat(delBar)}</Text>
          </Box>
          {commit.files && commit.files.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {commit.files.slice(0, 5).map((f, i) => (
                <Text key={i} color={INK_COLORS.textDim}>{truncateText(f, previewWidth)}</Text>
              ))}
              {commit.files.length > 5 && (
                <Text color={INK_COLORS.textDim}>...and {commit.files.length - 5} more</Text>
              )}
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (detailSection === 'issues' && issues[selectedIssueIndex]) {
    const issue = issues[selectedIssueIndex];
    return (
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={INK_COLORS.accent}>
            #{issue.number}
          </Text>
          <Text bold color={INK_COLORS.text} wrap="wrap">
            {truncateText(issue.title, previewWidth * 2)}
          </Text>
          {issue.richSummary && (
            <Box marginTop={1}>
              <Text color={INK_COLORS.text} wrap="wrap">
                {truncateText(issue.richSummary, maxPromptChars)}
              </Text>
            </Box>
          )}
          {issue.labels.length > 0 && (
            <Text color={INK_COLORS.textDim}>
              Labels: {issue.labels.join(', ')}
            </Text>
          )}
          <Text color={INK_COLORS.textDim}>
            Created: {new Date(issue.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column">
      <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>Select an item to preview</Text>
      </Box>
    </Box>
  );
}

// ── Main component ───────────────────────────────────────────

export const DetailPane = React.memo(function DetailPane({
  project,
  width,
  height,
  gitStatus,
  sessions,
  issues,
  focused,
  selectedSessionIndex = 0,
  detailSection,
  selectedIssueIndex = 0,
  selectedCommitIndex = 0,
  commits = [],
  activeProcess,
  sessionActivity,
  usageHistory,
  commitActivity,
}: DetailPaneProps) {
  if (!project) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="single"
        borderColor={INK_COLORS.border}
      >
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>No project selected</Text>
        </Box>
      </Box>
    );
  }

  const gitStr = formatGitStatus(gitStatus);
  const issueCountStr = issues.length > 0 ? `${issues.length} open issues` : 'no issues';

  // Pick calendar data based on active tab
  const calendarData = detailSection === 'commits' ? (commitActivity ?? []) : (usageHistory ?? []);
  const calendarTitle = detailSection === 'commits'
    ? `Commits — ${project.name}`
    : `Usage — ${project.name}`;

  // Calculate dynamic max visible rows for lists
  // Cap at 8 items so the preview/summary area gets space as the window grows
  let usedRows = 5; // name + path/calendar + git + actions + tabs (minimum)
  if (calendarData.length > 0 && height >= 20) usedRows += 6; // calendar ~6 rows
  if (activeProcess) usedRows += 2;
  const listMaxVisible = Math.min(8, Math.max(2, Math.floor((height - usedRows - 10) / 1)));

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? INK_COLORS.accent : INK_COLORS.border}
    >
      {/* Project name */}
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.text}>
          {project.name}
        </Text>
        {project.pinned && <Text color={INK_COLORS.accent}> {CHARS.pin}</Text>}
      </Box>

      {/* Per-project calendar heatmap (replaces path when data available) */}
      {calendarData.length > 0 && height >= 20 ? (
        <Box paddingX={1}>
          <CalendarHeatmap
            title={calendarTitle}
            data={calendarData}
            width={Math.max(8, width - 4)}
            days={28}
            valueKey={detailSection === 'commits' ? 'commits' : 'tokens'}
          />
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>
            {project.path.length > width - 4
              ? '...' + project.path.slice(-(width - 7))
              : project.path}
          </Text>
        </Box>
      )}

      {/* Git + issues summary */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.green}>{gitStr}</Text>
        <Text color={INK_COLORS.textDim}> | </Text>
        <Text color={issues.length > 0 ? INK_COLORS.accent : INK_COLORS.textDim}>
          {issueCountStr}
        </Text>
      </Box>

      {/* Active session banner */}
      {activeProcess && (
        <Box paddingX={1}>
          <ActiveBadge session={activeProcess} compact={!focused} />
        </Box>
      )}

      {/* Actions — hide [c] Continue when detail pane focused to avoid conflict with [c] Commits */}
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Text color={INK_COLORS.text}>
          <Text color={INK_COLORS.accent}>[n]</Text> New session{'  '}
          {!focused && <><Text color={INK_COLORS.accent}>[c]</Text> Continue last</>}
          {focused && <><Text color={INK_COLORS.accent}>[Enter]</Text> Resume</>}
        </Text>
      </Box>

      {/* Section tabs — underline active */}
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box>
          <Text
            bold={detailSection === 'sessions'}
            color={detailSection === 'sessions' ? INK_COLORS.accent : INK_COLORS.textDim}
          >
            <Text color={INK_COLORS.accent}>[s]</Text> Sessions ({sessions.length})
          </Text>
          <Text color={INK_COLORS.textDim}>{'  '}</Text>
          <Text
            bold={detailSection === 'commits'}
            color={detailSection === 'commits' ? INK_COLORS.accent : INK_COLORS.textDim}
          >
            {focused ? <Text color={INK_COLORS.accent}>[c]</Text> : null} Commits ({commits.length})
          </Text>
          <Text color={INK_COLORS.textDim}>{'  '}</Text>
          <Text
            bold={detailSection === 'issues'}
            color={detailSection === 'issues' ? INK_COLORS.accent : INK_COLORS.textDim}
          >
            <Text color={INK_COLORS.accent}>[i]</Text> Issues ({issues.length})
          </Text>
        </Box>
        <Box>
          {(() => {
            const sLabel = `[s] Sessions (${sessions.length})`;
            const cLabel = `${focused ? '[c] ' : ''}Commits (${commits.length})`;
            const iLabel = `[i] Issues (${issues.length})`;
            const sLen = sLabel.length;
            const cLen = cLabel.length;
            const iLen = iLabel.length;
            const pad = '  '; // matches gap between tabs
            if (detailSection === 'sessions') {
              return <Text color={INK_COLORS.accent}>{'═'.repeat(sLen)}{' '.repeat(pad.length + cLen + pad.length + iLen)}</Text>;
            } else if (detailSection === 'commits') {
              return <Text color={INK_COLORS.accent}>{' '.repeat(sLen + pad.length)}{'═'.repeat(cLen)}{' '.repeat(pad.length + iLen)}</Text>;
            } else {
              return <Text color={INK_COLORS.accent}>{' '.repeat(sLen + pad.length + cLen + pad.length)}{'═'.repeat(iLen)}</Text>;
            }
          })()}
        </Box>
      </Box>

      {/* Active section content */}
      {detailSection === 'sessions' ? (
        sessions.length === 0 ? (
          <Box paddingX={2}>
            <Text color={INK_COLORS.textDim}>No sessions yet</Text>
          </Box>
        ) : (
          <SessionList
            sessions={sessions}
            selectedIndex={selectedSessionIndex}
            focused={focused}
            active
            width={width}
            maxVisible={listMaxVisible}
          />
        )
      ) : detailSection === 'commits' ? (
        commits.length === 0 ? (
          <Box paddingX={2}>
            <Text color={INK_COLORS.textDim}>No commits</Text>
          </Box>
        ) : (
          <CommitList
            commits={commits}
            selectedIndex={selectedCommitIndex}
            focused={focused}
            active
            width={width}
            maxVisible={listMaxVisible}
          />
        )
      ) : (
        issues.length === 0 ? (
          <Box paddingX={2}>
            <Text color={INK_COLORS.textDim}>No open issues</Text>
          </Box>
        ) : (
          <IssueList
            issues={issues}
            selectedIndex={selectedIssueIndex}
            focused={focused}
            active
            width={width}
            maxVisible={listMaxVisible}
          />
        )
      )}

      {/* Preview area — context-aware detail for selected item */}
      {focused && <PreviewArea
        detailSection={detailSection}
        sessions={sessions}
        selectedSessionIndex={selectedSessionIndex}
        issues={issues}
        selectedIssueIndex={selectedIssueIndex}
        commits={commits}
        selectedCommitIndex={selectedCommitIndex}
        sessionActivity={sessionActivity}
        width={width}
        height={Math.max(6, height - usedRows - listMaxVisible - 4)}
      />}
    </Box>
  );
});
