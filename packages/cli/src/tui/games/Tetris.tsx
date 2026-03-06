import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

interface TetrisProps {
  width: number;
  height: number;
  onExit: () => void;
}

type Cell = string | null;
type Board = Cell[][];
type Piece = number[][];

const PIECES: { shape: Piece; color: string }[] = [
  { shape: [[1,1,1,1]], color: 'cyan' },          // I
  { shape: [[1,1],[1,1]], color: 'yellow' },       // O
  { shape: [[0,1,0],[1,1,1]], color: 'magenta' },  // T
  { shape: [[1,0],[1,0],[1,1]], color: 'blue' },   // L
  { shape: [[0,1],[0,1],[1,1]], color: '#FFA500' }, // J
  { shape: [[0,1,1],[1,1,0]], color: 'green' },    // S
  { shape: [[1,1,0],[0,1,1]], color: 'red' },      // Z
];

const BOARD_W = 10;

function createBoard(h: number): Board {
  return Array.from({ length: h }, () => new Array(BOARD_W).fill(null));
}

function rotate(piece: Piece): Piece {
  const rows = piece.length;
  const cols = piece[0].length;
  const rotated: Piece = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rotated[c][rows - 1 - r] = piece[r][c];
    }
  }
  return rotated;
}

function collides(board: Board, piece: Piece, px: number, py: number): boolean {
  for (let r = 0; r < piece.length; r++) {
    for (let c = 0; c < piece[r].length; c++) {
      if (!piece[r][c]) continue;
      const bx = px + c;
      const by = py + r;
      if (bx < 0 || bx >= BOARD_W || by >= board.length) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

function clearLines(board: Board): { board: Board; cleared: number } {
  const remaining = board.filter((row) => row.some((cell) => !cell));
  const cleared = board.length - remaining.length;
  const empty = Array.from({ length: cleared }, () => new Array(BOARD_W).fill(null));
  return { board: [...empty, ...remaining], cleared };
}

function randomPiece() {
  return PIECES[Math.floor(Math.random() * PIECES.length)];
}

interface GameState {
  board: Board;
  current: { shape: Piece; color: string };
  next: { shape: Piece; color: string };
  shape: Piece;
  px: number;
  py: number;
  score: number;
  lines: number;
  level: number;
  gameOver: boolean;
}

function initGame(boardH: number): GameState {
  const current = randomPiece();
  return {
    board: createBoard(boardH),
    current,
    next: randomPiece(),
    shape: current.shape,
    px: Math.floor(BOARD_W / 2) - 1,
    py: -1,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
  };
}

function lockPiece(g: GameState): void {
  const newBoard = g.board.map((row) => [...row]);
  for (let r = 0; r < g.shape.length; r++) {
    for (let c = 0; c < g.shape[r].length; c++) {
      if (g.shape[r][c]) {
        const by = g.py + r;
        const bx = g.px + c;
        if (by >= 0 && by < newBoard.length && bx >= 0 && bx < BOARD_W) {
          newBoard[by][bx] = g.current.color;
        }
      }
    }
  }
  const { board: cleared, cleared: count } = clearLines(newBoard);
  g.board = cleared;
  if (count > 0) {
    const pts = [0, 100, 300, 500, 800][count] ?? 800;
    g.score += pts * g.level;
    g.lines += count;
    g.level = Math.floor(g.lines / 10) + 1;
  }

  // Spawn next
  const np = g.next;
  g.current = np;
  g.shape = np.shape;
  g.px = Math.floor(BOARD_W / 2) - Math.floor(np.shape[0].length / 2);
  g.py = -1;
  g.next = randomPiece();

  // Check game over
  if (collides(g.board, g.shape, g.px, 0)) {
    g.gameOver = true;
  }
}

export function Tetris({ width, height, onExit }: TetrisProps) {
  const boardH = height - 4;
  const gs = useRef<GameState>(initGame(boardH));
  const [tick, setTick] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }
    const g = gs.current;
    if (g.gameOver && (input === 'r' || input === 'R')) {
      gs.current = initGame(boardH);
      setTick((t) => t + 1);
      return;
    }
    if (g.gameOver) return;

    if (key.leftArrow || input === 'h') {
      if (!collides(g.board, g.shape, g.px - 1, g.py)) g.px--;
      setTick((t) => t + 1);
    }
    if (key.rightArrow || input === 'l') {
      if (!collides(g.board, g.shape, g.px + 1, g.py)) g.px++;
      setTick((t) => t + 1);
    }
    if (key.upArrow || input === 'k') {
      const rotated = rotate(g.shape);
      if (!collides(g.board, rotated, g.px, g.py)) g.shape = rotated;
      setTick((t) => t + 1);
    }
    if (key.downArrow || input === 'j') {
      if (!collides(g.board, g.shape, g.px, g.py + 1)) g.py++;
      setTick((t) => t + 1);
    }
    if (input === ' ') {
      while (!collides(g.board, g.shape, g.px, g.py + 1)) g.py++;
      lockPiece(g);
      setTick((t) => t + 1);
    }
  });

  useEffect(() => {
    const g = gs.current;
    if (g.gameOver) return;
    const speed = Math.max(50, 500 - (g.level - 1) * 40);
    const timer = setInterval(() => {
      if (collides(g.board, g.shape, g.px, g.py + 1)) {
        lockPiece(g);
      } else {
        g.py++;
      }
      setTick((t) => t + 1);
    }, speed);
    return () => clearInterval(timer);
  }, [tick]);

  // Render board
  const g = gs.current;
  const display = g.board.map((row) => [...row]);
  for (let r = 0; r < g.shape.length; r++) {
    for (let c = 0; c < g.shape[r].length; c++) {
      if (g.shape[r][c]) {
        const by = g.py + r;
        const bx = g.px + c;
        if (by >= 0 && by < boardH && bx >= 0 && bx < BOARD_W) {
          display[by][bx] = g.current.color;
        }
      }
    }
  }

  const boardLines = display.map((row) =>
    '│' + row.map((cell) => (cell ? '██' : '· ')).join('') + '│'
  );

  const nextLines = g.next.shape.map((row) =>
    row.map((c) => (c ? '██' : '  ')).join('')
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="magenta">Tetris</Text>
        <Text color="yellow">Score: {g.score}  Lines: {g.lines}  Level: {g.level}</Text>
      </Box>
      <Box flexDirection="row" paddingX={1}>
        <Box flexDirection="column">
          {boardLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text>{'└' + '──'.repeat(BOARD_W) + '┘'}</Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text bold color="gray">Next:</Text>
          {nextLines.map((line, i) => (
            <Text key={i} color={g.next.color}>{line}</Text>
          ))}
        </Box>
      </Box>
      {g.gameOver ? (
        <Box paddingX={1}>
          <Text color="red" bold>GAME OVER! </Text>
          <Text color="gray">R:restart  Esc:quit</Text>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color="gray">←→:move  ↑:rotate  ↓:drop  Space:hard drop  Esc:quit</Text>
        </Box>
      )}
    </Box>
  );
}
