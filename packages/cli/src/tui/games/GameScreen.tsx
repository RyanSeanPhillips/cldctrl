import React from 'react';
import { Box, Text } from 'ink';
import { Snake } from './Snake.js';
import { Breakout } from './Breakout.js';
import { Tetris } from './Tetris.js';
import { Life } from './Life.js';

interface GameScreenProps {
  game: string;
  width: number;
  height: number;
  onExit: () => void;
}

export function GameScreen({ game, width, height, onExit }: GameScreenProps) {
  switch (game) {
    case 'snake':
      return <Snake width={width} height={height} onExit={onExit} />;
    case 'breakout':
      return <Breakout width={width} height={height} onExit={onExit} />;
    case 'tetris':
      return <Tetris width={width} height={height} onExit={onExit} />;
    case 'life':
      return <Life width={width} height={height} onExit={onExit} />;
    default:
      return (
        <Box>
          <Text color="red">Unknown game: {game}</Text>
        </Box>
      );
  }
}
