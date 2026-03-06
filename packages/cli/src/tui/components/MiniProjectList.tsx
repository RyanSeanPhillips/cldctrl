/**
 * Mini TUI: single-column project list — clean, no git status.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Project } from '../../types.js';

interface MiniProjectListProps {
  projects: Project[];
  selectedIndex: number;
  width: number;
  height: number;
  filterText?: string;
}

export const MiniProjectList = React.memo(function MiniProjectList({
  projects,
  selectedIndex,
  width,
  height,
  filterText,
}: MiniProjectListProps) {
  // Separator detection
  let lastPinnedIdx = -1;
  for (let i = 0; i < projects.length; i++) {
    if (projects[i].pinned) lastPinnedIdx = i;
  }

  const viewportHeight = Math.max(1, height - 2);
  let scrollOffset = 0;
  if (selectedIndex >= viewportHeight) {
    scrollOffset = selectedIndex - viewportHeight + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, projects.length - viewportHeight)));

  const visible = projects.slice(scrollOffset, scrollOffset + viewportHeight);
  const innerW = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" width={width}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.accent}>Projects</Text>
        {filterText !== undefined && filterText.length > 0 && (
          <Text color={INK_COLORS.textDim}> /{filterText}</Text>
        )}
      </Box>

      {projects.length === 0 && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>
            {filterText ? 'No matches' : 'No projects found'}
          </Text>
        </Box>
      )}

      {visible.map((project, i) => {
        const realIdx = scrollOffset + i;
        const isSelected = realIdx === selectedIndex;
        const showSep = realIdx > 0 && realIdx === lastPinnedIdx + 1 && project.discovered;

        return (
          <React.Fragment key={project.path}>
            {showSep && (
              <Box paddingX={1}>
                <Text color={INK_COLORS.textDim}>
                  {CHARS.separator.repeat(3)} Discovered {CHARS.separator.repeat(3)}
                </Text>
              </Box>
            )}
            <Box paddingX={1}>
              <Text
                color={isSelected ? INK_COLORS.text : (project.discovered ? INK_COLORS.textDim : INK_COLORS.text)}
                backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
                bold={isSelected}
              >
                {isSelected ? CHARS.pointer : ' '}{' '}
                {project.name.slice(0, innerW).padEnd(innerW)}
              </Text>
            </Box>
          </React.Fragment>
        );
      })}

      {/* Scroll indicators */}
      {scrollOffset > 0 && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} more</Text>
        </Box>
      )}
      {scrollOffset + viewportHeight < projects.length && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} more</Text>
        </Box>
      )}
    </Box>
  );
});
