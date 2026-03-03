/**
 * First-run onboarding screen.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { VERSION, INK_COLORS } from '../../constants.js';

const ROCKET_BODY = '#e6963c';
const ROCKET_FIN = '#aa551e';
const ROCKET_FLAME = '#ffc832';
const ROCKET_FLAME2 = '#ff781e';

function RocketLogo() {
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        <Text>    <Text color={INK_COLORS.accent}>▄</Text></Text>
        <Text>   <Text color={INK_COLORS.accent}>▐</Text><Text color={ROCKET_BODY}>█</Text><Text color={INK_COLORS.accent}>▌</Text></Text>
        <Text>   <Text color={INK_COLORS.accent}>▐</Text><Text color={INK_COLORS.blue}>●</Text><Text color={INK_COLORS.accent}>▌</Text></Text>
        <Text>   <Text color={INK_COLORS.accent}>▐</Text><Text color={ROCKET_BODY}>█</Text><Text color={INK_COLORS.accent}>▌</Text></Text>
        <Text>  <Text color={ROCKET_FIN}>▟</Text><Text color={INK_COLORS.accent}>▐</Text><Text color={ROCKET_BODY}>█</Text><Text color={INK_COLORS.accent}>▌</Text><Text color={ROCKET_FIN}>▙</Text></Text>
        <Text>  <Text color={ROCKET_FIN}>▀</Text><Text color={INK_COLORS.accent}>▝▀▘</Text><Text color={ROCKET_FIN}>▀</Text></Text>
        <Text>   <Text color={ROCKET_FLAME2}>▝</Text><Text color={ROCKET_FLAME}>█</Text><Text color={ROCKET_FLAME2}>▘</Text></Text>
        <Text>    <Text color={ROCKET_FLAME}>▀</Text></Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} justifyContent="center">
        <Text bold color={INK_COLORS.accent}>CLD <Text color={INK_COLORS.accentLight}>CTRL</Text></Text>
        <Text color={INK_COLORS.textDim}>Mission control for Claude Code</Text>
        <Text color={INK_COLORS.textDim}>v{VERSION}</Text>
      </Box>
    </Box>
  );
}

export const Welcome = React.memo(function Welcome() {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <RocketLogo />

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
