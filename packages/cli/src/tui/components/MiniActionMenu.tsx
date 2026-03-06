/**
 * Mini TUI: action menu for selected project.
 * Shows Launch, New, Sessions, Issues, Open folder, VS Code.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Session } from '../../types.js';

export interface ActionItem {
  id: string;
  label: string;
  drillable?: boolean; // shows → arrow
}

export function buildActions(sessionCount: number, issueCount: number): ActionItem[] {
  const items: ActionItem[] = [
    { id: 'launch', label: sessionCount > 0 ? 'Launch (continue last)' : 'Launch (new session)' },
    { id: 'new', label: 'New session' },
  ];
  if (sessionCount > 0) {
    items.push({ id: 'sessions', label: `Sessions (${sessionCount})`, drillable: true });
  }
  if (issueCount > 0) {
    items.push({ id: 'issues', label: `Issues (${issueCount})`, drillable: true });
  }
  items.push({ id: 'folder', label: 'Open folder' });
  items.push({ id: 'vscode', label: 'Open in VS Code' });
  items.push({ id: 'full', label: 'Open full CLD CTRL' });
  return items;
}

interface MiniActionMenuProps {
  projectName: string;
  actions: ActionItem[];
  selectedIndex: number;
  width: number;
}

export const MiniActionMenu = React.memo(function MiniActionMenu({
  projectName,
  actions,
  selectedIndex,
  width,
}: MiniActionMenuProps) {
  const innerW = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" width={width}>
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.accent}>{projectName}</Text>
      </Box>

      {actions.map((action, i) => {
        const isSelected = i === selectedIndex;
        const arrow = action.drillable ? '  ' + CHARS.pointer : '';

        return (
          <Box key={action.id} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {isSelected ? CHARS.pointer : ' '}{' '}
              {(action.label + arrow).slice(0, innerW)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});

// ── Session list for Phase 3 ─────────────────────────────────

interface MiniSessionListProps {
  projectName: string;
  sessions: Session[];
  selectedIndex: number;
  width: number;
}

export const MiniSessionList = React.memo(function MiniSessionList({
  projectName,
  sessions,
  selectedIndex,
  width,
}: MiniSessionListProps) {
  const innerW = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" width={width}>
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.accent}>{projectName}</Text>
        <Text color={INK_COLORS.textDim}> {CHARS.pointer} Sessions</Text>
      </Box>

      {sessions.length === 0 && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>No sessions</Text>
        </Box>
      )}

      {sessions.map((session, i) => {
        const isSelected = i === selectedIndex;
        const tokens = session.stats ? `${Math.round(session.stats.tokens / 1000)}k` : '';
        const label = `${session.dateLabel}  ${session.summary}`;
        const maxLabel = innerW - tokens.length - 4;

        return (
          <Box key={session.id} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {isSelected ? CHARS.pointer : ' '}{' '}
              {label.slice(0, maxLabel).padEnd(Math.max(0, maxLabel))}{' '}
              <Text color={INK_COLORS.accent}>{tokens}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});

