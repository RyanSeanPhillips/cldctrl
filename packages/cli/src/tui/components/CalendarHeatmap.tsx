/**
 * Calendar heatmap: weekly grid with ░▒▓█ shading.
 * Layout: days of week across (Mon-Sun columns), weeks going down (rows).
 * Reused in left panel (all-projects) and detail pane (per-project).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';
import type { DailyUsage } from '../../types.js';

const BLOCKS = [' ', '░', '▒', '▓', '█'];
const DAY_HEADERS = 'Mo Tu We Th Fr Sa Su';

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
  days = 28,
  valueKey = 'tokens',
}: CalendarHeatmapProps) {
  // Build a date→value lookup
  const lookup = new Map<string, number>();
  for (const d of data) {
    const val = valueKey === 'commits' ? (d.commits ?? 0) : d[valueKey];
    lookup.set(d.date, val);
  }

  // Generate last N days
  const today = new Date();
  const dates: { date: string; dayOfWeek: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayOfWeek = (d.getDay() + 6) % 7; // Mon=0, Sun=6
    dates.push({ date: dateStr, dayOfWeek });
  }

  // Find max value for scaling
  const values = dates.map(d => lookup.get(d.date) ?? 0);
  const maxVal = Math.max(...values, 1);

  // Organize into weeks (rows) — each week is Mon-Sun
  const weeks: ({ date: string; value: number; dayOfWeek: number } | null)[][] = [];
  let currentWeek: typeof weeks[0] = [];

  for (const d of dates) {
    if (d.dayOfWeek === 0 && currentWeek.length > 0) {
      // Pad the end of the previous week if needed
      while (currentWeek.length < 7) currentWeek.push(null);
      weeks.push(currentWeek);
      currentWeek = [];
    }
    // Pad start of first week with nulls
    if (currentWeek.length === 0 && d.dayOfWeek > 0 && weeks.length === 0) {
      for (let i = 0; i < d.dayOfWeek; i++) currentWeek.push(null);
    }
    currentWeek.push({
      ...d,
      value: lookup.get(d.date) ?? 0,
    });
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  // Use 3-char wide cells: "█  " — total row = 3*7 = 21 chars + 3 label
  // If width is tight, use 2-char cells
  const cellWidth = width >= 28 ? 3 : 2;

  return (
    <Box flexDirection="column">
      <Text color={INK_COLORS.textDim} dimColor>{title}</Text>
      {/* Day-of-week header row */}
      <Box>
        <Text color={INK_COLORS.textDim} dimColor>
          {'   '}{cellWidth === 3
            ? 'Mo  Tu  We  Th  Fr  Sa  Su'
            : 'Mo Tu We Th Fr Sa Su'}
        </Text>
      </Box>
      {/* Week rows */}
      {weeks.map((week, wi) => (
        <Box key={wi}>
          <Text color={INK_COLORS.textDim} dimColor>
            {wi === 0 || wi === weeks.length - 1
              ? `W${String(wi + 1).padEnd(cellWidth === 3 ? 2 : 1)}`
              : '   '.slice(0, cellWidth === 3 ? 3 : 2) + ' '}
          </Text>
          {week.map((cell, di) => {
            if (!cell) {
              return <Text key={di} color={INK_COLORS.textDim}>{' '.repeat(cellWidth)}</Text>;
            }
            const level = cell.value === 0 ? 0 : Math.min(4, Math.ceil((cell.value / maxVal) * 4));
            const block = BLOCKS[level];
            return (
              <Text key={di} color={level > 0 ? INK_COLORS.green : INK_COLORS.textDim}>
                {block}{' '.repeat(cellWidth - 1)}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
});
