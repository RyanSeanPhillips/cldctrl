/**
 * `?` help overlay showing keyboard shortcuts.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, VERSION } from '../../constants.js';

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['j/k          ', 'Navigate projects'],
  ['g / G        ', 'Jump to top / bottom'],
  ['Ctrl+d/u     ', 'Half-page scroll'],
  ['/            ', 'Filter projects'],
  ['Enter        ', 'Launch project (smart)'],
  ['n            ', 'New session'],
  ['c            ', 'Continue last session'],
  ['i            ', 'Toggle issues view'],
  ['p            ', 'Pin/unpin project'],
  ['h            ', 'Hide discovered project'],
  ['r            ', 'Refresh git/issues'],
  ['o            ', 'Open in file explorer'],
  ['a            ', 'Add project'],
  ['Tab          ', 'Focus details pane'],
  ['Esc          ', 'Back / exit pane'],
  ['q            ', 'Quit'],
  ['?            ', 'Toggle this help'],
];

export const HelpOverlay = React.memo(function HelpOverlay({ width, height }: { width: number; height: number }) {
  const boxWidth = Math.min(width - 4, 56);
  const boxHeight = Math.min(height - 2, SHORTCUTS.length + 8);
  const title = `  CLD CTRL v${VERSION} - Keyboard Shortcuts`;

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={boxHeight}
      borderStyle="round"
      borderColor={INK_COLORS.accent}
      paddingY={1}
    >
      <Text bold color={INK_COLORS.accent}>{title}</Text>
      <Text> </Text>

      {SHORTCUTS.map(([key, desc], i) => (
        <Text key={i}>
          <Text color={INK_COLORS.green}>{` ${key}`}</Text>
          <Text color={INK_COLORS.text}>{desc}</Text>
        </Text>
      ))}

      <Text> </Text>
      <Text color={INK_COLORS.textDim}>
        {'  Press ? or Esc to close'}
      </Text>
    </Box>
  );
});
