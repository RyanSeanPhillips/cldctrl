import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

interface BreakoutProps {
  width: number;
  height: number;
  onExit: () => void;
}

interface Brick {
  x: number;
  y: number;
  color: string;
}

interface GameState {
  paddleX: number;
  ballX: number;
  ballY: number;
  dx: number;
  dy: number;
  bricks: Brick[];
  score: number;
  lives: number;
  gameOver: boolean;
  won: boolean;
}

const BRICK_COLORS = ['red', 'magenta', 'yellow', 'green', 'cyan'];

function initBricks(fieldW: number): Brick[] {
  const bricks: Brick[] = [];
  const brickRows = 5;
  const bricksPerRow = Math.floor(fieldW / 4);
  for (let r = 0; r < brickRows; r++) {
    for (let c = 0; c < bricksPerRow; c++) {
      bricks.push({ x: c * 4 + 1, y: r + 1, color: BRICK_COLORS[r % BRICK_COLORS.length] });
    }
  }
  return bricks;
}

function initGame(fieldW: number, fieldH: number, paddleW: number): GameState {
  return {
    paddleX: Math.floor(fieldW / 2 - paddleW / 2),
    ballX: Math.floor(fieldW / 2),
    ballY: fieldH - 3,
    dx: 1,
    dy: -1,
    bricks: initBricks(fieldW),
    score: 0,
    lives: 3,
    gameOver: false,
    won: false,
  };
}

export function Breakout({ width, height, onExit }: BreakoutProps) {
  const fieldW = Math.floor((width - 4) / 2);
  const fieldH = height - 5;
  const paddleW = 6;

  const gs = useRef<GameState>(initGame(fieldW, fieldH, paddleW));
  const moveDir = useRef<number>(0);
  const [tick, setTick] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }
    if (gs.current.gameOver && (input === 'r' || input === 'R')) {
      gs.current = initGame(fieldW, fieldH, paddleW);
      setTick((t) => t + 1);
      return;
    }
    if ((input === 'h' || key.leftArrow) && !gs.current.gameOver) moveDir.current = -2;
    if ((input === 'l' || key.rightArrow) && !gs.current.gameOver) moveDir.current = 2;
  });

  useEffect(() => {
    if (gs.current.gameOver) return;
    const timer = setInterval(() => {
      const g = gs.current;

      // Move paddle
      const mv = moveDir.current;
      moveDir.current = 0;
      g.paddleX = Math.max(0, Math.min(fieldW - paddleW, g.paddleX + mv));

      // Move ball
      let nx = g.ballX + g.dx;
      let ny = g.ballY + g.dy;
      let ndx = g.dx;
      let ndy = g.dy;

      // Wall bounces
      if (nx <= 0 || nx >= fieldW - 1) { ndx = -ndx; nx = g.ballX + ndx; }
      if (ny <= 0) { ndy = -ndy; ny = g.ballY + ndy; }

      // Paddle bounce
      if (ny >= fieldH - 2 && nx >= g.paddleX && nx < g.paddleX + paddleW) {
        ndy = -1;
        ny = fieldH - 3;
      }

      // Ball lost
      if (ny >= fieldH - 1) {
        g.lives--;
        if (g.lives <= 0) {
          g.gameOver = true;
        }
        nx = Math.floor(fieldW / 2);
        ny = fieldH - 3;
        ndx = 1;
        ndy = -1;
      }

      // Brick collision
      const hitIdx = g.bricks.findIndex(
        (b) => nx >= b.x && nx < b.x + 3 && ny === b.y
      );
      if (hitIdx >= 0) {
        ndy = -ndy;
        g.score += 10;
        g.bricks = g.bricks.filter((_, i) => i !== hitIdx);
        if (g.bricks.length === 0) { g.won = true; g.gameOver = true; }
      }

      g.ballX = nx;
      g.ballY = ny;
      g.dx = ndx;
      g.dy = ndy;

      setTick((t) => t + 1);
    }, 50);
    return () => clearInterval(timer);
  }, [tick, fieldW, fieldH, paddleW]);

  // Render
  const g = gs.current;
  const lines: string[] = [];
  for (let y = 0; y < fieldH; y++) {
    const chars: string[] = new Array(fieldW).fill('  ');
    for (const b of g.bricks) {
      if (b.y === y) {
        for (let bx = b.x; bx < b.x + 3 && bx < fieldW; bx++) {
          chars[bx] = '██';
        }
      }
    }
    if (g.ballY === y && g.ballX >= 0 && g.ballX < fieldW) chars[g.ballX] = '● ';
    if (y === fieldH - 1) {
      for (let px = g.paddleX; px < g.paddleX + paddleW && px < fieldW; px++) {
        chars[px] = '▀▀';
      }
    }
    lines.push(chars.join(''));
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">Breakout</Text>
        <Text color="yellow">Score: {g.score}  Lives: {'♥'.repeat(g.lives)}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      {g.gameOver ? (
        <Box paddingX={1}>
          <Text color={g.won ? 'green' : 'red'} bold>{g.won ? 'YOU WIN!' : 'GAME OVER'} </Text>
          <Text color="gray">R:restart  Esc:quit</Text>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color="gray">h/l or ←→:move  Esc:quit</Text>
        </Box>
      )}
    </Box>
  );
}
