/**
 * In-TUI settings editor. Accessed via ',' key.
 * Two tabs: [General] for config values, [Permissions] for tool permissions.
 * Enter toggles booleans, edits numbers/strings inline.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { isFeatureEnabled } from '../../config.js';
import { loadPermissions, savePermissions, parsePermission } from '../../core/permissions.js';
import type { PermissionsConfig } from '../../core/permissions.js';
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

// ── Permissions flat list ───────────────────────────

interface PermissionRow {
  rule: string;
  category: 'allow' | 'deny' | 'ask';
  tool: string;
  scope: string;
  isHeader: boolean;
}

function buildPermissionRows(perms: PermissionsConfig): PermissionRow[] {
  const rows: PermissionRow[] = [];
  const categories: Array<'allow' | 'deny' | 'ask'> = ['allow', 'deny', 'ask'];

  for (const cat of categories) {
    const rules = perms[cat];
    if (rules.length === 0) continue;
    // Section header (not navigable — we skip it in index mapping)
    rows.push({ rule: '', category: cat, tool: '', scope: '', isHeader: true });
    for (const rule of rules) {
      const parsed = parsePermission(rule);
      rows.push({ rule, category: cat, tool: parsed.tool, scope: parsed.scope, isHeader: false });
    }
  }
  return rows;
}

/** Map a navigable index to the flat rows array index (skipping headers). */
function navToRowIndex(rows: PermissionRow[], navIndex: number): number {
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].isHeader) {
      if (count === navIndex) return i;
      count++;
    }
  }
  return rows.length - 1;
}

/** Count navigable (non-header) rows. */
function countNavigableRows(rows: PermissionRow[]): number {
  return rows.filter(r => !r.isHeader).length;
}

// ── Props ───────────────────────────────────────────

interface SettingsPaneProps {
  config: Config;
  selectedIndex: number;
  width: number;
  height: number;
  onConfigChange: (config: Config) => void;
  settingsTab?: 'general' | 'permissions';
  permissionsIndex?: number;
}

export const SettingsPane = React.memo(function SettingsPane({
  config,
  selectedIndex,
  width,
  height,
  settingsTab = 'general',
  permissionsIndex = 0,
}: SettingsPaneProps) {
  const isGeneral = settingsTab === 'general';

  // ── Tab header (always visible) ──────────────────
  const tabHeader = (
    <Box marginBottom={1}>
      <Text
        bold={isGeneral}
        color={isGeneral ? INK_COLORS.accent : INK_COLORS.textDim}
      >
        [General]
      </Text>
      <Text color={INK_COLORS.textDim}>{'  '}</Text>
      <Text
        bold={!isGeneral}
        color={!isGeneral ? INK_COLORS.accent : INK_COLORS.textDim}
      >
        [Permissions]
      </Text>
      <Text color={INK_COLORS.textDim}>{' — '}</Text>
      <Text color={INK_COLORS.textDim}>
        {isGeneral
          ? 'j/k:navigate  Enter:toggle  \u2190/\u2192:tab  Esc:back'
          : 'j/k:navigate  Enter:cycle  d:delete  \u2190/\u2192:tab  Esc:back'
        }
      </Text>
    </Box>
  );

  // ── General tab ──────────────────────────────────
  if (isGeneral) {
    const items = flattenConfig(config);
    const maxVisible = Math.max(1, height - 6);

    let offset = 0;
    if (selectedIndex >= offset + maxVisible) offset = selectedIndex - maxVisible + 1;
    if (selectedIndex < offset) offset = selectedIndex;
    offset = Math.max(0, Math.min(offset, Math.max(0, items.length - maxVisible)));

    const visible = items.slice(offset, offset + maxVisible);
    const labelWidth = Math.max(20, Math.min(32, Math.floor(width * 0.4)));
    const valueWidth = Math.max(10, width - labelWidth - 8);

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {tabHeader}

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

        {items[selectedIndex]?.description && (
          <Box marginTop={1}>
            <Text color={INK_COLORS.textDim}>{items[selectedIndex].description}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ── Permissions tab ──────────────────────────────
  const perms = loadPermissions();
  const rows = buildPermissionRows(perms);
  const navCount = countNavigableRows(rows);
  const maxVisible = Math.max(1, height - 6);

  if (navCount === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {tabHeader}
        <Text color={INK_COLORS.textDim}>No permissions configured.</Text>
        <Box marginTop={1}>
          <Text color={INK_COLORS.textDim}>
            Permissions are added automatically when you approve tool use in Claude Code.
          </Text>
        </Box>
      </Box>
    );
  }

  // Map navigable index to row index for highlighting
  const selectedRowIdx = navToRowIndex(rows, permissionsIndex);

  // Scroll window (based on row indices, not nav indices)
  let offset = 0;
  if (selectedRowIdx >= offset + maxVisible) offset = selectedRowIdx - maxVisible + 1;
  if (selectedRowIdx < offset) offset = selectedRowIdx;
  offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - maxVisible)));

  const visible = rows.slice(offset, offset + maxVisible);

  const categoryColor = (cat: string) =>
    cat === 'allow' ? INK_COLORS.green
      : cat === 'deny' ? INK_COLORS.red
        : INK_COLORS.yellow;

  const categoryLabel = (cat: string) =>
    cat === 'allow' ? 'allow' : cat === 'deny' ? 'deny' : 'ask';

  // Find the full rule text for the selected row (for description area)
  const selectedRow = rows[selectedRowIdx];

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {tabHeader}

      {visible.map((row, i) => {
        const realRowIdx = offset + i;
        const isSelected = realRowIdx === selectedRowIdx;

        if (row.isHeader) {
          return (
            <Box key={`header-${row.category}`} marginTop={i > 0 ? 1 : 0}>
              <Text bold color={categoryColor(row.category)}>
                {categoryLabel(row.category).toUpperCase()} ({perms[row.category].length})
              </Text>
            </Box>
          );
        }

        const pointer = isSelected ? CHARS.pointer : ' ';
        const maxToolWidth = Math.max(10, width - 20);
        const displayRule = row.scope
          ? `${row.tool}(${row.scope})`
          : row.tool;
        const truncatedRule = displayRule.length > maxToolWidth
          ? displayRule.slice(0, maxToolWidth - 3) + '...'
          : displayRule;

        return (
          <Box key={`${row.category}-${row.rule}`}>
            <Text
              color={isSelected ? INK_COLORS.text : INK_COLORS.textDim}
              backgroundColor={isSelected ? INK_COLORS.highlight : undefined}
              bold={isSelected}
            >
              {pointer} {truncatedRule}
            </Text>
            <Text color={categoryColor(row.category)}>
              {' '}[{categoryLabel(row.category)}]
            </Text>
          </Box>
        );
      })}

      {offset > 0 && (
        <Text color={INK_COLORS.textDim}>{CHARS.arrow_up} more above</Text>
      )}
      {offset + maxVisible < rows.length && (
        <Text color={INK_COLORS.textDim}>{CHARS.arrow_down} more below</Text>
      )}

      {/* Description: show full rule text for selected item */}
      {selectedRow && !selectedRow.isHeader && (
        <Box marginTop={1} flexDirection="column">
          <Text color={INK_COLORS.textDim}>
            {selectedRow.scope
              ? `${selectedRow.tool}(${selectedRow.scope})`
              : selectedRow.tool}
          </Text>
          <Text color={INK_COLORS.textDim} dimColor>
            Enter: cycle allow/deny/ask  d: remove rule
          </Text>
        </Box>
      )}
    </Box>
  );
});

/** Total number of settings items for a config. */
export function getSettingsItemCount(config: Config): number {
  return flattenConfig(config).length;
}

/** Get the navigable count for permissions tab. */
export function getPermissionsItemCount(): number {
  const perms = loadPermissions();
  const rows = buildPermissionRows(perms);
  return countNavigableRows(rows);
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

/**
 * Cycle a permission rule: allow → deny → ask → (remove).
 * Returns true if a change was made.
 */
export function cyclePermission(permissionsIndex: number): boolean {
  const perms = loadPermissions();
  const rows = buildPermissionRows(perms);
  const navRows = rows.filter(r => !r.isHeader);
  if (permissionsIndex < 0 || permissionsIndex >= navRows.length) return false;

  const row = navRows[permissionsIndex];
  const rule = row.rule;
  const from = row.category;

  // Cycle: allow → deny → ask → allow
  const cycle: Record<string, 'allow' | 'deny' | 'ask'> = {
    allow: 'deny',
    deny: 'ask',
    ask: 'allow',
  };
  const to = cycle[from];

  // Remove from current list
  perms[from] = perms[from].filter(r => r !== rule);
  // Add to target list
  perms[to].push(rule);

  savePermissions(perms);
  return true;
}

/**
 * Delete a permission rule at the given navigable index.
 * Returns true if deleted.
 */
export function deletePermission(permissionsIndex: number): boolean {
  const perms = loadPermissions();
  const rows = buildPermissionRows(perms);
  const navRows = rows.filter(r => !r.isHeader);
  if (permissionsIndex < 0 || permissionsIndex >= navRows.length) return false;

  const row = navRows[permissionsIndex];
  perms[row.category] = perms[row.category].filter(r => r !== row.rule);

  savePermissions(perms);
  return true;
}
