/**
 * In-TUI settings editor. Accessed via ',' key.
 * Displays config values in a scrollable list.
 * Enter toggles booleans, edits numbers/strings inline.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { isFeatureEnabled } from '../../config.js';
import { INK_COLORS, CHARS } from '../../constants.js';
import type { Config } from '../../types.js';

interface SettingItem {
  key: string;
  label: string;
  value: string | number | boolean;
  type: 'boolean' | 'number' | 'string';
  path: string[];
  description?: string;
}

function flattenConfig(config: Config): SettingItem[] {
  const items: SettingItem[] = [];

  items.push({
    key: 'daily_budget_tokens',
    label: 'Daily token budget',
    value: config.daily_budget_tokens ?? 0,
    type: 'number',
    path: ['daily_budget_tokens'],
    description: 'Daily token limit (0 = auto-detect from tier)',
  });

  items.push({
    key: 'launch.claude',
    label: 'Launch Claude Code',
    value: config.launch.claude,
    type: 'boolean',
    path: ['launch', 'claude'],
    description: 'Open Claude Code on Enter',
  });

  items.push({
    key: 'launch.vscode',
    label: 'Launch VS Code',
    value: config.launch.vscode,
    type: 'boolean',
    path: ['launch', 'vscode'],
    description: 'Open VS Code alongside Claude',
  });

  items.push({
    key: 'launch.explorer',
    label: 'Launch file explorer',
    value: config.launch.explorer,
    type: 'boolean',
    path: ['launch', 'explorer'],
    description: 'Open folder in file explorer',
  });

  items.push({
    key: 'notifications.github_issues.enabled',
    label: 'GitHub issue notifications',
    value: config.notifications.github_issues.enabled,
    type: 'boolean',
    path: ['notifications', 'github_issues', 'enabled'],
  });

  items.push({
    key: 'notifications.github_issues.poll_interval_minutes',
    label: 'Issue poll interval (min)',
    value: config.notifications.github_issues.poll_interval_minutes,
    type: 'number',
    path: ['notifications', 'github_issues', 'poll_interval_minutes'],
  });

  items.push({
    key: 'notifications.usage_stats.enabled',
    label: 'Usage stat notifications',
    value: config.notifications.usage_stats.enabled,
    type: 'boolean',
    path: ['notifications', 'usage_stats', 'enabled'],
  });

  items.push({
    key: 'project_manager.enabled',
    label: 'Project manager',
    value: config.project_manager.enabled,
    type: 'boolean',
    path: ['project_manager', 'enabled'],
  });

  items.push({
    key: 'icon_color',
    label: 'Icon color',
    value: config.icon_color,
    type: 'string',
    path: ['icon_color'],
  });

  items.push({
    key: 'global_hotkey.modifiers',
    label: 'Hotkey modifiers',
    value: config.global_hotkey.modifiers,
    type: 'string',
    path: ['global_hotkey', 'modifiers'],
  });

  items.push({
    key: 'global_hotkey.key',
    label: 'Hotkey key',
    value: config.global_hotkey.key,
    type: 'string',
    path: ['global_hotkey', 'key'],
  });

  // ── Feature toggles ──────────────────────────
  const featureItems: { key: string; label: string; description: string }[] = [
    { key: 'rate_limit_bars', label: 'Rate limit bars (5h/7d)', description: 'Show usage progress bars in project pane' },
    { key: 'cost_estimates', label: 'Cost estimates (~$)', description: 'Show estimated dollar costs per session and daily' },
    { key: 'code_stats', label: 'Code stats (+/-)', description: 'Show lines added/deleted per day' },
    { key: 'calendar_heatmap', label: 'Calendar heatmap', description: 'Show 28-day activity grid in project pane' },
    { key: 'live_session_tailing', label: 'Live session tailing', description: 'Real-time token counter and round summaries' },
    { key: 'auto_discovery', label: 'Auto-discover projects', description: 'Find projects from ~/.claude/projects/' },
    { key: 'commands_section', label: 'Commands section', description: 'Show slash commands in project pane' },
    { key: 'animations', label: 'Animations', description: 'Pulsing badges, animated counters, today highlight' },
  ];

  for (const feat of featureItems) {
    items.push({
      key: `features.${feat.key}`,
      label: feat.label,
      value: isFeatureEnabled(config, feat.key),
      type: 'boolean',
      path: ['features', feat.key],
      description: feat.description,
    });
  }

  // Hidden projects count
  if (config.hidden_projects.length > 0) {
    items.push({
      key: 'hidden_projects',
      label: `Hidden projects (${config.hidden_projects.length})`,
      value: 'Unhide all',
      type: 'string',
      path: ['hidden_projects'],
      description: 'Enter to unhide all',
    });
  }

  return items;
}

interface SettingsPaneProps {
  config: Config;
  selectedIndex: number;
  width: number;
  height: number;
  onConfigChange: (config: Config) => void;
}

export const SettingsPane = React.memo(function SettingsPane({
  config,
  selectedIndex,
  width,
  height,
}: SettingsPaneProps) {
  const items = flattenConfig(config);
  const maxVisible = Math.max(1, height - 6);

  // Scroll window
  let offset = 0;
  if (selectedIndex >= offset + maxVisible) offset = selectedIndex - maxVisible + 1;
  if (selectedIndex < offset) offset = selectedIndex;
  offset = Math.max(0, Math.min(offset, Math.max(0, items.length - maxVisible)));

  const visible = items.slice(offset, offset + maxVisible);
  const labelWidth = Math.max(20, Math.min(32, Math.floor(width * 0.4)));
  const valueWidth = Math.max(10, width - labelWidth - 8);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color={INK_COLORS.accent}>Settings</Text>
        <Text color={INK_COLORS.textDim}> — j/k:navigate  Enter:toggle/edit  Esc:back</Text>
      </Box>

      {visible.map((item, i) => {
        const realIndex = offset + i;
        const isSelected = realIndex === selectedIndex;
        const pointer = isSelected ? CHARS.pointer : ' ';

        let displayValue: string;
        let valueColor: string;
        if (item.type === 'boolean') {
          displayValue = item.value ? 'ON' : 'OFF';
          valueColor = item.value ? INK_COLORS.green : INK_COLORS.red;
        } else if (item.type === 'number') {
          displayValue = String(item.value);
          valueColor = INK_COLORS.accent;
        } else {
          displayValue = String(item.value);
          valueColor = INK_COLORS.blue;
        }

        return (
          <Box key={item.key}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {pointer} {item.label.padEnd(labelWidth)}
            </Text>
            <Text color={valueColor} bold={isSelected}>
              {' '}{displayValue.slice(0, valueWidth)}
            </Text>
          </Box>
        );
      })}

      {offset > 0 && (
        <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} more above</Text>
      )}
      {offset + maxVisible < items.length && (
        <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} more below</Text>
      )}

      {/* Description of selected item */}
      {items[selectedIndex]?.description && (
        <Box marginTop={1}>
          <Text color={INK_COLORS.textDim}>{items[selectedIndex].description}</Text>
        </Box>
      )}
    </Box>
  );
});

/** Total number of settings items for a config. */
export function getSettingsItemCount(config: Config): number {
  return flattenConfig(config).length;
}

/** Toggle or modify the setting at the given index. Returns new config or null if no change. */
export function toggleSetting(config: Config, index: number): Config | null {
  const items = flattenConfig(config);
  if (index < 0 || index >= items.length) return null;

  const item = items[index];
  const newConfig = JSON.parse(JSON.stringify(config)) as Config;

  if (item.type === 'boolean') {
    // Navigate to the nested property and toggle it
    let obj: any = newConfig;
    for (let i = 0; i < item.path.length - 1; i++) {
      obj = obj[item.path[i]];
    }
    obj[item.path[item.path.length - 1]] = !item.value;
    return newConfig;
  }

  if (item.key === 'hidden_projects') {
    // Unhide all
    newConfig.hidden_projects = [];
    return newConfig;
  }

  // For number/string types, would need inline editing (future)
  return null;
}
