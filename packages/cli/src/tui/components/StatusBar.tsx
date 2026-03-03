/**
 * Bottom bar: keyboard hints + daily usage stats.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS } from '../../constants.js';
import type { UsageStats } from '../../types.js';

interface StatusBarProps {
  mode: string;
  stats?: UsageStats;
  width: number;
  focusPane?: string;
}

export const StatusBar = React.memo(function StatusBar({ mode, stats, width, focusPane }: StatusBarProps) {
  const hints =
    mode === 'filter'
      ? 'Type to filter | Enter:select | Esc:cancel'
      : focusPane === 'details'
        ? 'j/k:nav sessions  Enter:resume  Esc:back  q:quit'
        : 'j/k:nav  /:filter  Enter:launch  p:pin  o:open  ?:help  q:quit';

  const statsStr = stats
    ? `${stats.messages} msgs | ${formatTokenCount(stats.tokens)} tok`
    : '';

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={INK_COLORS.textDim}>{hints}</Text>
      {statsStr && <Text color={INK_COLORS.accent}>{statsStr}</Text>}
    </Box>
  );
});
