/**
 * Left pane: live conversations list, sorted by token usage.
 * Shown when leftPaneMode === 'conversations' (toggle with L key).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS, CHARS, formatDuration } from '../../constants.js';
import { usePulse } from '../hooks/useAnimations.js';
import { isFeatureEnabled } from '../../config.js';
import type { Config, ActiveSession, UsageBudget } from '../../types.js';

interface ConversationPaneProps {
  conversations: ActiveSession[];
  selectedIndex: number;
  width: number;
  height: number;
  focused: boolean;
  usageBudget?: UsageBudget | null;
  config?: Config;
}

/** Extract short project name from path */
function projectName(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

// Context size thresholds (tokens)
const CTX_WARN = 100_000;   // yellow warning
const CTX_DANGER = 200_000; // red danger
const CTX_CRITICAL = 500_000; // pulsing red

/** Format context size compactly: 142K, 1.2M */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

/** Color for context size */
function contextColor(tokens: number): string {
  if (tokens >= CTX_CRITICAL) return INK_COLORS.red;
  if (tokens >= CTX_DANGER) return INK_COLORS.red;
  if (tokens >= CTX_WARN) return INK_COLORS.yellow;
  return INK_COLORS.green;
}

export const ConversationPane = React.memo(function ConversationPane({
  conversations,
  selectedIndex,
  width,
  height,
  focused,
  usageBudget,
  config,
}: ConversationPaneProps) {
  const rawPulse = usePulse(800);
  const pulse = config && !isFeatureEnabled(config, 'animations') ? true : rawPulse;

  // Sort by tokens descending (biggest consumer first)
  const sorted = [...conversations].sort((a, b) => b.stats.tokens - a.stats.tokens);
  const totalTokens = sorted.reduce((sum, s) => sum + s.stats.tokens, 0);

  const innerWidth = Math.max(10, width - 4);
  const nameWidth = Math.max(6, Math.min(innerWidth - 20, 16));
  const viewportHeight = Math.max(1, height - 7); // header + separator + total + separator + hints + borders
  const visibleConversations = sorted.slice(0, viewportHeight);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? INK_COLORS.accent : INK_COLORS.border}
    >
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color={INK_COLORS.accent}>Live Conversations</Text>
        <Text color={INK_COLORS.textDim}>{sorted.length} active</Text>
      </Box>

      {/* Empty state */}
      {sorted.length === 0 && (
        <Box paddingX={1} flexDirection="column">
          <Text color={INK_COLORS.textDim}>No active conversations.</Text>
          <Text color={INK_COLORS.textDim}>Press L to switch to projects,</Text>
          <Text color={INK_COLORS.textDim}>or launch one with Enter.</Text>
        </Box>
      )}

      {/* Conversation list */}
      {visibleConversations.map((session, i) => {
        const isSelected = i === selectedIndex;
        const isIdle = !!session.idle;
        const dotColor = isIdle ? INK_COLORS.yellow : INK_COLORS.green;
        const name = projectName(session.projectPath);
        const action = session.currentAction || (isIdle ? 'idle' : 'active');
        const dur = formatDuration(Date.now() - session.startTime.getTime());
        const tok = formatTokenCount(session.stats.tokens);

        // Current context size (what was sent to the API on the most recent turn)
        const ctxSize = session.stats.lastContextSize;
        const ctxStr = ctxSize > 1000 ? formatContext(ctxSize) : '';
        const ctxCol = contextColor(ctxSize);
        const ctxPulse = ctxSize >= CTX_CRITICAL && !pulse; // blink when critical

        return (
          <Box key={session.sessionId || `${session.projectPath}:${i}`} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {isSelected ? CHARS.pointer : ' '}{' '}
              {name.slice(0, nameWidth).padEnd(nameWidth)}{' '}
              <Text color={pulse ? dotColor : INK_COLORS.textDim}>{'●'}</Text>
              {' '}
              <Text color={INK_COLORS.textDim}>
                {dur}{' '}
              </Text>
              <Text color={INK_COLORS.accent}>{tok}</Text>
              {ctxStr ? (
                <Text color={ctxPulse ? INK_COLORS.textDim : ctxCol}>{' '}[{ctxStr}]</Text>
              ) : null}
            </Text>
          </Box>
        );
      })}

      {/* Bottom summary */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {CHARS.separator.repeat(Math.max(1, innerWidth))}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          Total: {formatTokenCount(totalTokens)} tokens
          {usageBudget?.rateLimits
            ? ` ${CHARS.bullet} 5h: ${Math.round(usageBudget.rateLimits.fiveHourPercent)}%`
            : usageBudget && usageBudget.limit > 0
              ? ` ${CHARS.bullet} ${Math.round(usageBudget.percent)}%`
              : ''}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {CHARS.arrow_up}{CHARS.arrow_down} nav  Enter focus  L projects
        </Text>
      </Box>
    </Box>
  );
});
