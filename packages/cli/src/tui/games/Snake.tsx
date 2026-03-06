import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

interface SnakeProps {
  width: number;
  height: number;
  onExit: () => void;
}

type Pos = { x: number; y: number };
type Dir = 'up' | 'down' | 'left' | 'right';

function randomFood(cols: number, rows: number, snake: Pos[]): Pos {
  let pos: Pos;
  do {
    pos = { x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows) };
  } while (snake.some((s) => s.x === pos.x && s.y === pos.y));
  return pos;
}

export function Snake({ width, height, onExit }: SnakeProps) {
  const gridCols = Math.floor((width - 4) / 2);
  const gridRows = height - 5;
  const midX = Math.floor(gridCols / 2);
  const midY = Math.floor(gridRows / 2);

  const [snake, setSnake] = useState<Pos[]>([{ x: midX, y: midY }]);
  const [food, setFood] = useState<Pos>(() => randomFood(gridCols, gridRows, [{ x: midX, y: midY }]));
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const dirRef = useRef<Dir>('right');
  const nextDirRef = useRef<Dir>('right');

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }
    if (gameOver && (input === 'r' || input === 'R')) {
      const start = [{ x: midX, y: midY }];
      setSnake(start);
      setFood(randomFood(gridCols, gridRows, start));
      setScore(0);
      setGameOver(false);
      dirRef.current = 'right';
      nextDirRef.current = 'right';
      return;
    }
    const cur = dirRef.current;
    if ((input === 'h' || key.leftArrow) && cur !== 'right') nextDirRef.current = 'left';
    if ((input === 'l' || key.rightArrow) && cur !== 'left') nextDirRef.current = 'right';
    if ((input === 'k' || key.upArrow) && cur !== 'down') nextDirRef.current = 'up';
    if ((input === 'j' || key.downArrow) && cur !== 'up') nextDirRef.current = 'down';
  });

  useEffect(() => {
    if (gameOver) return;
    const timer = setInterval(() => {
      setSnake((prev) => {
        dirRef.current = nextDirRef.current;
        const dir = dirRef.current;
        const head = prev[0];
        const next: Pos = {
          x: dir === 'left' ? head.x - 1 : dir === 'right' ? head.x + 1 : head.x,
          y: dir === 'up' ? head.y - 1 : dir === 'down' ? head.y + 1 : head.y,
        };

        if (next.x < 0 || next.x >= gridCols || next.y < 0 || next.y >= gridRows ||
            prev.some((s) => s.x === next.x && s.y === next.y)) {
          setGameOver(true);
          return prev;
        }

        const newSnake = [next, ...prev];
        if (next.x === food.x && next.y === food.y) {
          setScore((s) => s + 10);
          setFood(randomFood(gridCols, gridRows, newSnake));
        } else {
          newSnake.pop();
        }
        return newSnake;
      });
    }, 150);
    return () => clearInterval(timer);
  }, [gameOver, food, gridCols, gridRows]);

  // Render grid
  const lines: string[] = [];
  const top = '┌' + '──'.repeat(gridCols) + '┐';
  const bottom = '└' + '──'.repeat(gridCols) + '┘';
  lines.push(top);
  for (let y = 0; y < gridRows; y++) {
    let row = '│';
    for (let x = 0; x < gridCols; x++) {
      if (snake.some((s) => s.x === x && s.y === y)) {
        row += snake[0].x === x && snake[0].y === y ? '██' : '▓▓';
      } else if (food.x === x && food.y === y) {
        row += '◆ ';
      } else {
        row += '  ';
      }
    }
    row += '│';
    lines.push(row);
  }
  lines.push(bottom);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="green">Snake</Text>
        <Text color="yellow">Score: {score}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => (
          <Text key={i} color="green">{line}</Text>
        ))}
      </Box>
      {gameOver && (
        <Box paddingX={1}>
          <Text color="red" bold>GAME OVER! </Text>
          <Text color="gray">R:restart  Esc:quit</Text>
        </Box>
      )}
      {!gameOver && (
        <Box paddingX={1}>
          <Text color="gray">hjkl/arrows:move  Esc:quit</Text>
        </Box>
      )}
    </Box>
  );
}
