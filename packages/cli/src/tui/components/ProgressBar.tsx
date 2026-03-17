/**
 * Progress bar using the same green gradient as the calendar heatmap.
 * Filled portion uses intensity-based color, empty uses near-background.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

// Match the calendar heatmap gradient
const HEAT_EMPTY = '#161b22';
const HEAT_COLORS_BAR = [
  '#0e4429',  // low (0-25%)
  '#006d32',  // medium (25-50%)
  '#26a641',  // high (50-75%)
  '#39d353',  // max (75-100%)
];
const WARN_COLOR = '#f59e0b';  // yellow at 70-90%
const CRIT_COLOR = '#ef4444';  // red at 90%+

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
  const barClamped = Math.max(0, Math.min(100, percent));
  const displayPct = Math.max(0, Math.round(percent));

  const labelLen = label ? label.length + 1 : 0;
  const pctLen = 5; // " 100%"
  const barWidth = Math.max(4, width - labelLen - pctLen);
  const filled = Math.round((barClamped / 100) * barWidth);
  const empty = barWidth - filled;

  // Pick fill color based on percentage thresholds
  const fillColor = percent >= 90 ? CRIT_COLOR
    : percent >= 70 ? WARN_COLOR
    : HEAT_COLORS_BAR[Math.min(3, Math.floor(barClamped / 25))];

  const pctStr = `${displayPct}%`;

  return (
    <Box width={width}>
      {label && <Text color={INK_COLORS.textDim}>{label} </Text>}
      <Text color={fillColor}>{'█'.repeat(filled)}</Text>
      <Text color={HEAT_EMPTY}>{'█'.repeat(empty)}</Text>
      <Text color={INK_COLORS.textDim}> {pctStr}</Text>
    </Box>
  );
});
