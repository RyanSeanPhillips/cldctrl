/**
 * Modal filter input (vim `/` style).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

interface FilterBarProps {
  visible: boolean;
  text: string;
  resultCount: number;
}

export const FilterBar = React.memo(function FilterBar({ visible, text, resultCount }: FilterBarProps) {
  if (!visible) return null;

  return (
    <Box paddingX={1}>
      <Text color={INK_COLORS.accent}>/</Text>
      <Text color={INK_COLORS.text}>{text}</Text>
      <Text color={INK_COLORS.textDim}>▌</Text>
      <Text color={INK_COLORS.textDim}> ({resultCount} matches)</Text>
    </Box>
  );
});
