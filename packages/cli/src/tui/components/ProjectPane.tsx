/**
 * Left pane: project list with git status, issue badges.
 */

import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import { CalendarHeatmap } from './CalendarHeatmap.js';
import { ProgressBar } from './ProgressBar.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}
import type { Project, GitStatus, ActiveSession, DailyUsage, UsageStats } from '../../types.js';
import type { ClaudeCommand, ClaudeSkill } from '../../core/skills.js';
import type { CommandUsageCounts } from '../../core/command-usage.js';

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
  activeProcesses?: Map<string, ActiveSession>;
  usageHistory?: DailyUsage[];
  dailyBudget?: number;
  usageStats?: UsageStats;
  skillsData?: { commands: ClaudeCommand[]; skills: ClaudeSkill[] };
  commandUsage?: CommandUsageCounts;
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
  activeProcesses,
  usageHistory,
  dailyBudget,
  usageStats,
  skillsData,
  commandUsage,
}: ProjectPaneProps) {
  // Persistent scroll offset — survives re-renders
  const scrollRef = useRef(0);

  // Detect separator point between pinned and discovered
  let lastPinnedIdx = -1;
  for (let i = 0; i < projects.length; i++) {
    if (projects[i].pinned) lastPinnedIdx = i;
  }

  // Subtract stats panel height when visible
  const statsRows = height >= 25 && (usageHistory || usageStats || dailyBudget) ? 5 : 0;
  // Reserve rows for commands section when visible (header + items + "+N more" + "? full list")
  const cmdCount = skillsData ? skillsData.commands.length + skillsData.skills.length : 0;
  const cmdSectionRows = height >= 20 && cmdCount > 0
    ? Math.min(cmdCount + 3, Math.max(5, Math.floor((height - statsRows) * 0.3)))
    : 0;
  const baseViewport = Math.max(1, height - 4 - statsRows - cmdSectionRows);

  // Subtract extra rows for separators
  let extraRows = 0;
  const estimatedEnd = Math.min(projects.length, scrollRef.current + baseViewport);
  for (let i = scrollRef.current; i < estimatedEnd; i++) {
    if (i > 0 && i === lastPinnedIdx + 1 && projects[i].discovered) extraRows++;
  }
  const viewportHeight = Math.max(1, baseViewport - extraRows);

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
        const activeSession = activeProcesses?.get(project.path);

        // Show separator before first discovered project
        const showSeparator =
          realIndex > 0 &&
          realIndex === lastPinnedIdx + 1 &&
          project.discovered;

        // Build inline active badge: ● action 3m 45k
        let activeBadge = '';
        let badgeColor = '';
        if (activeSession) {
          const isIdle = activeSession.tracked && activeSession.idle;
          badgeColor = isIdle ? INK_COLORS.yellow : INK_COLORS.green;
          const action = activeSession.currentAction || (isIdle ? 'idle' : 'active');
          const dur = formatDuration(Date.now() - activeSession.startTime.getTime());
          const tok = formatTokenCount(activeSession.stats.tokens);
          activeBadge = `${action} ${dur} ${tok}`;
        }

        // When active, shrink name to make room for badge
        const badgeLen = activeBadge ? activeBadge.length + 3 : 0; // "● " + badge + " "
        const effectiveNameWidth = activeSession
          ? Math.max(6, nameWidth - Math.max(0, badgeLen - gitWidth))
          : nameWidth;

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
                {project.name.slice(0, effectiveNameWidth).padEnd(effectiveNameWidth)}{' '}
                {activeSession && (
                  <>
                    <Text color={badgeColor}>{'●'}</Text>
                    <Text color={INK_COLORS.textDim}>
                      {' '}{activeBadge.slice(0, Math.max(4, usableWidth - effectiveNameWidth - 6))}{' '}
                    </Text>
                  </>
                )}
                {!activeSession && (
                  <Text color={git?.dirty ? INK_COLORS.yellow : INK_COLORS.green}>
                    {gitStr.slice(0, gitWidth)}
                  </Text>
                )}
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

      {/* Commands summary */}
      {height >= 20 && skillsData && (skillsData.commands.length + skillsData.skills.length) > 0 && (() => {
        const allCmds = skillsData.commands;
        const innerWidth = Math.max(10, width - 4);
        // How many command rows we can fit (leave 3 for header + "+N more" + "? full list")
        const maxCmds = Math.max(1, Math.min(allCmds.length, cmdSectionRows - 3));
        const countW = 5; // " (3x)"
        const descW = Math.max(0, innerWidth - 16 - countW);

        const cmdColor = (source: string) =>
          source === 'user' ? INK_COLORS.accent
          : source === 'project' ? INK_COLORS.green
          : INK_COLORS.blue; // plugin

        // Sort: most-used first, then alphabetical
        const sorted = [...allCmds].sort((a, b) => {
          const aUse = commandUsage?.[a.name] ?? 0;
          const bUse = commandUsage?.[b.name] ?? 0;
          if (bUse !== aUse) return bUse - aUse;
          return a.name.localeCompare(b.name);
        });

        return (
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text color={INK_COLORS.textDim}>
              {CHARS.separator.repeat(3)} Commands {CHARS.separator.repeat(Math.max(1, innerWidth - 12))}
            </Text>
            {sorted.slice(0, maxCmds).map(c => {
              const uses = commandUsage?.[c.name] ?? 0;
              return (
                <Text key={c.name}>
                  <Text color={cmdColor(c.source)}>{` /${c.name.padEnd(13)}`}</Text>
                  {descW > 0 && c.description && (
                    <Text color={INK_COLORS.textDim}>{c.description.slice(0, descW)}</Text>
                  )}
                  {uses > 0 && (
                    <Text color={INK_COLORS.text}>{` ${uses}x`}</Text>
                  )}
                </Text>
              );
            })}
            {allCmds.length > maxCmds && (
              <Text color={INK_COLORS.textDim}>{' '}+{allCmds.length - maxCmds} more</Text>
            )}
            <Text color={INK_COLORS.textDim}>{' '}{'?  full list'}</Text>
          </Box>
        );
      })()}

      {/* Bottom stats panel */}
      {height >= 25 && (usageHistory || usageStats || dailyBudget) && (
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>
              {CHARS.separator.repeat(Math.max(1, width - 4))}
            </Text>
          </Box>

          {/* Calendar heatmap (hide if height < 25) */}
          {usageHistory && usageHistory.length > 0 && height >= 30 && (
            <Box paddingX={1}>
              <CalendarHeatmap
                title="Usage"
                data={usageHistory}
                width={Math.max(8, width - 4)}
                days={28}
              />
            </Box>
          )}

          {/* Today's stats */}
          {usageStats && height >= 18 && (
            <Box paddingX={1}>
              <Text color={INK_COLORS.textDim}>
                {usageStats.messages} msgs {CHARS.bullet} {formatTokenCount(usageStats.tokens)} tok
              </Text>
            </Box>
          )}

          {/* Budget progress bar */}
          {dailyBudget && usageStats && (
            <Box paddingX={1}>
              <ProgressBar
                percent={(usageStats.tokens / dailyBudget) * 100}
                width={Math.max(8, width - 6)}
                label="Budget"
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
});
