/**
 * Full-screen `?` help overlay with scrollable list and detail pane.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { INK_COLORS, VERSION } from '../../constants.js';
import { buildHelpItems, navigableToFlat } from '../helpItems.js';
import type { SkillsData } from '../helpItems.js';
import type { CommandUsageCounts } from '../../core/command-usage.js';

interface HelpOverlayProps {
  width: number;
  height: number;
  helpIndex: number;
  skillsData?: SkillsData;
  commandUsage?: CommandUsageCounts;
}

/** Get the color for a command source */
function sourceColor(source: string): string {
  switch (source) {
    case 'user': return INK_COLORS.accent;
    case 'project': return INK_COLORS.green;
    case 'plugin': return INK_COLORS.blue;
    default: return INK_COLORS.text;
  }
}

export const HelpOverlay = React.memo(function HelpOverlay({
  width,
  height,
  helpIndex,
  skillsData,
  commandUsage,
}: HelpOverlayProps) {
  const { items, navigableCount } = useMemo(
    () => buildHelpItems(skillsData, commandUsage),
    [skillsData, commandUsage],
  );

  // Clamp helpIndex
  const safeIndex = Math.max(0, Math.min(helpIndex, navigableCount - 1));
  const selectedFlatIndex = navigableToFlat(items, safeIndex);

  // Layout: header (2 lines) + separator (1) + list + separator (1) + detail (3) + nav hint (1)
  const detailHeight = 3;
  const chromeHeight = 2 + 1 + 1 + detailHeight + 1; // header + sep + sep + detail + hints
  const listHeight = Math.max(1, height - chromeHeight);

  // Viewport scrolling: keep selected item visible
  const scrollOffset = useMemo(() => {
    // We need to figure out how many flat rows are above selectedFlatIndex
    // and ensure the selected row is in the visible viewport
    let offset = 0;
    if (selectedFlatIndex >= listHeight) {
      offset = selectedFlatIndex - listHeight + 1;
    }
    return Math.max(0, offset);
  }, [selectedFlatIndex, listHeight]);

  const visibleItems = items.slice(scrollOffset, scrollOffset + listHeight);

  // Build detail text for selected item
  const selectedItem = items[selectedFlatIndex];
  const detailLines = useMemo((): [string, string] => {
    if (!selectedItem) return ['', ''];
    switch (selectedItem.kind) {
      case 'shortcut':
        return [selectedItem.key.trim(), selectedItem.desc];
      case 'command': {
        const { cmd, uses } = selectedItem;
        const src = cmd.pluginName ? `${cmd.source} (${cmd.pluginName})` : cmd.source;
        const useTxt = uses > 0 ? ` · ${uses} uses` : '';
        return [`/${cmd.name} · ${src}${useTxt}`, cmd.description];
      }
      case 'skill': {
        const { skill } = selectedItem;
        return [`${skill.name} · plugin (${skill.pluginName})`, skill.description];
      }
      default:
        return ['', ''];
    }
  }, [selectedItem]);

  const contentWidth = Math.min(width - 2, 90);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color={INK_COLORS.accent}>
          {'CLD CTRL v'}{VERSION}{' — Help'}
        </Text>
        <Box>
          <Text color={INK_COLORS.textDim}>{'shortcuts'}</Text>
          <Text color={INK_COLORS.textDim}>{'  commands'}</Text>
          <Text color={INK_COLORS.textDim}>{'  skills'}</Text>
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>{'─'.repeat(Math.max(1, contentWidth))}</Text>
      </Box>

      {/* Scrollable list */}
      <Box flexDirection="column" height={listHeight} paddingX={1}>
        {visibleItems.map((item, vi) => {
          const flatIdx = scrollOffset + vi;
          const isSelected = flatIdx === selectedFlatIndex;

          if (item.kind === 'header') {
            return (
              <Text key={`h-${flatIdx}`}>
                <Text color={INK_COLORS.accent} bold>{`  ${item.label}`}</Text>
              </Text>
            );
          }

          const pointer = isSelected ? '›' : ' ';
          const pointerColor = isSelected ? INK_COLORS.accent : INK_COLORS.text;

          if (item.kind === 'shortcut') {
            return (
              <Text key={`s-${flatIdx}`}>
                <Text color={pointerColor}>{pointer} </Text>
                <Text color={INK_COLORS.green}>{item.key}</Text>
                <Text color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}>{item.desc}</Text>
              </Text>
            );
          }

          if (item.kind === 'command') {
            const uses = item.uses > 0 ? ` ${item.uses}x` : '';
            const descMax = Math.max(10, contentWidth - 26 - uses.length);
            return (
              <Text key={`c-${flatIdx}`}>
                <Text color={pointerColor}>{pointer} </Text>
                <Text color={sourceColor(item.cmd.source)}>{`/${item.cmd.name.padEnd(20)}`}</Text>
                <Text color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}>
                  {item.cmd.description.slice(0, descMax)}
                </Text>
                {uses && <Text color={INK_COLORS.text}>{uses}</Text>}
              </Text>
            );
          }

          // skill
          return (
            <Text key={`k-${flatIdx}`}>
              <Text color={pointerColor}>{pointer} </Text>
              <Text color={INK_COLORS.yellow}>{item.skill.name.padEnd(22)}</Text>
              <Text color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}>
                {item.skill.description.slice(0, Math.max(10, contentWidth - 26))}
              </Text>
            </Text>
          );
        })}
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>{'─'.repeat(Math.max(1, contentWidth))}</Text>
      </Box>

      {/* Detail area */}
      <Box flexDirection="column" paddingX={1} height={detailHeight}>
        <Text bold color={INK_COLORS.accent}>{detailLines[0]}</Text>
        <Text color={INK_COLORS.text} wrap="truncate">{detailLines[1]}</Text>
      </Box>

      {/* Navigation hints */}
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>
          {'Esc/? close · j/k navigate · g/G top/bottom'}
        </Text>
      </Box>
    </Box>
  );
});

