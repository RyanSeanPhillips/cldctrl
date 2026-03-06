/**
 * Active session badge: shows running status, current action, duration.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';
import { formatTokenCount } from '../../core/sessions.js';
import type { ActiveSession } from '../../types.js';

interface ActiveBadgeProps {
  session: ActiveSession;
  compact?: boolean;
  maxWidth?: number;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
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

  const isIdle = session.tracked && session.idle;
  const badgeColor = isIdle ? INK_COLORS.yellow : INK_COLORS.green;
  const badgeIcon = isIdle ? '○' : '●';
  const badgeLabel = isIdle ? 'IDLE' : 'ACTIVE';

  if (compact) {
    // Show current action (e.g. "Edit App.tsx") or idle/active label
    const suffix = ` ${durationStr} ${tokenStr}`;
    // Reserve space for icon (2 chars) + suffix; truncate action to fit
    const actionMaxLen = maxWidth ? Math.max(4, maxWidth - 2 - suffix.length) : 30;
    let label = session.currentAction
      ? session.currentAction
      : badgeLabel.toLowerCase();
    if (label.length > actionMaxLen) {
      label = label.slice(0, actionMaxLen - 1) + '…';
    }

    return (
      <Box>
        <Text color={badgeColor}>{badgeIcon} </Text>
        <Text color={INK_COLORS.textDim}>
          {label}{suffix}
        </Text>
      </Box>
    );
  }

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

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={badgeColor} bold>{badgeIcon} {badgeLabel}</Text>
        <Text color={INK_COLORS.text}> {session.sessionId ? session.sessionId.slice(0, 20) : ''}</Text>
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
