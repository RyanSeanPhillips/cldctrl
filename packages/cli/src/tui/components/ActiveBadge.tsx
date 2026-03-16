/**
 * Active session badge: shows running status, current action, duration.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, formatDuration } from '../../constants.js';
import { formatTokenCount } from '../../core/sessions.js';
import { usePulse, useClaudeSpinner } from '../hooks/useAnimations.js';
import type { ActiveSession } from '../../types.js';

interface ActiveBadgeProps {
  session: ActiveSession;
  compact?: boolean;
  maxWidth?: number;
}

export const ActiveBadge = React.memo(function ActiveBadge({
  session,
  compact = false,
  maxWidth,
}: ActiveBadgeProps) {
  // Only re-render when the displayed duration string actually changes
  // (roughly every minute), not on a fixed 5s interval
  const [durationStr, setDurationStr] = useState(() =>
    formatDuration(Date.now() - session.startTime.getTime())
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    // Immediately recompute when session identity changes
    const next = formatDuration(Date.now() - sessionRef.current.startTime.getTime());
    setDurationStr(prev => prev === next ? prev : next);

    const timer = setInterval(() => {
      const next = formatDuration(Date.now() - sessionRef.current.startTime.getTime());
      setDurationStr(prev => prev === next ? prev : next);
    }, 30_000);
    return () => clearInterval(timer);
  }, [session.sessionId]);

  const tokenStr = formatTokenCount(session.stats.tokens);

  const isIdle = !!session.idle;
  const isActive = !isIdle;
  const spinner = useClaudeSpinner(isActive, 120);

  const tc = session.stats.toolCalls;
  const toolStr = [
    tc.writes > 0 ? `${tc.writes}w` : '',
    tc.reads > 0 ? `${tc.reads}r` : '',
    tc.bash > 0 ? `${tc.bash}bash` : '',
  ].filter(Boolean).join(' ');

  const mcpServers = Object.keys(session.stats.mcpCalls);
  const mcpStr = mcpServers.length > 0
    ? `${mcpServers.length} MCP${mcpServers.length > 1 ? 's' : ''}`
    : '';

  if (compact) {
    const suffix = ` ${durationStr} ${tokenStr}`;
    const actionMaxLen = maxWidth ? Math.max(4, maxWidth - 2 - suffix.length) : 30;
    let label = session.currentAction || (isIdle ? 'idle' : 'active');
    if (label.length > actionMaxLen) {
      label = label.slice(0, actionMaxLen - 1) + '…';
    }

    return (
      <Box>
        <Text color={isActive ? INK_COLORS.green : INK_COLORS.textDim}>{isActive ? spinner || '✶' : '○'} </Text>
        <Text color={INK_COLORS.textDim}>
          {label}{suffix}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isActive ? INK_COLORS.green : INK_COLORS.textDim} bold>
          {isActive ? spinner || '✶' : '○'} {isIdle ? 'IDLE' : 'ACTIVE'}
        </Text>
      </Box>
      <Box>
        <Text color={INK_COLORS.textDim}>
          {'  '}
          {session.currentAction ? `${session.currentAction}… · ` : ''}
          {durationStr} · {tokenStr}
          {toolStr ? ` · ${toolStr}` : ''}
          {session.stats.agentSpawns > 0 ? ` · ${session.stats.agentSpawns} agents` : ''}
          {mcpStr ? ` · ${mcpStr}` : ''}
        </Text>
      </Box>
    </Box>
  );
});
