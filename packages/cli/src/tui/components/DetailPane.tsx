/**
 * Right pane: project info, sessions, commits, issues with preview area.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { estimateCostBlended, formatCost, isCostRelevant } from '../../core/pricing.js';
import { isFeatureEnabled } from '../../config.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import { CalendarHeatmap } from './CalendarHeatmap.js';
import { ActivityTrace } from './ActivityTrace.js';
import { ActiveBadge } from './ActiveBadge.js';
import { usePulse, useAnimatedCounter, useClaudeSpinner } from '../hooks/useAnimations.js';
import { formatFileSize } from '../../core/filetree.js';
import type { FlatNode } from '../hooks/useFileTree.js';
import type { Config, Project, GitStatus, Session, Issue, GitCommit, ActiveSession, SessionActivity, DailyUsage } from '../../types.js';

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

function SessionList({ sessions, selectedIndex, focused, active, width, maxVisible = 6, activeSessionId, activeTokens, showCost = true }: {
  sessions: Session[];
  selectedIndex: number;
  focused: boolean;
  active: boolean;
  width: number;
  maxVisible?: number;
  activeSessionId?: string;
  activeTokens?: number;
  showCost?: boolean;
}) {
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    sessions.length,
    maxVisible,
  );
  const visible = sessions.slice(offset, offset + maxVisible);
  const pulse = usePulse(800);

  // Animated token counter for the live session
  const animTokens = useAnimatedCounter(activeTokens ?? 0, 1200);

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
        const isLive = activeSessionId != null && session.id === activeSessionId;
        const dateCol = session.dateLabel.padEnd(7);
        // For the live session, show the animated token count
        const tokValue = isLive && activeTokens != null ? animTokens : (session.stats?.tokens ?? 0);
        const tokenStr = formatTokenCount(tokValue);
        // Prefer actual cost (from ~/.claude.json) over blended estimate
        const costStr = showCost && isCostRelevant() && tokValue > 0
          ? (session.cost != null
            ? ` ${formatCost(session.cost)}`
            : ` ~${formatCost(estimateCostBlended(tokValue))}`)
          : '';
        const tokenCol = `${tokenStr}${costStr}`.padStart(6 + costStr.length);
        // Reserve space for live dot indicator
        const livePrefix = isLive ? '● ' : '  ';
        const summaryMax = Math.max(10, width - 27 - costStr.length);
        const summary = session.summary.length > summaryMax
          ? session.summary.slice(0, summaryMax - 3) + '...'
          : session.summary.padEnd(summaryMax);
        const pointer = isSelected ? CHARS.pointer : ' ';
        return (
          <Box key={session.id} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : isLive ? INK_COLORS.green : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected || isLive}
            >
              {pointer}{' '}
            </Text>
            {isLive && (
              <Text color={pulse ? INK_COLORS.green : INK_COLORS.textDim} bold>● </Text>
            )}
            {!isLive && <Text>  </Text>}
            <Text
              color={isSelected ? INK_COLORS.text : isLive ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {dateCol} "{summary}"
            </Text>
            <Text
              color={isLive ? INK_COLORS.green : INK_COLORS.accent}
              bold={isLive}
            >
              {' '}{tokenCol}
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
  // Issues with richSummary render 2 rows; adjust maxVisible to prevent vertical overflow
  const hasSummaries = issues.some(i => i.richSummary);
  const effectiveMaxVisible = hasSummaries ? Math.max(1, Math.floor(maxVisible * 0.6)) : maxVisible;
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    issues.length,
    effectiveMaxVisible,
  );
  const visible = issues.slice(offset, offset + effectiveMaxVisible);

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

// ── File tree list with scroll ────────────────────────────────

function FileTreeList({ flatNodes, selectedIndex, focused, active, width, maxVisible = 6 }: {
  flatNodes: FlatNode[];
  selectedIndex: number;
  focused: boolean;
  active: boolean;
  width: number;
  maxVisible?: number;
}) {
  const { offset, hasAbove, hasBelow } = computeScrollWindow(
    active ? selectedIndex : 0,
    flatNodes.length,
    maxVisible,
  );
  const visible = flatNodes.slice(offset, offset + maxVisible);

  return (
    <>
      {hasAbove && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} {offset} more above</Text>
        </Box>
      )}
      {visible.map((flat, vi) => {
        const realIndex = offset + vi;
        const isSelected = focused && active && realIndex === selectedIndex;
        const pointer = isSelected ? CHARS.pointer : ' ';
        const indent = '  '.repeat(flat.depth);
        const expandIcon = flat.hasChildren
          ? (flat.expanded ? CHARS.arrow_down : CHARS.pointer)
          : ' ';
        const nameColor = flat.node.isClaude ? INK_COLORS.accent
          : flat.node.type === 'directory' ? INK_COLORS.blue
          : INK_COLORS.text;
        const sizeStr = flat.node.type === 'file' && flat.node.size != null
          ? ` ${formatFileSize(flat.node.size)}`
          : flat.node.type === 'directory' && flat.node.childCount != null
            ? ` (${flat.node.childCount})`
            : '';
        const maxName = Math.max(8, width - 12 - flat.depth * 2 - sizeStr.length);
        const displayName = flat.node.name.length > maxName
          ? flat.node.name.slice(0, maxName - 1) + '~'
          : flat.node.name;

        return (
          <Box key={flat.node.relativePath || flat.node.name} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : nameColor}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected || flat.node.isClaude}
            >
              {pointer} {indent}{expandIcon} </Text>
            <Text
              color={isSelected ? INK_COLORS.text : (flat.node.iconColor ?? INK_COLORS.textDim)}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
            >
              {flat.node.fileIcon}
            </Text>
            <Text
              color={isSelected ? INK_COLORS.text : nameColor}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected || flat.node.isClaude}
            >
              {' '}{displayName}
            </Text>
            <Text color={INK_COLORS.textDim}>{sizeStr}</Text>
          </Box>
        );
      })}
      {hasBelow && (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} {flatNodes.length - offset - maxVisible} more below</Text>
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
  detailSection: 'sessions' | 'issues' | 'commits' | 'files';
  selectedIssueIndex?: number;
  selectedCommitIndex?: number;
  selectedFileIndex?: number;
  commits?: GitCommit[];
  activeProcess?: ActiveSession;
  sessionActivity?: SessionActivity | null;
  usageHistory?: DailyUsage[];
  commitActivity?: DailyUsage[];
  isSummarizing?: boolean;
  fileTreeNodes?: FlatNode[];
  filePreview?: string[] | null;
  config?: Config;
}

// ── Pending summary with spinner ─────────────────────────────

function SessionPendingSummary({ session, isLive, isSummarizing, maxChars, roundSummaries, currentAction }: {
  session: Session;
  isLive: boolean;
  isSummarizing: boolean;
  maxChars: number;
  roundSummaries?: string[];
  currentAction?: string;
}) {
  const spinner = useClaudeSpinner(isSummarizing || isLive, 120);
  const pulse = usePulse(600);

  // For live sessions, show AI-generated round summaries
  if (isLive) {
    const maxLineChars = Math.max(10, Math.floor(maxChars / 6));
    return (
      <>
        {roundSummaries && roundSummaries.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={INK_COLORS.green}>
              ● Completed:
            </Text>
            {roundSummaries.slice(-5).map((summary, i) => (
              <Text key={i} color={i === roundSummaries.length - 1 ? INK_COLORS.text : INK_COLORS.textDim} wrap="wrap">
                {CHARS.bullet} {truncateText(summary, maxLineChars)}
              </Text>
            ))}
          </Box>
        )}
        {currentAction && (
          <Box marginTop={1}>
            <Text color={INK_COLORS.accent}>
              {spinner} {currentAction}
            </Text>
          </Box>
        )}
        {!roundSummaries?.length && !currentAction && (
          <Text color={pulse ? INK_COLORS.green : INK_COLORS.textDim}>
            ● Live session
          </Text>
        )}
      </>
    );
  }

  return (
    <>
      <Text color={INK_COLORS.text} wrap="wrap">
        {truncateText(session.summary, maxChars)}
      </Text>
      {session.firstPrompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={INK_COLORS.textDim}>First prompt:</Text>
          <Text color={INK_COLORS.textDim} wrap="wrap">
            {truncateText(session.firstPrompt, maxChars)}
          </Text>
        </Box>
      )}
      {isLive ? (
        <Text color={pulse ? INK_COLORS.green : INK_COLORS.textDim}>
          ● Live session — summary generates after completion
        </Text>
      ) : isSummarizing ? (
        <Text color={INK_COLORS.accent}>
          {spinner} Generating summary...
        </Text>
      ) : (
        <Text color={INK_COLORS.textDim} dimColor>
          (summary pending...)
        </Text>
      )}
    </>
  );
}

// ── Preview area ─────────────────────────────────────────────

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

function PreviewArea({ detailSection, sessions, selectedSessionIndex, issues, selectedIssueIndex, commits, selectedCommitIndex, sessionActivity, width, height, activeSessionId, isSummarizing, activeRoundSummaries, activeCurrentAction, fileTreeNodes, selectedFileIndex, filePreview }: {
  detailSection: 'sessions' | 'issues' | 'commits' | 'files';
  sessions: Session[];
  selectedSessionIndex: number;
  issues: Issue[];
  selectedIssueIndex: number;
  commits: GitCommit[];
  selectedCommitIndex: number;
  sessionActivity?: SessionActivity | null;
  width: number;
  height?: number;
  activeSessionId?: string;
  isSummarizing?: boolean;
  activeRoundSummaries?: string[];
  activeCurrentAction?: string;
  fileTreeNodes?: FlatNode[];
  selectedFileIndex?: number;
  filePreview?: string[] | null;
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
          tc.writes > 0 ? `${tc.writes} edits` : '',
          tc.reads > 0 ? `${tc.reads} reads` : '',
          tc.bash > 0 ? `${tc.bash} cmds` : '',
        ].filter(Boolean).join(' · ')
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
          {/* Color-coded session stats header */}
          <Text>
            <Text bold color={INK_COLORS.accent}>{s.dateLabel}</Text>
            {s.stats && (
              <>
                <Text color={INK_COLORS.textDim}> · </Text>
                <Text bold color={INK_COLORS.green}>{formatTokenCount(s.stats.tokens)} tok</Text>
                <Text color={INK_COLORS.textDim}> · </Text>
                <Text bold color={INK_COLORS.blue}>{s.stats.messages} msgs</Text>
              </>
            )}
            {toolStr && (
              <>
                <Text color={INK_COLORS.textDim}> · </Text>
                <Text color={INK_COLORS.yellow}>{toolStr}</Text>
              </>
            )}
            {sessionActivity?.agentSpawns ? (
              <>
                <Text color={INK_COLORS.textDim}> · </Text>
                <Text color={INK_COLORS.accent}>{sessionActivity.agentSpawns} agents</Text>
              </>
            ) : null}
            {modelStr && (
              <>
                <Text color={INK_COLORS.textDim}> · </Text>
                <Text color={INK_COLORS.textDim}>{modelStr}</Text>
              </>
            )}
          </Text>
          {/* MCP server usage */}
          {sessionActivity && Object.keys(sessionActivity.mcpCalls).length > 0 && (
            <Box flexDirection="column">
              {Object.values(sessionActivity.mcpCalls).slice(0, 3).map(server => {
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
            <SessionPendingSummary
              session={s}
              isLive={activeSessionId != null && s.id === activeSessionId}
              isSummarizing={!!isSummarizing}
              maxChars={maxPromptChars}
              roundSummaries={activeSessionId != null && s.id === activeSessionId ? activeRoundSummaries : undefined}
              currentAction={activeSessionId != null && s.id === activeSessionId ? activeCurrentAction : undefined}
            />
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
          <Text>
            <Text color={INK_COLORS.accent}>{commit.hash.slice(0, 8)}</Text>
            <Text color={INK_COLORS.textDim}> · </Text>
            <Text color={INK_COLORS.blue}>{formatTimeAgo(commit.date)}</Text>
          </Text>
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

  if (detailSection === 'files' && fileTreeNodes && fileTreeNodes[(selectedFileIndex ?? 0)]) {
    const flat = fileTreeNodes[selectedFileIndex ?? 0];
    const node = flat.node;
    const previewLines = Math.max(4, (height ?? 8) - 4);

    return (
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={node.isClaude ? INK_COLORS.accent : INK_COLORS.text}>
            {node.name}
          </Text>
          <Text color={INK_COLORS.textDim}>
            {node.type === 'file' ? formatFileSize(node.size) : `${node.childCount ?? 0} items`}
            {node.modified ? ` · ${formatTimeAgo(node.modified.toISOString())}` : ''}
          </Text>
          <Text color={INK_COLORS.textDim} dimColor>
            {node.relativePath}
          </Text>
          {filePreview && filePreview.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {filePreview.slice(0, previewLines).map((line, i) => (
                <Text key={i} color={INK_COLORS.textDim}>
                  {truncateText(line, Math.max(10, width - 8))}
                </Text>
              ))}
            </Box>
          )}
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
  isSummarizing,
  fileTreeNodes = [],
  filePreview,
  selectedFileIndex = 0,
  config,
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

  const showCalendar = !config || isFeatureEnabled(config, 'calendar_heatmap');
  const showCostEstimates = !config || isFeatureEnabled(config, 'cost_estimates');

  const gitStr = formatGitStatus(gitStatus);
  const issueCountStr = issues.length > 0 ? `${issues.length} open issues` : 'no issues';

  // Calendar data — show both side-by-side if width allows, otherwise pick based on tab
  const hasUsageData = showCalendar && (usageHistory ?? []).length > 0;
  const hasCommitData = showCalendar && (commitActivity ?? []).length > 0;
  const calendarWidth = Math.max(8, width - 4);
  // Side-by-side needs ~44 chars (2 × 20-char calendar + gap)
  const showSideBySide = hasUsageData && hasCommitData && calendarWidth >= 44;
  const calendarData = showCalendar ? (detailSection === 'commits' ? (commitActivity ?? []) : (usageHistory ?? [])) : [];
  const calendarTitle = detailSection === 'commits'
    ? `Commits`
    : `Tokens`;

  // Calculate dynamic max visible rows for lists.
  // Inner height = height - 2 (border top/bottom).
  // Fixed rows: name(1) + path(1) + git(1) + marginTop+actions(2) + marginTop+tabs+underline(3) + 1 safety = 10
  const innerHeight = height - 2;
  let fixedRows = 10;
  if (calendarData.length > 0 && height >= 20) fixedRows += 5; // calendar replaces 1-row path with ~6 rows
  if (activeProcess) fixedRows += 2;
  // Reserve 6 rows for preview when focused, cap list at 8
  const listMaxVisible = Math.min(8, Math.max(1, innerHeight - fixedRows - 6));

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

      {/* Per-project calendar heatmap(s) — side-by-side if width allows */}
      {(hasUsageData || hasCommitData) && height >= 20 ? (
        showSideBySide ? (
          <Box paddingX={1} flexDirection="row">
            <Box marginRight={2}>
              <CalendarHeatmap
                title="Tokens"
                data={usageHistory ?? []}
                width={Math.floor((calendarWidth - 2) / 2)}
                days={28}
                valueKey="tokens"
              />
            </Box>
            <CalendarHeatmap
              title="Commits"
              data={commitActivity ?? []}
              width={Math.floor((calendarWidth - 2) / 2)}
              days={28}
              valueKey="commits"
            />
          </Box>
        ) : (
          <Box paddingX={1}>
            <CalendarHeatmap
              title={calendarTitle}
              data={calendarData}
              width={calendarWidth}
              days={28}
              valueKey={detailSection === 'commits' ? 'commits' : 'tokens'}
            />
          </Box>
        )
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
          <Text color={INK_COLORS.textDim}>{'  '}</Text>
          <Text
            bold={detailSection === 'files'}
            color={detailSection === 'files' ? INK_COLORS.accent : INK_COLORS.textDim}
          >
            <Text color={INK_COLORS.accent}>[f]</Text> Files
          </Text>
        </Box>
        <Box>
          {(() => {
            const sLabel = `[s] Sessions (${sessions.length})`;
            const cLabel = `${focused ? '[c] ' : ''}Commits (${commits.length})`;
            const iLabel = `[i] Issues (${issues.length})`;
            const fLabel = `[f] Files`;
            const sLen = sLabel.length;
            const cLen = cLabel.length;
            const iLen = iLabel.length;
            const fLen = fLabel.length;
            const pad = '  ';
            const total = sLen + pad.length + cLen + pad.length + iLen + pad.length + fLen;
            if (detailSection === 'sessions') {
              return <Text color={INK_COLORS.accent}>{'═'.repeat(sLen)}{' '.repeat(total - sLen)}</Text>;
            } else if (detailSection === 'commits') {
              return <Text color={INK_COLORS.accent}>{' '.repeat(sLen + pad.length)}{'═'.repeat(cLen)}{' '.repeat(total - sLen - pad.length - cLen)}</Text>;
            } else if (detailSection === 'issues') {
              return <Text color={INK_COLORS.accent}>{' '.repeat(sLen + pad.length + cLen + pad.length)}{'═'.repeat(iLen)}{' '.repeat(pad.length + fLen)}</Text>;
            } else {
              return <Text color={INK_COLORS.accent}>{' '.repeat(total - fLen)}{'═'.repeat(fLen)}</Text>;
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
            activeSessionId={activeProcess?.sessionId}
            activeTokens={activeProcess?.stats.tokens}
            showCost={showCostEstimates}
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
      ) : detailSection === 'issues' ? (
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
      ) : (
        fileTreeNodes.length === 0 ? (
          <Box paddingX={2}>
            <Text color={INK_COLORS.textDim}>No files found</Text>
          </Box>
        ) : (
          <FileTreeList
            flatNodes={fileTreeNodes}
            selectedIndex={selectedFileIndex}
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
        height={Math.max(4, innerHeight - fixedRows - listMaxVisible)}
        activeSessionId={activeProcess?.sessionId}
        isSummarizing={isSummarizing}
        activeRoundSummaries={activeProcess?.roundSummaries}
        activeCurrentAction={activeProcess?.currentAction}
        fileTreeNodes={fileTreeNodes}
        selectedFileIndex={selectedFileIndex}
        filePreview={filePreview}
      />}
    </Box>
  );
});
