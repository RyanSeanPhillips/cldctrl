/**
 * Prompt input bar for launching Claude with a specific prompt.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS } from '../../constants.js';

interface PromptBarProps {
  visible: boolean;
  text: string;
  projectName?: string;
}

export const PromptBar = React.memo(function PromptBar({ visible, text, projectName }: PromptBarProps) {
  if (!visible) return null;

  return (
    <Box paddingX={1}>
      <Text color={INK_COLORS.accent}>{'>'} </Text>
      {projectName && <Text color={INK_COLORS.textDim}>{projectName}: </Text>}
      <Text color={INK_COLORS.text}>{text}</Text>
      <Text color={INK_COLORS.textDim}>▌</Text>
      {!text && <Text color={INK_COLORS.textDim}> type your prompt...</Text>}
    </Box>
  );
});
