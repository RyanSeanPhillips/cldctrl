/**
 * Right pane: project info, actions, sessions, issues.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Project, GitStatus, Session, Issue } from '../../types.js';

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

function SessionList({ sessions, selectedIndex, focused, active, width }: {
  sessions: Session[];
  selectedIndex: number;
  focused: boolean;
  active: boolean; // true when detailSection === 'sessions'
  width: number;
}) {
  const maxVisible = 6;
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

interface DetailPaneProps {
  project: Project | undefined;
  width: number;
  height: number;
  gitStatus: GitStatus | undefined;
  sessions: Session[];
  issues: Issue[];
  focused: boolean;
  selectedSessionIndex?: number;
  detailSection: 'sessions' | 'issues';
  selectedIssueIndex?: number;
}

function PreviewArea({ detailSection, sessions, selectedSessionIndex, issues, selectedIssueIndex, width }: {
  detailSection: 'sessions' | 'issues';
  sessions: Session[];
  selectedSessionIndex: number;
  issues: Issue[];
  selectedIssueIndex: number;
  width: number;
}) {
  const previewWidth = Math.max(10, width - 6);
  const maxPromptChars = previewWidth * 5; // ~5 lines of text

  if (detailSection === 'sessions' && sessions[selectedSessionIndex]) {
    const s = sessions[selectedSessionIndex];
    return (
      <Box paddingX={1} marginTop={1} flexDirection="column">
        <Box><Text color={INK_COLORS.textDim}>{CHARS.separator.repeat(Math.max(1, width - 4))}</Text></Box>
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={INK_COLORS.text}>
            {s.dateLabel}
            {s.stats
              ? ` · ${formatTokenCount(s.stats.tokens)} tokens · ${s.stats.messages} msgs`
              : ''}
          </Text>
          {s.richSummary ? (
            <Text color={INK_COLORS.text} wrap="wrap">
              {s.richSummary}
            </Text>
          ) : (
            <>
              <Text color={INK_COLORS.text} wrap="wrap">
                {s.summary}
              </Text>
              {s.firstPrompt && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color={INK_COLORS.textDim}>First prompt:</Text>
                  <Text color={INK_COLORS.textDim} wrap="wrap">
                    {s.firstPrompt.length > maxPromptChars
                      ? s.firstPrompt.slice(0, maxPromptChars - 3) + '...'
                      : s.firstPrompt}
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
            {issue.title}
          </Text>
          {issue.richSummary && (
            <Box marginTop={1}>
              <Text color={INK_COLORS.text} wrap="wrap">
                {issue.richSummary}
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

      {/* Path (truncated to fit pane) */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {project.path.length > width - 4
            ? '...' + project.path.slice(-(width - 7))
            : project.path}
        </Text>
      </Box>

      {/* Git + issues summary */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.green}>{gitStr}</Text>
        <Text color={INK_COLORS.textDim}> | </Text>
        <Text color={issues.length > 0 ? INK_COLORS.accent : INK_COLORS.textDim}>
          {issueCountStr}
        </Text>
      </Box>

      {/* Spacer */}
      <Box paddingX={1}><Text> </Text></Box>

      {/* Actions */}
      <Box paddingX={1} flexDirection="column">
        <Text color={INK_COLORS.text}>
          <Text color={INK_COLORS.accent}>[n]</Text> New session{'  '}
          <Text color={INK_COLORS.accent}>[c]</Text> Continue last{'  '}
          <Text color={INK_COLORS.accent}>[i]</Text> Issues ({issues.length})
        </Text>
      </Box>

      {/* Spacer */}
      <Box paddingX={1}><Text> </Text></Box>

      {/* Recent sessions */}
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.text}>Recent sessions:</Text>
      </Box>

      {sessions.length === 0 ? (
        <Box paddingX={2}>
          <Text color={INK_COLORS.textDim}>No sessions yet</Text>
        </Box>
      ) : (
        <SessionList
          sessions={sessions}
          selectedIndex={selectedSessionIndex}
          focused={focused}
          active={detailSection === 'sessions'}
          width={width}
        />
      )}

      {/* Issues list (selectable) */}
      {issues.length > 0 && (
        <>
          <Box paddingX={1} marginTop={1}>
            <Text bold color={INK_COLORS.text}>Open issues:</Text>
          </Box>
          {issues.map((issue, i) => {
            const isSelected = focused && detailSection === 'issues' && i === selectedIssueIndex;
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
        </>
      )}

      {/* Preview area — context-aware detail for selected item */}
      {focused && <PreviewArea
        detailSection={detailSection}
        sessions={sessions}
        selectedSessionIndex={selectedSessionIndex}
        issues={issues}
        selectedIssueIndex={selectedIssueIndex}
        width={width}
      />}
    </Box>
  );
});
