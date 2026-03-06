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
  launchMsg?: string;
  dailyBudget?: number;
}

export const StatusBar = React.memo(function StatusBar({ mode, stats, width, focusPane, launchMsg, dailyBudget }: StatusBarProps) {
  // Show launch feedback when present, otherwise normal hints
  if (launchMsg) {
    return (
      <Box width={width} paddingX={1}>
        <Text color={INK_COLORS.green}>{launchMsg}</Text>
      </Box>
    );
  }

  const hints =
    mode === 'filter'
      ? 'Type to filter | Enter:select | Esc:cancel'
      : mode === 'prompt'
        ? 'Type prompt | Enter:launch | Esc:cancel'
        : focusPane === 'details'
          ? 'j/k:nav sessions  Enter:resume  Esc:back  q:quit'
          : 'j/k:nav  /:filter  n:new+prompt  Enter:launch  o:folder  p:pin  ?:help  q:quit';

  const showBudgetBar = stats && dailyBudget && dailyBudget > 0;
  const budget = dailyBudget ?? 0;

  const statsStr = stats
    ? `${stats.messages} msgs · ${formatTokenCount(stats.tokens)} tok`
    : '';

  // Build compact budget bar: ██████░░ 62%
  let budgetBar = '';
  let budgetColor = INK_COLORS.green;
  if (showBudgetBar) {
    const percent = Math.max(0, Math.min(100, (stats.tokens / budget) * 100));
    const barWidth = 8;
    const filled = Math.round((percent / 100) * barWidth);
    budgetBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    budgetColor = percent >= 90 ? INK_COLORS.red : percent >= 70 ? INK_COLORS.yellow : INK_COLORS.green;
    const pctStr = `${Math.round(percent)}%`;

    return (
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={INK_COLORS.textDim}>{hints}</Text>
        <Text>
          <Text color={budgetColor}>{budgetBar}</Text>
          <Text color={INK_COLORS.textDim}> {pctStr} · </Text>
          <Text color={INK_COLORS.accent}>{statsStr}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={INK_COLORS.textDim}>{hints}</Text>
      {statsStr && <Text color={INK_COLORS.accent}>{statsStr}</Text>}
    </Box>
  );
});
