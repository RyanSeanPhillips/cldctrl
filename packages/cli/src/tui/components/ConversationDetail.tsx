/**
 * Right pane for conversations mode: overview (all conversations) or
 * expanded (single conversation deep dive with token breakdown).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatTokenCount } from '../../core/sessions.js';
import { estimateCostBlended, formatCost, isCostRelevant } from '../../core/pricing.js';
import { INK_COLORS, CHARS, formatDuration } from '../../constants.js';
import { ActivitySparkline } from './ActivitySparkline.js';
import type { ActiveSession, UsageBudget } from '../../types.js';
import type { SessionTasks } from '../hooks/useBackgroundData.js';

// Distinct colors for stacked bars (one per conversation, up to 6)
const CONV_COLORS = [
  INK_COLORS.green,
  INK_COLORS.blue,
  INK_COLORS.accent,
  INK_COLORS.yellow,
  '#c084fc', // purple
  '#f472b6', // pink
];

const CONV_CHARS = ['█', '▓', '▒', '░', '▞', '▚'];

interface ConversationDetailProps {
  conversations: ActiveSession[];
  selectedIndex: number;
  expanded: boolean;
  width: number;
  height: number;
  usageBudget?: UsageBudget | null;
  sessionTasks?: SessionTasks | null;
}

/** Extract short project name from path */
function projectName(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

/** Compute context health indicator */
function contextHealth(session: ActiveSession): { icon: string; color: string; label: string } {
  const ipm = session.stats.inputPerMessage;
  const msgs = session.stats.messages;
  if (msgs < 10 || ipm.length < 5) {
    return { icon: CHARS.check, color: INK_COLORS.green, label: `${msgs} msgs ${CHARS.bullet} healthy` };
  }
  const first5Avg = ipm.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
  const last5Avg = ipm.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const growthPerMsg = ipm.length > 1 ? (last5Avg - first5Avg) / ipm.length : 0;

  if (msgs > 30 && growthPerMsg > 5000) {
    return { icon: CHARS.warning, color: INK_COLORS.red, label: `${msgs} msgs ${CHARS.bullet} bloated — start new session` };
  }
  if (msgs > 15 && growthPerMsg > 2000) {
    return { icon: CHARS.warning, color: INK_COLORS.yellow, label: `${msgs} msgs ${CHARS.bullet} input growing ~${formatTokenCount(Math.round(growthPerMsg))}/msg` };
  }
  return { icon: CHARS.check, color: INK_COLORS.green, label: `${msgs} msgs ${CHARS.bullet} healthy` };
}

/**
 * Detect context compactions from inputPerMessage drops.
 * A >50% drop in input tokens between consecutive messages indicates
 * the conversation was summarized/compacted.
 */
function countCompactions(ipm: number[]): number {
  let count = 0;
  for (let i = 1; i < ipm.length; i++) {
    if (ipm[i - 1] > 5000 && ipm[i] < ipm[i - 1] * 0.5) count++;
  }
  return count;
}

/** Classify session type from tool usage patterns */
function classifySessionType(stats: ActiveSession['stats']): { type: string; icon: string; color: string } {
  const totalTools = stats.toolCalls.reads + stats.toolCalls.writes + stats.toolCalls.bash + stats.toolCalls.other;
  if (totalTools < 3 && stats.messages > 0) {
    return { type: 'planning', icon: '📋', color: INK_COLORS.blue };
  }
  if (totalTools === 0) {
    return { type: 'idle', icon: '○', color: INK_COLORS.textDim };
  }
  const writePct = stats.toolCalls.writes / totalTools;
  const bashPct = stats.toolCalls.bash / totalTools;
  const readPct = stats.toolCalls.reads / totalTools;
  if (writePct > 0.3 || bashPct > 0.2) {
    return { type: 'implementation', icon: CHARS.check, color: INK_COLORS.green };
  }
  if (readPct > 0.6 && writePct < 0.15) {
    return { type: 'research', icon: '?', color: INK_COLORS.accent };
  }
  return { type: 'mixed', icon: CHARS.bullet, color: INK_COLORS.textDim };
}

/** Render a horizontal bar proportional to value/max */
function tokenBar(value: number, max: number, width: number): string {
  if (max === 0) return '';
  const filled = Math.max(0, Math.round((value / max) * width));
  return '\u2588'.repeat(filled);
}

/**
 * Build a 5-hour usage timeline: for each of the last 5 hours,
 * compute per-conversation token estimates from hourlyActivity.
 *
 * hourlyActivity[h] = message count at hour h (0-23).
 * We distribute each conversation's total tokens proportionally to messages per hour.
 */
function buildTimeline(conversations: ActiveSession[]): {
  hours: number[];       // 5 hour labels (0-23)
  labels: string[];      // formatted hour labels like "2pm"
  /** hourData[h][convIdx] = estimated tokens for conversation convIdx in hour h */
  hourData: number[][];
  maxHourTotal: number;  // max total tokens in any single hour (for scaling)
} {
  const now = new Date();
  const currentHour = now.getHours();
  // 5-hour window: current hour and 4 previous
  const hours: number[] = [];
  for (let i = 4; i >= 0; i--) {
    hours.push((currentHour - i + 24) % 24);
  }
  const labels = hours.map(h => {
    const hr12 = h % 12 || 12;
    return `${hr12}${h < 12 ? 'a' : 'p'}`;
  });

  const hourData: number[][] = hours.map(() => new Array(conversations.length).fill(0));

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const totalMsgs = conv.stats.hourlyActivity.reduce((s, v) => s + v, 0);
    if (totalMsgs === 0) continue;
    const tokensPerMsg = conv.stats.tokens / totalMsgs;

    for (let hi = 0; hi < hours.length; hi++) {
      const h = hours[hi];
      const msgsInHour = conv.stats.hourlyActivity[h] || 0;
      hourData[hi][ci] = Math.round(msgsInHour * tokensPerMsg);
    }
  }

  let maxHourTotal = 0;
  for (const row of hourData) {
    const total = row.reduce((s, v) => s + v, 0);
    if (total > maxHourTotal) maxHourTotal = total;
  }

  return { hours, labels, hourData, maxHourTotal };
}

/** Overview mode: comparative table + usage timeline + context health */
function Overview({ conversations, width, height, usageBudget }: {
  conversations: ActiveSession[];
  width: number;
  height: number;
  usageBudget?: UsageBudget | null;
}) {
  const sorted = [...conversations].sort((a, b) => b.stats.tokens - a.stats.tokens);
  const totalTokens = sorted.reduce((sum, s) => sum + s.stats.tokens, 0);
  const innerWidth = Math.max(20, width - 4);
  const nameW = Math.max(6, Math.min(14, innerWidth - 45));
  const barW = Math.max(4, innerWidth - nameW - 41);
  const maxTokens = sorted.length > 0 ? sorted[0].stats.tokens : 1;

  // Usage timeline
  const timeline = buildTimeline(sorted);
  const timelineBarW = Math.max(8, Math.min(30, innerWidth - 10));

  // Rate limit context
  const fiveHourPct = usageBudget?.rateLimits?.fiveHourPercent;
  const hasRateLimits = fiveHourPct != null;

  // Strict height budget: header(1) + separator(1) + colHeaders(1) + timeline separator+header(3) + 5 timeline rows(5) + hints(1) = 12 fixed
  const fixedOverviewRows = 12;
  const remainingRows = Math.max(0, height - fixedOverviewRows);
  // Split remaining between conversation rows, context health, and health header(2)
  const showConvCount = Math.min(sorted.length, Math.max(1, Math.ceil(remainingRows * 0.5)));
  const healthBudget = Math.max(0, remainingRows - showConvCount - 2);
  const showHealth = healthBudget >= 2;
  const showHealthCount = Math.min(sorted.length, Math.max(0, healthBudget - 1));

  return (
    <Box flexDirection="column" height={height} paddingX={1}>
      {/* Header */}
      <Text bold color={INK_COLORS.accent}>
        Live Conversations {CHARS.bullet} {sorted.length} active {CHARS.bullet} {formatTokenCount(totalTokens)} total
        {hasRateLimits ? ` ${CHARS.bullet} 5h: ${Math.round(fiveHourPct!)}%` : ''}
      </Text>
      <Text color={INK_COLORS.textDim}>
        {CHARS.separator.repeat(Math.max(1, innerWidth))}
      </Text>

      {/* Per-conversation contribution table */}
      <Text>
        <Text color={INK_COLORS.textDim}>{''.padEnd(nameW + 2)}</Text>
        <Text color={INK_COLORS.textDim}>{'Tokens'.padStart(8)}</Text>
        <Text color={INK_COLORS.textDim}>{'Share'.padStart(7)}</Text>
        <Text color={INK_COLORS.textDim}>{'Msgs'.padStart(6)}</Text>
        <Text color={INK_COLORS.textDim}>{'T/R'.padStart(5)}</Text>
        <Text color={INK_COLORS.textDim}>{'Dur'.padStart(6)}</Text>
      </Text>
      {sorted.slice(0, showConvCount).map((session, ci) => {
        const name = projectName(session.projectPath);
        const share = totalTokens > 0 ? Math.round((session.stats.tokens / totalTokens) * 100) : 0;
        const dur = formatDuration(Date.now() - session.startTime.getTime());
        const turnsPerReq = session.stats.messages > 0
          ? (session.stats.assistantTurns / session.stats.messages).toFixed(1)
          : '-';
        const bar = tokenBar(session.stats.tokens, maxTokens, Math.max(2, barW));
        const color = CONV_COLORS[ci % CONV_COLORS.length];

        return (
          <Text key={session.projectPath}>
            <Text color={color}>{CONV_CHARS[ci % CONV_CHARS.length]}</Text>
            <Text color={INK_COLORS.text}>{' '}{name.slice(0, nameW - 1).padEnd(nameW - 1)}</Text>
            {'  '}
            <Text color={INK_COLORS.accent}>{formatTokenCount(session.stats.tokens).padStart(8)}</Text>
            <Text color={INK_COLORS.textDim}>{`${share}%`.padStart(7)}</Text>
            <Text color={INK_COLORS.textDim}>{String(session.stats.messages).padStart(6)}</Text>
            <Text color={session.stats.assistantTurns / Math.max(1, session.stats.messages) > 5 ? INK_COLORS.yellow : INK_COLORS.textDim}>{turnsPerReq.padStart(5)}</Text>
            <Text color={INK_COLORS.textDim}>{dur.padStart(6)}</Text>
            {' '}
            <Text color={color}>{bar}</Text>
          </Text>
        );
      })}

      {/* 5-Hour Usage Timeline */}
      <Box marginTop={1}>
        <Text color={INK_COLORS.textDim}>
          {CHARS.separator.repeat(Math.max(1, innerWidth))}
        </Text>
      </Box>
      <Text bold color={INK_COLORS.text}>
        5-Hour Usage Timeline
        {usageBudget?.rateLimits?.fiveHourResetIn ? ` (resets ${usageBudget.rateLimits.fiveHourResetIn})` : ''}
      </Text>

      {timeline.hours.map((h, hi) => {
        const hourTotals = timeline.hourData[hi];
        const hourTotal = hourTotals.reduce((s, v) => s + v, 0);
        if (timeline.maxHourTotal === 0) {
          return (
            <Text key={h}>
              <Text color={INK_COLORS.textDim}>{timeline.labels[hi].padStart(4)} </Text>
              <Text color={INK_COLORS.textDim}>{'▁'.repeat(timelineBarW)}</Text>
            </Text>
          );
        }

        // Build stacked bar: each conversation gets proportional chars
        const segments: Array<{ char: string; color: string; count: number }> = [];
        let totalChars = 0;
        for (let ci = 0; ci < hourTotals.length && ci < sorted.length; ci++) {
          const chars = Math.round((hourTotals[ci] / timeline.maxHourTotal) * timelineBarW);
          if (chars > 0) {
            segments.push({
              char: CONV_CHARS[ci % CONV_CHARS.length],
              color: CONV_COLORS[ci % CONV_COLORS.length],
              count: chars,
            });
            totalChars += chars;
          }
        }
        // Fill remaining with empty
        const empty = Math.max(0, timelineBarW - totalChars);

        return (
          <Text key={h}>
            <Text color={INK_COLORS.textDim}>{timeline.labels[hi].padStart(4)} </Text>
            {segments.map((seg, si) => (
              <Text key={si} color={seg.color}>{seg.char.repeat(seg.count)}</Text>
            ))}
            {empty > 0 && <Text color={INK_COLORS.textDim}>{'▁'.repeat(empty)}</Text>}
            {hourTotal > 0 && <Text color={INK_COLORS.textDim}> {formatTokenCount(hourTotal)}</Text>}
          </Text>
        );
      })}

      {/* Context health */}
      {showHealth && (
        <>
          <Box marginTop={1}>
            <Text color={INK_COLORS.textDim}>
              {CHARS.separator.repeat(Math.max(1, innerWidth))}
            </Text>
          </Box>
          <Text bold color={INK_COLORS.text}>Context Health</Text>
          {sorted.slice(0, showHealthCount).map((session, ci) => {
            const name = projectName(session.projectPath);
            const health = contextHealth(session);
            const sType = classifySessionType(session.stats);
            const compactions = countCompactions(session.stats.inputPerMessage);
            const isIdle = session.tracked && session.idle;
            const color = CONV_COLORS[ci % CONV_COLORS.length];
            if (isIdle) {
              const idleDur = formatDuration(Date.now() - session.lastActivity.getTime());
              return (
                <Text key={session.projectPath}>
                  {'  '}<Text color={color}>{CONV_CHARS[ci % CONV_CHARS.length]}</Text>
                  {' '}<Text color={INK_COLORS.text}>{name.slice(0, nameW).padEnd(nameW)}</Text>
                  {'  '}<Text color={INK_COLORS.yellow}>{'○'} idle {idleDur}</Text>
                  {'  '}<Text color={sType.color}>{sType.type}</Text>
                </Text>
              );
            }
            return (
              <Text key={session.projectPath}>
                {'  '}<Text color={color}>{CONV_CHARS[ci % CONV_CHARS.length]}</Text>
                {' '}<Text color={INK_COLORS.text}>{name.slice(0, nameW).padEnd(nameW)}</Text>
                {'  '}<Text color={health.color}>{health.icon} {health.label}</Text>
                {'  '}<Text color={sType.color}>{sType.type}</Text>
                {compactions > 0 && <Text color={INK_COLORS.yellow}> {compactions} compaction{compactions > 1 ? 's' : ''}</Text>}
              </Text>
            );
          })}
        </>
      )}

      {/* Hints */}
      <Box marginTop={1}>
        <Text color={INK_COLORS.textDim}>
          j/k:navigate  Tab/→:expand  Enter:focus window  Esc:projects
        </Text>
      </Box>
    </Box>
  );
}

/** Expanded mode: single conversation deep dive */
function Expanded({ session, width, height, sessionTasks }: { session: ActiveSession; width: number; height: number; sessionTasks?: SessionTasks | null }) {
  const name = projectName(session.projectPath);
  const isIdle = session.tracked && session.idle;
  const dur = formatDuration(Date.now() - session.startTime.getTime());
  const bd = session.stats.tokenBreakdown;
  const total = session.stats.tokens;
  const innerWidth = Math.max(20, width - 4);
  const barWidth = Math.max(4, innerWidth - 30);
  const health = contextHealth(session);

  // Token type percentages
  const pct = (v: number) => total > 0 ? Math.round((v / total) * 100) : 0;

  // Primary model
  const models = Object.entries(session.stats.models);
  const primaryModel = models.length > 0
    ? models.sort((a, b) => b[1] - a[1])[0]
    : null;

  // Cost estimate
  const costStr = isCostRelevant() && total > 0 ? ` ${CHARS.bullet} ~${formatCost(estimateCostBlended(total))}` : '';

  // Session classification
  const sType = classifySessionType(session.stats);
  const compactions = countCompactions(session.stats.inputPerMessage);

  // Tasks/todos
  const hasTasks = sessionTasks && (sessionTasks.todos.length > 0 || sessionTasks.tasks.length > 0);
  const totalTodos = sessionTasks?.todos.length ?? 0;
  const completedTodos = sessionTasks?.todos.filter(t => t.status === 'completed').length ?? 0;
  const totalTaskItems = sessionTasks?.tasks.length ?? 0;
  const completedTaskItems = sessionTasks?.tasks.filter(t => t.status === 'completed').length ?? 0;

  // Height budget: gate optional sections to prevent overflow
  // Fixed: header(1) + separator(1) + info(1) + efficiency(1) + marginTop(1) + breakdown header(1) + 5 token lines + total(1) + marginTop(1) + tool header(1) + tool stats(1) + agent line(1) + marginTop(1) + hints(1) = 18
  const fixedRows = 18;
  const remainingRows = Math.max(0, height - fixedRows);
  const hasContextGrowth = session.stats.inputPerMessage.length > 2;
  const hasActivity = session.stats.hourlyActivity.some(v => v > 0);
  const hasRounds = session.roundSummaries && session.roundSummaries.length > 0;
  const showContextGrowth = hasContextGrowth && remainingRows >= 3;
  const contextRows = showContextGrowth ? 4 : 0;
  const showActivity = hasActivity && (remainingRows - contextRows) >= 3;
  const activityRows = showActivity ? 3 : 0;
  const showTasks = hasTasks && (remainingRows - contextRows - activityRows) >= 3;
  const taskRows = showTasks ? Math.min(7, 2 + (totalTodos > 0 ? Math.min(5, totalTodos) : Math.min(5, totalTaskItems))) : 0;
  const roundBudget = Math.max(0, remainingRows - contextRows - activityRows - taskRows);
  const showRounds = hasRounds && roundBudget >= 2;
  const maxRoundLines = Math.min(5, roundBudget - 1);

  return (
    <Box flexDirection="column" height={height} paddingX={1}>
      {/* Header */}
      <Text>
        <Text bold color={INK_COLORS.accent}>{name}</Text>
        {' '}
        <Text color={isIdle ? INK_COLORS.yellow : INK_COLORS.green}>
          {isIdle ? '○ idle' : '● active'}
        </Text>
        {' '}
        <Text color={INK_COLORS.textDim}>{dur}{costStr}</Text>
        {' '}
        <Text color={sType.color}>[{sType.type}]</Text>
        {compactions > 0 && (
          <Text color={INK_COLORS.yellow}> {compactions} compaction{compactions > 1 ? 's' : ''}</Text>
        )}
      </Text>
      <Text color={INK_COLORS.textDim}>
        {CHARS.separator.repeat(Math.max(1, innerWidth))}
      </Text>

      {/* Session info */}
      <Text color={INK_COLORS.textDim}>
        PID {session.pid}
        {primaryModel ? ` ${CHARS.bullet} ${primaryModel[0]} (${session.stats.messages} msgs)` : ` ${CHARS.bullet} ${session.stats.messages} msgs`}
        {session.stats.assistantTurns > 0 && ` ${CHARS.bullet} ${session.stats.assistantTurns} turns`}
      </Text>
      {session.stats.messages > 0 && (
        <Text color={INK_COLORS.textDim}>
          {'  '}
          <Text color={INK_COLORS.text}>{(session.stats.assistantTurns / session.stats.messages).toFixed(1)}</Text>
          {' turns/request'}
          {session.stats.assistantTurns > 0 && (
            <>
              {'  '}
              <Text color={INK_COLORS.accent}>{Math.round((session.stats.toolUseTurns / session.stats.assistantTurns) * 100)}%</Text>
              {' use tools'}
            </>
          )}
          {session.stats.agentSpawns > 0 && (
            <>
              {'  '}
              <Text color={INK_COLORS.blue}>{session.stats.agentSpawns}</Text>
              {' agents'}
            </>
          )}
        </Text>
      )}

      {/* Token Breakdown */}
      <Box marginTop={1}><Text bold color={INK_COLORS.text}>Token Breakdown</Text></Box>
      <Text>
        {'  Input:    '}<Text color={INK_COLORS.text}>{formatTokenCount(bd.input).padStart(10)}</Text>
        <Text color={INK_COLORS.textDim}>{` (${pct(bd.input).toString().padStart(2)}%) `}</Text>
        <Text color={INK_COLORS.blue}>{tokenBar(bd.input, total, barWidth)}</Text>
      </Text>
      <Text>
        {'  Output:   '}<Text color={INK_COLORS.text}>{formatTokenCount(bd.output).padStart(10)}</Text>
        <Text color={INK_COLORS.textDim}>{` (${pct(bd.output).toString().padStart(2)}%) `}</Text>
        <Text color={INK_COLORS.green}>{tokenBar(bd.output, total, barWidth)}</Text>
      </Text>
      <Text>
        {'  Cache R:  '}<Text color={INK_COLORS.text}>{formatTokenCount(bd.cacheRead).padStart(10)}</Text>
        <Text color={INK_COLORS.textDim}>{` (${pct(bd.cacheRead).toString().padStart(2)}%) `}</Text>
        <Text color={INK_COLORS.accent}>{tokenBar(bd.cacheRead, total, barWidth)}</Text>
      </Text>
      <Text>
        {'  Cache W:  '}<Text color={INK_COLORS.text}>{formatTokenCount(bd.cacheWrite).padStart(10)}</Text>
        <Text color={INK_COLORS.textDim}>{` (${pct(bd.cacheWrite).toString().padStart(2)}%) `}</Text>
        <Text color={INK_COLORS.yellow}>{tokenBar(bd.cacheWrite, total, barWidth)}</Text>
      </Text>
      <Text>
        {'  Total:    '}<Text bold color={INK_COLORS.accent}>{formatTokenCount(total).padStart(10)}</Text>
      </Text>

      {/* Context Growth */}
      {showContextGrowth && (
        <>
          <Box marginTop={1}><Text bold color={INK_COLORS.text}>Context Growth</Text></Box>
          <Text>{'  '}<ActivitySparkline values={session.stats.inputPerMessage} width={Math.min(40, innerWidth - 4)} highlightPeak /></Text>
          <Text>
            {'  '}<Text color={health.color}>{health.icon} {health.label}</Text>
          </Text>
          {session.stats.inputPerMessage.length > 5 && (() => {
            const first = session.stats.inputPerMessage[0];
            const last = session.stats.inputPerMessage[session.stats.inputPerMessage.length - 1];
            const overhead = session.stats.inputPerMessage.reduce((s, v) => s + Math.max(0, v - first), 0);
            if (overhead > 10000) {
              return (
                <Text color={INK_COLORS.textDim}>
                  {'  '}Input grew {formatTokenCount(first)} → {formatTokenCount(last)}/msg
                  {overhead > 50000 ? ` ${CHARS.bullet} ~${formatTokenCount(overhead)} overhead` : ''}
                </Text>
              );
            }
            return null;
          })()}
        </>
      )}

      {/* Hourly Activity */}
      {showActivity && (
        <>
          <Box marginTop={1}><Text bold color={INK_COLORS.text}>Activity</Text></Box>
          <Text>{'  '}<ActivitySparkline values={session.stats.hourlyActivity} width={Math.min(24, innerWidth - 4)} highlightPeak /></Text>
        </>
      )}

      {/* Tool Usage */}
      <Box marginTop={1}><Text bold color={INK_COLORS.text}>Tool Usage</Text></Box>
      <Text>
        {'  '}<Text color={INK_COLORS.blue}>Reads: {session.stats.toolCalls.reads}</Text>
        {'  '}<Text color={INK_COLORS.green}>Writes: {session.stats.toolCalls.writes}</Text>
        {'  '}<Text color={INK_COLORS.yellow}>Bash: {session.stats.toolCalls.bash}</Text>
        {session.stats.toolCalls.other > 0 && <Text color={INK_COLORS.textDim}>  Other: {session.stats.toolCalls.other}</Text>}
      </Text>
      {session.stats.agentSpawns > 0 && (
        <Text color={INK_COLORS.textDim}>
          {'  '}<Text color={INK_COLORS.accent}>Agents: {session.stats.agentSpawns}</Text>
          {' spawned '}
          ({session.stats.messages > 0
            ? `${(session.stats.agentSpawns / session.stats.messages * 100).toFixed(0)}% of requests`
            : 'no requests'})
        </Text>
      )}

      {/* Tasks/Todos */}
      {showTasks && sessionTasks && (
        <>
          <Box marginTop={1}><Text bold color={INK_COLORS.text}>
            {totalTodos > 0
              ? `Todos (${completedTodos}/${totalTodos} done)`
              : `Tasks (${completedTaskItems}/${totalTaskItems} completed)`}
          </Text></Box>
          {totalTodos > 0 ? (
            // Prioritize in_progress (active) items, show up to 5
            <>
              {[...sessionTasks.todos]
                .sort((a, b) => (a.activeForm ? -1 : 0) - (b.activeForm ? -1 : 0))
                .slice(0, Math.min(5, taskRows - 2))
                .map((todo, i) => {
                  const icon = todo.status === 'completed' ? CHARS.check : (todo.activeForm ? CHARS.pointer : '\u25CB');
                  const color = todo.status === 'completed' ? INK_COLORS.green : (todo.activeForm ? INK_COLORS.accent : INK_COLORS.textDim);
                  return (
                    <Text key={i} color={color}>
                      {'  '}{icon} {todo.activeForm || todo.content.slice(0, innerWidth - 8)}
                    </Text>
                  );
                })}
            </>
          ) : (
            <>
              {sessionTasks.tasks
                .slice(0, Math.min(5, taskRows - 2))
                .map((task) => {
                  const icon = task.status === 'completed' ? CHARS.check
                    : task.status === 'in_progress' ? CHARS.pointer
                    : '\u25CB';
                  const color = task.status === 'completed' ? INK_COLORS.green
                    : task.status === 'in_progress' ? INK_COLORS.blue
                    : INK_COLORS.textDim;
                  return (
                    <Text key={task.id} color={color}>
                      {'  '}{icon} {task.activeForm || task.subject.slice(0, innerWidth - 8)}
                    </Text>
                  );
                })}
            </>
          )}
        </>
      )}

      {/* Round Summaries */}
      {showRounds && (
        <>
          <Box marginTop={1}><Text bold color={INK_COLORS.text}>Recent Rounds</Text></Box>
          {session.roundSummaries!.slice(-maxRoundLines).map((summary, i) => (
            <Text key={i} color={INK_COLORS.textDim}>
              {'  '}{CHARS.bullet} {summary.slice(0, innerWidth - 6)}
            </Text>
          ))}
        </>
      )}

      {/* Hints */}
      <Box marginTop={1}>
        <Text color={INK_COLORS.textDim}>
          Enter: focus window  Esc: overview  l: projects
        </Text>
      </Box>
    </Box>
  );
}

export const ConversationDetail = React.memo(function ConversationDetail({
  conversations,
  selectedIndex,
  expanded,
  width,
  height,
  usageBudget,
  sessionTasks,
}: ConversationDetailProps) {
  const sorted = [...conversations].sort((a, b) => b.stats.tokens - a.stats.tokens);
  const selected = sorted[selectedIndex];

  if (expanded && selected) {
    return <Expanded session={selected} width={width} height={height} sessionTasks={sessionTasks} />;
  }

  if (sorted.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={INK_COLORS.textDim}>No active conversations to analyze.</Text>
        <Text color={INK_COLORS.textDim}>Launch a project to see live stats here.</Text>
      </Box>
    );
  }

  return <Overview conversations={sorted} width={width} height={height} usageBudget={usageBudget} />;
});
