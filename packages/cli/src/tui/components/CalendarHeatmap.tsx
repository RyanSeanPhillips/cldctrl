/**
 * Calendar heatmap: weekly grid with color-shaded solid blocks.
 * Layout: days of week across (Mon-Sun columns), weeks going down (rows).
 * Each day is a 2-char "██" square with color intensity from a green gradient.
 * Reused in left panel (all-projects) and detail pane (per-project).
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

const CELL = '██';  // 2-char solid block — roughly square in monospace

const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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
      while (currentWeek.length < 7) currentWeek.push(null);
      weeks.push(currentWeek);
      currentWeek = [];
    }
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

  const cellWidth = 2; // "██" = roughly square
  const gap = 0;       // no gap — GitHub-style tight grid, color separates days
  const labelWidth = 6;

  // Build week start-date labels
  const weekLabels = weeks.map(week => {
    const firstCell = week.find(c => c !== null);
    if (!firstCell) return '';
    const parts = firstCell.date.split('-');
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    return `${m}/${String(d).padStart(2, '0')}`;
  });

  return (
    <Box flexDirection="column">
      <Text color={INK_COLORS.text}>{title}</Text>
      {/* Day-of-week header */}
      <Box>
        <Text color={INK_COLORS.textDim}>
          {' '.repeat(labelWidth)}{DAY_LABELS.map(d => d.padEnd(cellWidth)).join('')}
        </Text>
      </Box>
      {/* Week rows */}
      {weeks.map((week, wi) => (
        <Box key={wi}>
          <Text color={INK_COLORS.textDim}>
            {weekLabels[wi].padEnd(labelWidth)}
          </Text>
          {week.map((cell, di) => {
            if (!cell) {
              return <Text key={di}>{' '.repeat(cellWidth + gap)}</Text>;
            }
            const isToday = cell.date === todayStr;
            const level = cell.value === 0 ? 0 : Math.min(4, Math.ceil((cell.value / maxVal) * 4));

            if (isToday) {
              // Today: pulse between accent and top-level green
              const color = pulse ? INK_COLORS.accent : (level > 0 ? HEAT_COLORS[level] : HEAT_COLORS[1]);
              return (
                <Text key={di} color={color} bold>
                  {CELL}{' '.repeat(gap)}
                </Text>
              );
            }

            return (
              <Text key={di} color={HEAT_COLORS[level]}>
                {CELL}{' '.repeat(gap)}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
});
