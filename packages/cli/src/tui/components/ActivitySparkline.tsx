/**
 * Sparkline component: renders a series of values as Unicode block characters.
 * Used for context growth charts and hourly activity visualization.
 */

import React from 'react';
import { Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

interface ActivitySparklineProps {
  values: number[];
  width?: number;
  color?: string;
  dimColor?: string;
  /** Highlight the peak value in a different color */
  highlightPeak?: boolean;
}

export const ActivitySparkline = React.memo(function ActivitySparkline({
  values,
  width,
  color = INK_COLORS.green,
  dimColor = INK_COLORS.textDim,
  highlightPeak = false,
}: ActivitySparklineProps) {
  if (values.length === 0) return <Text color={dimColor}>-</Text>;

  // Downsample if wider than available width
  let data = values;
  if (width && data.length > width) {
    const step = data.length / width;
    const sampled: number[] = [];
    for (let i = 0; i < width; i++) {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      let sum = 0;
      for (let j = start; j < end; j++) sum += data[j];
      sampled.push(sum / (end - start));
    }
    data = sampled;
  }

  const max = Math.max(...data);
  if (max === 0) return <Text color={dimColor}>{'▁'.repeat(data.length)}</Text>;

  const peakIdx = highlightPeak ? data.indexOf(max) : -1;

  const chars = data.map((v, i) => {
    const level = Math.min(7, Math.floor((v / max) * 7));
    const char = BLOCKS[level];
    if (i === peakIdx) return { char, isPeak: true };
    return { char, isPeak: false };
  });

  return (
    <Text>
      {chars.map((c, i) => (
        <Text key={i} color={c.isPeak ? INK_COLORS.accent : (c.char === '▁' ? dimColor : color)}>
          {c.char}
        </Text>
      ))}
    </Text>
  );
});
