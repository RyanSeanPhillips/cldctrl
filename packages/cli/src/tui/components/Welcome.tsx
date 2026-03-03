/**
 * First-run onboarding screen.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { VERSION, INK_COLORS } from '../../constants.js';

export const Welcome = React.memo(function Welcome() {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color={INK_COLORS.accent}>

        Welcome to <Text color={INK_COLORS.accent}>CLD</Text> <Text color={INK_COLORS.accentLight}>CTRL</Text> v{VERSION}
      </Text>

      <Text> </Text>

      <Text color={INK_COLORS.text}>
        No projects found. To get started:
      </Text>

      <Text> </Text>

      <Box paddingX={2} flexDirection="column">
        <Text color={INK_COLORS.green}>
          cldctrl add /path/to/your/project
        </Text>
        <Text color={INK_COLORS.green}>
          cldctrl launch my-project
        </Text>
      </Box>

      <Text> </Text>

      <Text color={INK_COLORS.text}>
        Or if you already use Claude Code, projects will be
      </Text>
      <Text color={INK_COLORS.text}>
        auto-discovered from ~/.claude/projects/
      </Text>

      <Text> </Text>

      <Text color={INK_COLORS.textDim}>
        Press q to quit
      </Text>
    </Box>
  );
});
