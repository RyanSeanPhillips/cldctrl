/**
 * Calendar heatmap: weekly grid with ░▒▓█ shading.
 * Layout: days of week across (Mon-Sun columns), weeks going down (rows).
 * Reused in left panel (all-projects) and detail pane (per-project).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';
import { usePulse } from '../hooks/useAnimations.js';
import type { DailyUsage } from '../../types.js';

const BLOCKS = [' ', '░', '▒', '▓', '█'];
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Format a Date as YYYY-MM-DD in local time (not UTC). */
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
  days = 28,
  valueKey = 'tokens',
}: CalendarHeatmapProps) {
  const pulse = usePulse(1000);

  // Build a date→value lookup
  const lookup = new Map<string, number>();
  for (const d of data) {
    const val = valueKey === 'commits' ? (d.commits ?? 0) : d[valueKey];
    lookup.set(d.date, val);
  }

  // Generate last N days using local dates (not UTC)
  const today = new Date();
  const todayStr = localDateStr(today);
  const dates: { date: string; dayOfWeek: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = localDateStr(d);
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
  const labelWidth = cellWidth === 3 ? 6 : 4; // room for "3/03 " or "3/3"

  // Build week start-date labels (Mon date of each week row)
  const weekLabels = weeks.map(week => {
    const firstCell = week.find(c => c !== null);
    if (!firstCell) return '';
    // Parse the date string to get month/day
    const parts = firstCell.date.split('-');
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    return `${m}/${String(d).padStart(2, '0')}`;
  });

  return (
    <Box flexDirection="column">
      <Text color={INK_COLORS.text}>{title}</Text>
      {/* Day-of-week header row */}
      <Box>
        <Text color={INK_COLORS.text}>
          {' '.repeat(labelWidth)}{DAY_LABELS.map(d => d.padEnd(cellWidth)).join('')}
        </Text>
      </Box>
      {/* Week rows */}
      {weeks.map((week, wi) => (
        <Box key={wi}>
          <Text color={INK_COLORS.text}>
            {weekLabels[wi].padEnd(labelWidth)}
          </Text>
          {week.map((cell, di) => {
            if (!cell) {
              return <Text key={di} color={INK_COLORS.textDim}>{' '.repeat(cellWidth)}</Text>;
            }
            const isToday = cell.date === todayStr;
            const level = cell.value === 0 ? 0 : Math.min(4, Math.ceil((cell.value / maxVal) * 4));
            const block = BLOCKS[level];

            // Today: pulse between accent and green to highlight current day
            if (isToday) {
              const todayBlock = level > 0 ? block : '◦';
              return (
                <Text key={di} color={pulse ? INK_COLORS.accent : INK_COLORS.green} bold>
                  {todayBlock}{' '.repeat(cellWidth - 1)}
                </Text>
              );
            }

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
