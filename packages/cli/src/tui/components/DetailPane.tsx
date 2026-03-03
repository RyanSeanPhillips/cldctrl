/**
 * Right pane: project info, actions, sessions, issues.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Project, GitStatus, Session, Issue } from '../../types.js';

interface DetailPaneProps {
  project: Project | undefined;
  width: number;
  height: number;
  gitStatus: GitStatus | undefined;
  sessions: Session[];
  issues: Issue[];
  focused: boolean;
  selectedSessionIndex?: number;
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
        sessions.slice(0, 6).map((session, i) => {
          const isSelected = focused && i === selectedSessionIndex;
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
        })
      )}

      {/* Issues preview (if any) */}
      {issues.length > 0 && (
        <>
          <Box paddingX={1} marginTop={1}>
            <Text bold color={INK_COLORS.text}>Open issues:</Text>
          </Box>
          {issues.slice(0, 4).map((issue) => (
            <Box key={issue.number} paddingX={2}>
              <Text color={INK_COLORS.accent}>#{issue.number}</Text>
              <Text color={INK_COLORS.text}> {issue.title.slice(0, width - 12)}</Text>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
});
