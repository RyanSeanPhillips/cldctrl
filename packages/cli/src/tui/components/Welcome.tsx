/**
 * First-run onboarding screen with prerequisite detection.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { VERSION, INK_COLORS } from '../../constants.js';
import { isCommandAvailable } from '../../core/platform.js';

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

interface PrereqStatus {
  claude: boolean | null;
  git: boolean | null;
  gh: boolean | null;
}

function PrereqChecklist({ status }: { status: PrereqStatus }) {
  const items: { label: string; ok: boolean | null; required: boolean; installHint: string }[] = [
    {
      label: 'Claude Code',
      ok: status.claude,
      required: true,
      installHint: 'npm install -g @anthropic-ai/claude-code',
    },
    {
      label: 'Git',
      ok: status.git,
      required: true,
      installHint: 'https://git-scm.com/downloads',
    },
    {
      label: 'GitHub CLI (gh)',
      ok: status.gh,
      required: false,
      installHint: 'https://cli.github.com/',
    },
  ];

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={INK_COLORS.text} bold>Prerequisites</Text>
      <Text> </Text>
      {items.map(item => {
        const icon = item.ok === null ? '...' : item.ok ? '✓' : '✗';
        const color = item.ok === null ? INK_COLORS.textDim : item.ok ? INK_COLORS.green : (item.required ? INK_COLORS.red : INK_COLORS.yellow);
        const tag = item.required ? '' : ' (optional)';

        return (
          <Box key={item.label} flexDirection="column">
            <Text>
              <Text color={color}> {icon} </Text>
              <Text color={item.ok ? INK_COLORS.text : color}>{item.label}{tag}</Text>
            </Text>
            {item.ok === false && (
              <Text color={INK_COLORS.textDim}>     {item.installHint}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export const Welcome = React.memo(function Welcome() {
  const [prereqs, setPrereqs] = useState<PrereqStatus>({ claude: null, git: null, gh: null });

  useEffect(() => {
    // Run checks asynchronously to not block render
    setPrereqs({
      claude: isCommandAvailable('claude'),
      git: isCommandAvailable('git'),
      gh: isCommandAvailable('gh'),
    });
  }, []);

  const allReady = prereqs.claude && prereqs.git;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <RocketLogo />
      <Text> </Text>

      <PrereqChecklist status={prereqs} />

      <Text> </Text>

      {allReady && (
        <>
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
        </>
      )}

      {!allReady && prereqs.claude !== null && (
        <>
          <Text color={INK_COLORS.yellow}>
            Install the required tools above, then restart CLD CTRL.
          </Text>
        </>
      )}

      <Text> </Text>
      <Text color={INK_COLORS.textDim}>
        Press q to quit
      </Text>
    </Box>
  );
});
