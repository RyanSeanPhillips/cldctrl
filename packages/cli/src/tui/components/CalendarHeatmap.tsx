/**
 * Calendar heatmap: GitHub-style horizontal grid.
 * Days of week as rows (7 rows), weeks as columns (left=oldest, right=newest).
 * Number of weeks adjusts to fill available width.
 * Color-shaded solid blocks with green gradient.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';
import { usePulse } from '../hooks/useAnimations.js';
import type { DailyUsage } from '../../types.js';

// GitHub-style green gradient (dark → bright)
const HEAT_COLORS = [
  '#161b22',  // level 0: empty (near-background)
  '#0e4429',  // level 1: low
  '#006d32',  // level 2: medium
  '#26a641',  // level 3: high
  '#39d353',  // level 4: max
];

const CELL = '██';  // 2-char solid block
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a Date as YYYY-MM-DD in local time. */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface CalendarHeatmapProps {
  title: string;
  data: DailyUsage[];
  width: number;
  days?: number;
  valueKey?: 'tokens' | 'messages' | 'commits';
}

export const CalendarHeatmap = React.memo(function CalendarHeatmap({
  title,
  data,
  width,
  days: fixedDays,
  valueKey = 'tokens',
}: CalendarHeatmapProps) {
  const pulse = usePulse(1000);

  // Build a date→value lookup
  const lookup = new Map<string, number>();
  for (const d of data) {
    const val = valueKey === 'commits' ? (d.commits ?? 0) : d[valueKey];
    lookup.set(d.date, val);
  }

  // Calculate how many weeks fit in the available width
  const cellWidth = 2;
  const labelWidth = 2; // "M " day label
  const usableWidth = Math.max(cellWidth, width - labelWidth);
  const numWeeks = Math.max(1, Math.floor(usableWidth / cellWidth));
  const numDays = fixedDays ?? numWeeks * 7;

  // Generate the date range (ending today)
  const today = new Date();
  const todayStr = localDateStr(today);
  const dates: { date: string; dayOfWeek: number; month: number }[] = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push({
      date: localDateStr(d),
      dayOfWeek: (d.getDay() + 6) % 7, // Mon=0, Sun=6
      month: d.getMonth(),
    });
  }

  // Find max value for scaling
  const maxVal = Math.max(...dates.map(d => lookup.get(d.date) ?? 0), 1);

  // Organize into a 7×N grid: grid[dayOfWeek][weekIndex]
  // Each column is one week, rows are Mon-Sun
  type Cell = { date: string; value: number; month: number } | null;
  const grid: Cell[][] = Array.from({ length: 7 }, () => []);

  // Find the starting dayOfWeek to align the grid
  const firstDay = dates[0];
  const startDow = firstDay.dayOfWeek;

  // Pad the first partial week with nulls
  let weekIdx = 0;
  for (let d = 0; d < startDow; d++) {
    grid[d].push(null);
  }

  for (const d of dates) {
    if (d.dayOfWeek === 0 && grid[0].length > 0 && grid[0].length > weekIdx) {
      weekIdx++;
    }
    // Ensure all rows have enough columns
    while (grid[d.dayOfWeek].length <= weekIdx) {
      grid[d.dayOfWeek].push(null);
    }
    grid[d.dayOfWeek][weekIdx] = {
      date: d.date,
      value: lookup.get(d.date) ?? 0,
      month: d.month,
    };
  }

  // Pad all rows to the same length
  const totalWeeks = Math.max(...grid.map(row => row.length));
  for (const row of grid) {
    while (row.length < totalWeeks) row.push(null);
  }

  // Build month labels for the top row — show month name at the first week of each month
  const monthLabels: string[] = new Array(totalWeeks).fill('');
  // Use Monday row (index 0) to detect month boundaries
  for (let w = 0; w < totalWeeks; w++) {
    const cell = grid[0][w]; // Monday of this week
    if (!cell) continue;
    const prevCell = w > 0 ? grid[0][w - 1] : null;
    if (!prevCell || prevCell.month !== cell.month) {
      monthLabels[w] = MONTH_ABBR[cell.month];
    }
  }

  return (
    <Box flexDirection="column">
      <Text color={INK_COLORS.text}>{title}</Text>
      {/* Month labels along the top */}
      <Box>
        <Text color={INK_COLORS.textDim}>
          {' '.repeat(labelWidth)}
          {monthLabels.map((lbl, i) => lbl.padEnd(cellWidth).slice(0, cellWidth)).join('')}
        </Text>
      </Box>
      {/* Day rows: Mon through Sun */}
      {grid.map((row, dayIdx) => (
        <Box key={dayIdx}>
          <Text color={INK_COLORS.textDim}>{DAY_LABELS[dayIdx]} </Text>
          {row.map((cell, weekIdx) => {
            if (!cell) {
              return <Text key={weekIdx}>{' '.repeat(cellWidth)}</Text>;
            }
            const isToday = cell.date === todayStr;
            const level = cell.value === 0 ? 0 : Math.min(4, Math.ceil((cell.value / maxVal) * 4));

            if (isToday) {
              const color = pulse ? INK_COLORS.accent : (level > 0 ? HEAT_COLORS[level] : HEAT_COLORS[1]);
              return <Text key={weekIdx} color={color} bold>{CELL}</Text>;
            }

            return <Text key={weekIdx} color={HEAT_COLORS[level]}>{CELL}</Text>;
          })}
        </Box>
      ))}
    </Box>
  );
});
