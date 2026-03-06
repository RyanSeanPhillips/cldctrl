/**
 * Hourly activity sparkline: ▁▂▃▅▇█ with time labels.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

interface ActivityTraceProps {
  data: number[];      // 24-element array (hourly counts)
  labels?: string[];   // custom labels
  color?: string;
  width: number;
}

export const ActivityTrace = React.memo(function ActivityTrace({
  data,
  labels,
  color = INK_COLORS.green,
  width,
}: ActivityTraceProps) {
  const maxVal = Math.max(...data, 1);

  // Limit to width
  const visible = data.slice(0, Math.min(data.length, width - 4));

  const sparkline = visible.map(v => {
    if (v === 0) return ' ';
    const level = Math.min(7, Math.floor((v / maxVal) * 7));
    return SPARK[level];
  }).join('');

  // Time labels: show every 6 hours
  const defaultLabels = ['0', '6', '12', '18', '24'];
  const displayLabels = labels || defaultLabels;
  const labelLine = displayLabels.join('     ').slice(0, visible.length);

  return (
    <Box flexDirection="column">
      <Text color={color}>{sparkline}</Text>
      <Text color={INK_COLORS.textDim} dimColor>{labelLine}</Text>
    </Box>
  );
});
