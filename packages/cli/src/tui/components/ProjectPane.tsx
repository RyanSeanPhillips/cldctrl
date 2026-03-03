/**
 * Left pane: project list with git status, issue badges.
 */

import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Project, GitStatus } from '../../types.js';

interface ProjectPaneProps {
  projects: Project[];
  selectedIndex: number;
  width: number;
  height: number;
  gitStatuses: Map<string, GitStatus>;
  issueCounts: Map<string, number>;
  focused: boolean;
  filterText?: string;
  loading?: boolean;
}

export const ProjectPane = React.memo(function ProjectPane({
  projects,
  selectedIndex,
  width,
  height,
  gitStatuses,
  issueCounts,
  focused,
  filterText,
  loading,
}: ProjectPaneProps) {
  // Persistent scroll offset — survives re-renders
  const scrollRef = useRef(0);
  const viewportHeight = Math.max(1, height - 4); // border + header + potential scroll indicators

  // Adjust scroll offset to keep selectedIndex visible
  let scrollOffset = scrollRef.current;
  if (selectedIndex >= scrollOffset + viewportHeight) {
    scrollOffset = selectedIndex - viewportHeight + 1;
  }
  if (selectedIndex < scrollOffset) {
    scrollOffset = selectedIndex;
  }
  // Clamp to valid range
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, projects.length - viewportHeight)));
  scrollRef.current = scrollOffset;

  const visibleProjects = projects.slice(scrollOffset, scrollOffset + viewportHeight);

  // Dynamic name width based on pane width
  const usableWidth = Math.max(10, width - 4); // borders + padding
  const nameWidth = Math.max(8, Math.min(usableWidth - 16, 24)); // leave room for git status
  const gitWidth = Math.max(4, usableWidth - nameWidth - 4); // remaining space

  // Detect separator point between pinned and discovered
  let lastPinnedIdx = -1;
  for (let i = 0; i < projects.length; i++) {
    if (projects[i].pinned) lastPinnedIdx = i;
  }

  const hasAbove = scrollOffset > 0;
  const hasBelow = scrollOffset + viewportHeight < projects.length;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? INK_COLORS.accent : INK_COLORS.border}
    >
      <Box paddingX={1}>
        <Text bold color={INK_COLORS.accent}>
          Projects
        </Text>
        {filterText !== undefined && filterText.length > 0 && (
          <Text color={INK_COLORS.textDim}> /{filterText}</Text>
        )}
        {loading && <Text color={INK_COLORS.textDim}> ...</Text>}
      </Box>

      {/* No matches message */}
      {projects.length === 0 && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>
            {filterText ? 'No matches' : 'No projects found'}
          </Text>
        </Box>
      )}

      {visibleProjects.map((project, i) => {
        const realIndex = scrollOffset + i;
        const isSelected = realIndex === selectedIndex;
        const git = gitStatuses.get(project.path);
        const issueCount = issueCounts.get(project.path) ?? 0;
        const gitStr = git === undefined && loading ? '...' : formatGitStatus(git ?? null);

        // Show separator before first discovered project
        const showSeparator =
          realIndex > 0 &&
          realIndex === lastPinnedIdx + 1 &&
          project.discovered;

        return (
          <React.Fragment key={project.path}>
            {showSeparator && (
              <Box paddingX={1}>
                <Text color={INK_COLORS.textDim}>
                  {CHARS.separator.repeat(3)} Discovered {CHARS.separator.repeat(3)}
                </Text>
              </Box>
            )}
            <Box paddingX={1}>
              <Text
                color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
                backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
                bold={isSelected}
              >
                {isSelected ? CHARS.pointer : ' '}{' '}
                {project.name.slice(0, nameWidth).padEnd(nameWidth)}{' '}
                <Text color={git?.dirty ? INK_COLORS.yellow : INK_COLORS.green}>
                  {gitStr.slice(0, gitWidth)}
                </Text>
                {issueCount > 0 && (
                  <Text color={INK_COLORS.accent}> {CHARS.warning}{issueCount}</Text>
                )}
              </Text>
            </Box>
          </React.Fragment>
        );
      })}

      {/* Scroll indicators */}
      {hasAbove && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} more above</Text>
        </Box>
      )}
      {hasBelow && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} more below</Text>
        </Box>
      )}
    </Box>
  );
});
