import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface LifeProps {
  width: number;
  height: number;
  onExit: () => void;
}

type Grid = boolean[][];

function createGrid(rows: number, cols: number, random: boolean): Grid {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (random ? Math.random() < 0.3 : false))
  );
}

function step(grid: Grid): Grid {
  const rows = grid.length;
  const cols = grid[0].length;
  return grid.map((row, r) =>
    row.map((alive, c) => {
      let neighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = (r + dr + rows) % rows;
          const nc = (c + dc + cols) % cols;
          if (grid[nr][nc]) neighbors++;
        }
      }
      return alive ? neighbors === 2 || neighbors === 3 : neighbors === 3;
    })
  );
}

// Render 2 grid rows per terminal row using half-block characters
// Top cell = upper half, Bottom cell = lower half
// ▀ = top only, ▄ = bottom only, █ = both, ' ' = neither
function renderHalfBlock(grid: Grid, cols: number): string[] {
  const rows = grid.length;
  const lines: string[] = [];
  for (let r = 0; r < rows; r += 2) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const top = grid[r][c];
      const bot = r + 1 < rows ? grid[r + 1][c] : false;
      if (top && bot) line += '█';
      else if (top) line += '▀';
      else if (bot) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

export function Life({ width, height, onExit }: LifeProps) {
  // Each terminal char = 1 col, each terminal row = 2 grid rows
  const gridCols = width - 2;
  const termRows = height - 4;
  const gridRows = termRows * 2; // double vertical resolution
  const [grid, setGrid] = useState<Grid>(() => createGrid(gridRows, gridCols, true));
  const [paused, setPaused] = useState(false);
  const [gen, setGen] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }
    if (input === ' ') { setPaused((p) => !p); return; }
    if (input === 'r' || input === 'R') {
      setGrid(createGrid(gridRows, gridCols, true));
      setGen(0);
      return;
    }
  });

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      setGrid((g) => step(g));
      setGen((n) => n + 1);
    }, 200);
    return () => clearInterval(timer);
  }, [paused]);

  const rendered = renderHalfBlock(grid, gridCols);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="green">Game of Life</Text>
        <Text color="gray">Gen: {gen} {paused ? '⏸ PAUSED' : '▶'}  ({gridCols}x{gridRows})</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {rendered.map((line, i) => (
          <Text key={i} color="green">{line}</Text>
        ))}
      </Box>
      <Box paddingX={1}>
        <Text color="gray">Space:pause  R:randomize  Esc:exit</Text>
      </Box>
    </Box>
  );
}
