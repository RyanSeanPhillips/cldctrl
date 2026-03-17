/**
 * Left pane: project list with git status, issue badges.
 */

import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import { formatGitStatus } from '../../core/git.js';
import { formatTokenCount } from '../../core/sessions.js';
import { estimateCostBlended, formatCost, isCostRelevant } from '../../core/pricing.js';
import { isFeatureEnabled } from '../../config.js';
import { INK_COLORS, CHARS, formatDuration } from '../../constants.js';
import { usePulse, useClaudeSpinnerFrame, claudeSpinnerFrame } from '../hooks/useAnimations.js';
import { CalendarHeatmap } from './CalendarHeatmap.js';
import { ProgressBar } from './ProgressBar.js';
import { ActivitySparkline } from './ActivitySparkline.js';
import type { Config, Project, GitStatus, ActiveSession, DailyUsage, UsageStats, UsageBudget, LeftSection } from '../../types.js';
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
  usageStats?: UsageStats;
  usageBudget?: UsageBudget | null;
  skillsData?: { commands: ClaudeCommand[]; skills: ClaudeSkill[] };
  commandUsage?: CommandUsageCounts;
  config?: Config;
  /** Sorted active conversations (for inline conversations section) */
  conversations?: ActiveSession[];
  /** Selected conversation index */
  conversationIndex?: number;
  /** Which section of the left pane has the cursor */
  leftSection?: LeftSection;
}

/** Conversations section — shows active + idle sessions with spinner and actions */
function ConversationsSection({ convs, inConvSection, convIdx, usableWidth, pulse }: {
  convs: ActiveSession[];
  inConvSection: boolean;
  convIdx: number;
  usableWidth: number;
  pulse: boolean;
}) {
  const liveCount = convs.filter(s => !s.idle).length;
  const idleCount = convs.length - liveCount;
  const hasAnyActive = liveCount > 0;
  const spinnerFrame = useClaudeSpinnerFrame(hasAnyActive, 120);

  // Header: "── Conversations (1 live · 2 idle) ──"
  const countLabel = [
    liveCount > 0 ? `${liveCount} live` : '',
    idleCount > 0 ? `${idleCount} idle` : '',
  ].filter(Boolean).join(' · ');
  const prefix = `${CHARS.separator.repeat(2)} ${countLabel} `;
  const remaining = Math.max(1, usableWidth - prefix.length);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {prefix}{CHARS.separator.repeat(remaining)}
        </Text>
      </Box>
      {convs.slice(0, 5).map((session, i) => {
        const isSelected = inConvSection && i === convIdx;
        const isIdle = !!session.idle;
        const parts = session.projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
        const name = parts[parts.length - 1] || '';

        // Spinner only when Claude is actively working (has currentAction).
        // Green dot when session exists but waiting for input.
        // Dim circle when idle (no JSONL activity in 5 min).
        const isWorking = !isIdle && !!session.currentAction;
        let indicator: string;
        let indicatorColor: string;
        if (isIdle) {
          indicator = '○';
          indicatorColor = INK_COLORS.textDim;
        } else if (isWorking) {
          indicator = claudeSpinnerFrame(spinnerFrame, i) || '✶';
          indicatorColor = INK_COLORS.green;
        } else {
          indicator = '●';
          indicatorColor = INK_COLORS.green;
        }

        // Show action for active sessions, duration for idle
        let detail: string;
        if (!isIdle && session.currentAction) {
          detail = session.currentAction;
          // Strip long file paths — show only filename
          if (detail.length > 20) {
            const lastSep = Math.max(detail.lastIndexOf('/'), detail.lastIndexOf('\\'));
            if (lastSep > 0) detail = detail.slice(lastSep + 1);
          }
        } else {
          detail = formatDuration(Date.now() - session.startTime.getTime());
        }

        const tok = formatTokenCount(session.stats.tokens);
        const fixedChars = 6 + detail.length + 1 + tok.length;
        const convNameWidth = Math.max(4, Math.min(14, usableWidth - fixedChars));

        return (
          <Box key={`${session.pid}-${session.sessionId}`} paddingX={1}>
            <Text
              color={isSelected ? INK_COLORS.text : (isIdle ? INK_COLORS.textDim : INK_COLORS.text)}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {isSelected ? CHARS.pointer : ' '}{' '}
              <Text color={pulse && !isIdle ? indicatorColor : (isIdle ? INK_COLORS.textDim : indicatorColor)}>{indicator}</Text>
              {' '}{name.slice(0, convNameWidth).padEnd(convNameWidth)}{' '}
              <Text color={INK_COLORS.textDim}>{detail} </Text>
              <Text color={isIdle ? INK_COLORS.textDim : INK_COLORS.accent}>{tok}</Text>
            </Text>
          </Box>
        );
      })}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {CHARS.separator.repeat(Math.max(1, usableWidth))}
        </Text>
      </Box>
    </Box>
  );
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
  usageStats,
  skillsData,
  commandUsage,
  usageBudget,
  config,
  conversations,
  conversationIndex,
  leftSection,
}: ProjectPaneProps) {
  const rawPulse = usePulse(800);
  const pulse = config && !isFeatureEnabled(config, 'animations') ? true : rawPulse;
  // Persistent scroll offset — survives re-renders
  const scrollRef = useRef(0);
  const convs = conversations ?? [];
  const convIdx = conversationIndex ?? 0;
  const inConvSection = leftSection === 'conversations';
  // Rows used by conversations section (header + items + separator, or 0 if none)
  const convSectionRows = convs.length > 0 ? Math.min(convs.length, 5) + 2 : 0;

  // Feature flag helpers
  const feat = (key: string) => !config || isFeatureEnabled(config, key);

  // Detect separator point between pinned and discovered
  let lastPinnedIdx = -1;
  for (let i = 0; i < projects.length; i++) {
    if (projects[i].pinned) lastPinnedIdx = i;
  }

  // Subtract stats panel height when visible — count every conditional row
  const showRateBars = feat('rate_limit_bars');
  const showCalendar = feat('calendar_heatmap');
  const showCostEstimates = feat('cost_estimates');
  const showCodeStats = feat('code_stats');
  const showCommands = feat('commands_section');
  const hasStatsPanel = height >= 25 && (usageHistory || usageStats || usageBudget);
  const hasExtraWarning = showRateBars && (usageBudget?.rateLimits?.usingExtraTokens ?? false);
  const hasOverageBar = hasExtraWarning;
  // Calendar: title(1) + header(1) + ~5 week rows = 7 (shown when height >= 30)
  const calendarRows = showCalendar && usageHistory && usageHistory.length > 0 && height >= 30 ? 7 : 0;
  // Code stats line (shown conditionally inside the stats section)
  const codeStatsRow = showCodeStats ? 1 : 0;
  const statsRows = hasStatsPanel
    ? (usageBudget?.rateLimits && showRateBars
      ? 1 + calendarRows + 1 + codeStatsRow + (hasExtraWarning ? 1 : 0) + 1 + (height >= 22 ? 1 : 0) + (hasOverageBar && height >= 24 ? 1 : 0) + (height >= 20 ? 1 : 0)
      // separator(1) + calendarRows + stats(1) + codeStats(0-1) + extraWarn(0-1) + 5hBar(1) + 7dBar(0-1) + overageBar(0-1) + reset(0-1)
      : 1 + calendarRows + 1 + codeStatsRow)
      // separator(1) + calendarRows + stats(1) + codeStats(0-1)
    : 0;
  const innerBarWidth = Math.max(8, width - 6); // borders(2) + paddingX(2) + safety(2)
  // Reserve rows for commands section when visible (header + items + "+N more" + "? full list")
  const cmdCount = showCommands && skillsData ? skillsData.commands.length + skillsData.skills.length : 0;
  const cmdSectionRows = height >= 20 && cmdCount > 0
    ? Math.min(cmdCount + 3, Math.max(5, Math.floor((height - statsRows) * 0.3)))
    : 0;
  // height budget: border(2) + header(1) + scrollIndicators(up to 1) = 4 reserved
  // Scroll indicators: we show at most 1 combined indicator line to avoid overflow
  const baseViewport = Math.max(1, height - 4 - statsRows - cmdSectionRows - convSectionRows);

  // Two-pass scroll: first calculate scroll offset with baseViewport,
  // then check if the separator falls within the actual visible range.
  // The old code estimated separators using the stale scrollRef, which
  // caused mismatches when scrolling moved past the separator boundary.
  let scrollOffset = scrollRef.current;
  if (selectedIndex >= scrollOffset + baseViewport) {
    scrollOffset = selectedIndex - baseViewport + 1;
  }
  if (selectedIndex < scrollOffset) {
    scrollOffset = selectedIndex;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, projects.length - baseViewport)));

  // Now count separator rows in the actual visible range
  let extraRows = 0;
  const visibleEnd = Math.min(projects.length, scrollOffset + baseViewport);
  for (let i = scrollOffset; i < visibleEnd; i++) {
    if (i > 0 && i === lastPinnedIdx + 1 && projects[i].discovered) extraRows++;
  }
  // Reserve 1 row for scroll indicator if list is scrollable
  const needsScrollIndicator = projects.length > baseViewport - extraRows;
  const scrollReserve = needsScrollIndicator ? 1 : 0;
  const viewportHeight = Math.max(1, baseViewport - extraRows - scrollReserve);

  // Re-adjust scroll offset with the correct viewport size
  if (selectedIndex >= scrollOffset + viewportHeight) {
    scrollOffset = selectedIndex - viewportHeight + 1;
  }
  if (selectedIndex < scrollOffset) {
    scrollOffset = selectedIndex;
  }
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

      {/* Inline conversations section */}
      {convs.length > 0 && (
        <ConversationsSection
          convs={convs}
          inConvSection={inConvSection}
          convIdx={convIdx}
          usableWidth={usableWidth}
          pulse={pulse}
        />
      )}

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

        // Small indicator: ✶ for active, ○ for idle, space for none
        const isActiveSession = activeSession && !activeSession.idle;
        const sessionIndicator = activeSession
          ? (isActiveSession ? '●' : '○')
          : ' ';
        const indicatorColor = isActiveSession ? INK_COLORS.green : INK_COLORS.textDim;

        const issueBadgeLen = issueCount > 0 ? 3 : 0; // " ⚠N"
        const effectiveNameWidth = nameWidth;

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
                <Text color={indicatorColor}>{sessionIndicator}</Text>{' '}
                {project.name.slice(0, effectiveNameWidth).padEnd(effectiveNameWidth)}{' '}
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

      {/* Scroll indicator — single line to avoid overflow */}
      {(hasAbove || hasBelow) && (
        <Box paddingX={1}>
          <Text color={INK_COLORS.textDim}>
            {hasAbove ? `${CHARS.arrow_up} ${scrollOffset} above` : ''}
            {hasAbove && hasBelow ? '  ' : ''}
            {hasBelow ? `${CHARS.arrow_down} ${projects.length - scrollOffset - viewportHeight} below` : ''}
          </Text>
        </Box>
      )}

      {/* Commands summary */}
      {showCommands && height >= 20 && skillsData && (skillsData.commands.length + skillsData.skills.length) > 0 && (() => {
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
              {CHARS.separator.repeat(3)} Commands {CHARS.separator.repeat(Math.max(1, innerWidth - 13))}
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

      {/* Bottom stats panel — order: stats, sparkline+agents, 5h/7d bars, calendar */}
      {height >= 25 && (usageHistory || usageStats || usageBudget) && (
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text color={INK_COLORS.accent}>
              {CHARS.separator.repeat(2)} Usage {CHARS.separator.repeat(Math.max(1, usableWidth - 10))}
            </Text>
          </Box>

          {/* Session stats line */}
          {usageStats && height >= 18 && (() => {
            const today = new Date().toISOString().slice(0, 10);
            const todayData = usageHistory?.find(d => d.date === today);
            const hasCode = showCodeStats && todayData && ((todayData.additions ?? 0) > 0 || (todayData.deletions ?? 0) > 0);
            const dailyCost = showCostEstimates && isCostRelevant() && usageStats.tokens > 0 ? formatCost(estimateCostBlended(usageStats.tokens)) : '';

            return (
              <Box paddingX={1} flexDirection="column">
                <Text color={INK_COLORS.textDim}>
                  {(() => {
                    let line = `${usageStats.messages} msgs ${CHARS.bullet} ${formatTokenCount(usageStats.tokens)} tok`;
                    if (dailyCost) line += ` ${CHARS.bullet} ~${dailyCost}`;
                    if (usageBudget?.tierLabel) line += ` ${CHARS.bullet} ${usageBudget.tierLabel}`;
                    return line.slice(0, usableWidth);
                  })()}
                </Text>
                {hasCode && (
                  <Text>
                    <Text color={INK_COLORS.green}>+{todayData!.additions}</Text>
                    <Text color={INK_COLORS.red}> -{todayData!.deletions}</Text>
                    <Text color={INK_COLORS.textDim}> lines today</Text>
                  </Text>
                )}
              </Box>
            );
          })()}

          {/* Scrolling hourly sparkline + braille agent overlay */}
          {convs.length > 0 && height >= 22 && (() => {
            // Aggregate hourly data across all sessions
            const hourly = new Array(24).fill(0);
            const agentHourly = new Array(24).fill(0);
            for (const s of convs) {
              if (s.stats.hourlyActivity) {
                for (let h = 0; h < 24; h++) hourly[h] += s.stats.hourlyActivity[h];
              }
              if (s.stats.agentSpawns > 0 && s.stats.hourlyActivity) {
                const active = s.stats.hourlyActivity.map((v, h) => ({ v, h })).filter(x => x.v > 0);
                const total = active.reduce((sum, x) => sum + x.v, 0);
                if (total > 0) {
                  for (const { v, h } of active) {
                    agentHourly[h] += (s.stats.agentSpawns * v) / total;
                  }
                }
              }
            }
            if (hourly.every(v => v === 0)) return null;

            // Right-align with progress bars: ProgressBar uses labelLen(3) + bar + " 100%"(5)
            // Sparkline uses "hr "(3) + sparkline + " now"(4). To right-align the
            // trailing edge, sparkline width = innerBarWidth - 3 (label) - 4 (suffix)
            // ProgressBar bar width = innerBarWidth - 3 (label) - 5 (pct) → ends 1 char earlier
            // So " now" aligns with "100%" right edge
            const sparkWidth = Math.max(8, innerBarWidth - 3 - 4);
            const currentHour = new Date().getHours();

            // Scrolling window: rightmost = current hour
            const windowSize = Math.min(24, sparkWidth);
            const windowHourly: number[] = [];
            const windowAgents: number[] = [];
            for (let i = 0; i < windowSize; i++) {
              const h = (currentHour - windowSize + 1 + i + 24) % 24;
              windowHourly.push(hourly[h]);
              windowAgents.push(agentHourly[h]);
            }

            const maxVal = Math.max(...windowHourly, 1);
            const maxAgent = Math.max(...windowAgents);
            const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
            const BRAILLE = ['⠀', '⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣿'];
            // Green gradient matching calendar heatmap (dark → bright by level)
            const SPARK_COLORS = ['#161b22', '#0e4429', '#0e4429', '#006d32', '#006d32', '#26a641', '#26a641', '#39d353'];
            const hasAgents = maxAgent > 0;

            return (
              <Box paddingX={1} flexDirection="column">
                <Box>
                  <Text color={INK_COLORS.textDim}>hr </Text>
                  <Text>
                    {windowHourly.map((v, i) => {
                      const level = v === 0 ? 0 : Math.min(7, Math.floor((v / maxVal) * 7));
                      const isNow = i === windowSize - 1;
                      const color = isNow ? (pulse ? INK_COLORS.accent : SPARK_COLORS[level])
                        : SPARK_COLORS[level];
                      return <Text key={i} color={color}>{BLOCKS[level]}</Text>;
                    })}
                  </Text>
                  <Text color={INK_COLORS.textDim}> now</Text>
                </Box>
                {hasAgents && (
                  <Box>
                    <Text color={INK_COLORS.textDim}>{'   '}</Text>
                    <Text>
                      {windowAgents.map((v, i) => {
                        if (v === 0) return <Text key={i} color="#161b22">{BRAILLE[0]}</Text>;
                        const level = Math.min(7, Math.floor((v / maxAgent) * 7));
                        const isNow = i === windowSize - 1;
                        return <Text key={i} color={isNow && pulse ? INK_COLORS.accent : '#e87632'}>{BRAILLE[level]}</Text>;
                      })}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })()}

          {/* Extra tokens warning */}
          {showRateBars && usageBudget?.rateLimits?.usingExtraTokens && (
            <Box paddingX={1}>
              <Text color={INK_COLORS.yellow}>
                {CHARS.warning} Using extra tokens (paid)
              </Text>
            </Box>
          )}

          {/* 5-hour usage bar */}
          {showRateBars && usageBudget?.rateLimits && (
            <Box paddingX={1}>
              <ProgressBar
                percent={usageBudget.rateLimits.fiveHourPercent}
                width={Math.max(8, innerBarWidth)}
                label="5h"
              />
            </Box>
          )}
          {/* Fallback: estimated budget bar (when no live data) */}
          {showRateBars && usageBudget && !usageBudget.rateLimits && usageBudget.limit > 0 && usageStats && (
            <Box paddingX={1}>
              <ProgressBar
                percent={usageBudget.percent}
                width={Math.max(8, innerBarWidth)}
                label={usageBudget.tierLabel || 'Budget'}
              />
            </Box>
          )}

          {/* 7-day usage bar */}
          {showRateBars && usageBudget?.rateLimits && height >= 18 && (
            <Box paddingX={1}>
              <ProgressBar
                percent={usageBudget.rateLimits.sevenDayPercent}
                width={Math.max(8, innerBarWidth)}
                label="7d"
              />
            </Box>
          )}

          {/* Extra tokens (overage) bar */}
          {showRateBars && usageBudget?.rateLimits?.usingExtraTokens && height >= 24 && (
            <Box paddingX={1}>
              <ProgressBar
                percent={usageBudget.rateLimits.overagePercent}
                width={Math.max(8, innerBarWidth)}
                label="Extra"
              />
            </Box>
          )}

          {/* Reset times */}
          {showRateBars && usageBudget?.rateLimits && height >= 20 && (
            <Box paddingX={1}>
              <Text color={INK_COLORS.textDim}>
                resets {usageBudget.rateLimits.fiveHourResetIn}
                {usageBudget.rateLimits.overageEnabled && usageBudget.rateLimits.overageResetIn
                  ? ` ${CHARS.bullet} extra resets ${usageBudget.rateLimits.overageResetIn}`
                  : ''}
              </Text>
            </Box>
          )}

          {/* Calendar heatmap — at the bottom for long-term context */}
          {showCalendar && usageHistory && usageHistory.length > 0 && height >= 30 && (
            <Box paddingX={1}>
              <CalendarHeatmap
                title="History"
                titleColor={INK_COLORS.green}
                data={usageHistory}
                width={Math.max(8, width - 4)}
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
});
