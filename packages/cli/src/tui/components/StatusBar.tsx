/**
 * Bottom bar: keyboard hints + animated daily usage stats + tier badge + rate limits.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatTokenCount } from '../../core/sessions.js';
import { useAnimatedCounter } from '../hooks/useAnimations.js';
import { INK_COLORS } from '../../constants.js';
import type { UsageStats, UsageBudget } from '../../types.js';

interface StatusBarProps {
  mode: string;
  stats?: UsageStats;
  width: number;
  focusPane?: string;
  launchMsg?: string;
  usageBudget?: UsageBudget | null;
  scanning?: boolean;
  leftPaneMode?: string;
}

export const StatusBar = React.memo(function StatusBar({ mode, stats, width, focusPane, launchMsg, usageBudget, leftPaneMode }: StatusBarProps) {
  // Animated counters — count up smoothly when stats change
  const animatedTokens = useAnimatedCounter(stats?.tokens ?? 0, 1500);
  const animatedMessages = useAnimatedCounter(stats?.messages ?? 0, 800);

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
        : leftPaneMode === 'conversations'
          ? 'j/k:nav  Enter:focus  Tab:expand  Esc:projects  ?:help  q:quit'
          : focusPane === 'details'
            ? 'j/k:nav sessions  Enter:resume  Esc:back  q:quit'
            : 'j/k:nav /:filter n:new Enter:launch l:live ,:settings ?:help q:quit';

  // Compact right-side: [Tier] X% or basic stats (full bars live in ProjectPane)
  const hasLiveData = usageBudget?.rateLimits != null;
  const hasBudget = usageBudget && usageBudget.limit > 0;

  let rightSide = '';
  let rightColor: string = INK_COLORS.accent;
  let tierPrefix = '';

  if (hasBudget && hasLiveData) {
    const pct = Math.round(usageBudget.percent);
    const extraTag = usageBudget.rateLimits!.usingExtraTokens ? ' · EXTRA' : '';
    rightSide = `5h:${Math.round(usageBudget.rateLimits!.fiveHourPercent)}%  7d:${Math.round(usageBudget.rateLimits!.sevenDayPercent)}%${extraTag}`;
    rightColor = usageBudget.rateLimits!.usingExtraTokens ? INK_COLORS.yellow
      : pct >= 90 ? INK_COLORS.red : pct >= 70 ? INK_COLORS.yellow : INK_COLORS.accent;
    if (usageBudget.tierLabel) tierPrefix = `[${usageBudget.tierLabel}] `;
  } else if (hasBudget) {
    const pct = Math.round(usageBudget.percent);
    rightSide = `${pct}% · ${animatedMessages} msgs · ${formatTokenCount(animatedTokens)} tok`;
    rightColor = pct >= 90 ? INK_COLORS.red : pct >= 70 ? INK_COLORS.yellow : INK_COLORS.accent;
    if (usageBudget.tierLabel) tierPrefix = `[${usageBudget.tierLabel}] `;
  } else if (stats) {
    rightSide = `${animatedMessages} msgs · ${formatTokenCount(animatedTokens)} tok`;
  }

  // Truncate hints if they'd overlap with rightSide
  const rightLen = rightSide ? tierPrefix.length + rightSide.length + 2 : 0;
  const maxHintLen = Math.max(10, width - 2 - rightLen);
  const displayHints = hints.length > maxHintLen ? hints.slice(0, maxHintLen - 1) + '…' : hints;

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text color={INK_COLORS.textDim}>{displayHints}</Text>
      {rightSide && (
        <Text>
          {tierPrefix && <Text color={INK_COLORS.blue}>{tierPrefix}</Text>}
          <Text color={rightColor}>{rightSide}</Text>
        </Text>
      )}
    </Box>
  );
});
