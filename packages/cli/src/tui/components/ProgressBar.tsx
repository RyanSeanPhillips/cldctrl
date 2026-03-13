/**
 * Progress bar: [label] ████░░░ 62%
 * Width is the total available character width including label and percentage.
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

  // Account for all non-bar content:
  // label + " " + bar + " " + "100%" (4 chars max)
  const labelLen = label ? label.length + 1 : 0; // "Label "
  const pctLen = 5; // " 100%" (space + up to 4 chars)
  const barWidth = Math.max(4, width - labelLen - pctLen);
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = clamped >= 90 ? INK_COLORS.red : clamped >= 70 ? INK_COLORS.yellow : INK_COLORS.green;
  const pctStr = `${Math.round(clamped)}%`;

  return (
    <Box width={width}>
      {label && <Text color={INK_COLORS.textDim}>{label} </Text>}
      <Text color={color}>{bar}</Text>
      <Text color={INK_COLORS.textDim}> {pctStr}</Text>
    </Box>
  );
});
