/**
 * Progress bar: ████░░░ 62%
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

interface ProgressBarProps {
  percent: number;
  width: number;
  label?: string;
}

export const ProgressBar = React.memo(function ProgressBar({
  percent,
  width,
  label,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const barWidth = Math.max(4, width - 6); // room for " 100%"
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = clamped >= 90 ? INK_COLORS.red : clamped >= 70 ? INK_COLORS.yellow : INK_COLORS.green;

  return (
    <Box>
      {label && <Text color={INK_COLORS.textDim}>{label} </Text>}
      <Text color={color}>{bar}</Text>
      <Text color={INK_COLORS.textDim}> {Math.round(clamped)}%</Text>
    </Box>
  );
});
