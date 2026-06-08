/**
 * Full-screen "recent conversations across all projects" view.
 *
 * Opened with `R` from normal mode. Shows the most recent Claude Code
 * conversations regardless of project, newest first, so the user can jump back
 * into one without remembering which project it lived in. Type to filter,
 * ↑/↓ to navigate, Enter to resume, Tab to toggle rich/compact rows.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, VERSION, formatTimeAgo } from '../../constants.js';
import type { Session } from '../../types.js';

export interface RecentConversationsProps {
  /** Pre-filtered, sorted (newest first) sessions, each carrying projectPath. */
  conversations: Session[];
  selectedIndex: number;
  width: number;
  height: number;
  filterText: string;
  compact: boolean;
  loading: boolean;
  /** sessionIds that currently have a live process — marked with a dot. */
  activeIds?: Set<string>;
  /** Friendly project name keyed by raw projectPath (falls back to basename). */
  nameByPath: Map<string, string>;
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export const RecentConversations = React.memo(function RecentConversations({
  conversations,
  selectedIndex,
  width,
  height,
  filterText,
  compact,
  loading,
  activeIds,
  nameByPath,
}: RecentConversationsProps) {
  const contentWidth = Math.max(10, Math.min(width - 2, 120));

  // Layout: header (1) + filter line (1) + separator (1) + list + hints (1)
  const chromeHeight = 1 + 1 + 1 + 1;
  const listHeight = Math.max(1, height - chromeHeight);

  const safeIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, conversations.length - 1)));

  // Scroll window: keep the selected row visible (same pattern as DetailPane)
  const scrollOffset = useMemo(() => {
    let offset = 0;
    if (safeIndex >= listHeight) offset = safeIndex - listHeight + 1;
    return Math.max(0, Math.min(offset, Math.max(0, conversations.length - listHeight)));
  }, [safeIndex, listHeight, conversations.length]);

  const visible = conversations.slice(scrollOffset, scrollOffset + listHeight);

  // Column budget: dot(2) + time(9) + project(20) + space(1) => summary gets the rest
  const timeW = 8;
  const projW = Math.min(22, Math.max(12, Math.floor(contentWidth * 0.22)));
  const summaryW = Math.max(10, contentWidth - 2 - timeW - 1 - projW - 1);

  const filterActive = filterText.length > 0;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color={INK_COLORS.accent}>
          {'CLD CTRL v'}{VERSION}{' — Recent Conversations'}
        </Text>
        <Text color={INK_COLORS.textDim}>
          {conversations.length}{' shown · '}{compact ? 'compact' : 'rich'}
        </Text>
      </Box>

      {/* Filter line */}
      <Box paddingX={1}>
        {filterActive ? (
          <Text>
            <Text color={INK_COLORS.textDim}>{'search: '}</Text>
            <Text color={INK_COLORS.text}>{filterText}</Text>
            <Text color={INK_COLORS.accent}>{'▏'}</Text>
          </Text>
        ) : (
          <Text color={INK_COLORS.textDim}>{'type to search…'}</Text>
        )}
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>{'─'.repeat(Math.max(1, contentWidth))}</Text>
      </Box>

      {/* List */}
      <Box flexDirection="column" height={listHeight} paddingX={1}>
        {loading && conversations.length === 0 ? (
          <Text color={INK_COLORS.textDim}>{'Loading recent conversations…'}</Text>
        ) : conversations.length === 0 ? (
          <Text color={INK_COLORS.textDim}>
            {filterActive ? `No matches for "${filterText}"` : 'No conversations found.'}
          </Text>
        ) : (
          visible.map((s, vi) => {
            const idx = scrollOffset + vi;
            const isSelected = idx === safeIndex;
            const isLive = activeIds?.has(s.id) ?? false;

            const pointer = isSelected ? '›' : ' ';
            const dot = isLive ? '●' : ' ';
            const time = formatTimeAgo(s.modified).padEnd(timeW).slice(0, timeW);
            const projRaw = nameByPath.get(s.projectPath ?? '') ?? basename(s.projectPath ?? '');
            const proj = projRaw.padEnd(projW).slice(0, projW);
            const text = (!compact && s.richSummary) ? s.richSummary : (s.firstPrompt || s.summary || '');
            const summary = text.replace(/\s+/g, ' ').trim().slice(0, summaryW);

            return (
              <Text key={s.id} wrap="truncate">
                <Text color={isSelected ? INK_COLORS.accent : INK_COLORS.text}>{pointer}</Text>
                <Text color={INK_COLORS.green}>{dot}</Text>
                <Text color={INK_COLORS.textDim}>{' '}{time}{' '}</Text>
                <Text color={isSelected ? INK_COLORS.accent : INK_COLORS.yellow}>{proj}</Text>
                <Text color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}>{' '}{summary}</Text>
              </Text>
            );
          })
        )}
      </Box>

      {/* Hints */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {'Esc close · ↑/↓ navigate · Enter resume · Tab rich/compact'}
        </Text>
      </Box>
    </Box>
  );
});
