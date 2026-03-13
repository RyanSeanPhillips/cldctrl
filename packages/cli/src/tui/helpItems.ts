/**
 * Help overlay item list builder — shared between HelpOverlay and useKeyboard.
 */

import type { ClaudeCommand, ClaudeSkill } from '../core/skills.js';
import type { CommandUsageCounts } from '../core/command-usage.js';

export type HelpItem =
  | { kind: 'header'; label: string }
  | { kind: 'shortcut'; key: string; desc: string }
  | { kind: 'command'; cmd: ClaudeCommand; uses: number }
  | { kind: 'skill'; skill: ClaudeSkill };

export const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['j/k          ', 'Navigate projects'],
  ['g / G        ', 'Jump to top / bottom'],
  ['Ctrl+d/u     ', 'Half-page scroll'],
  ['/            ', 'Filter projects'],
  ['Enter        ', 'Launch project (smart)'],
  ['n            ', 'New session'],
  ['c            ', 'Continue last session'],
  ['i            ', 'Toggle issues view'],
  ['p            ', 'Pin/unpin project'],
  ['h            ', 'Hide discovered project'],
  ['r            ', 'Refresh git/issues'],
  ['S            ', 'Scan for new projects'],
  ['o            ', 'Open in file explorer'],
  ['f            ', 'Files tab (detail pane)'],
  ['l            ', 'Jump to live conversations'],
  ['a            ', 'Add project'],
  ['Tab          ', 'Focus details pane'],
  ['Esc          ', 'Back / exit pane'],
  [',            ', 'Settings'],
  ['q            ', 'Quit'],
  ['?            ', 'Toggle this help'],
  ['--safe       ', 'Bypass diff renderer (flag)'],
];

export type SkillsData = { commands: ClaudeCommand[]; skills: ClaudeSkill[] };

/** Build a flat list of all displayable items + count of navigable ones */
export function buildHelpItems(
  skillsData?: SkillsData,
  commandUsage?: CommandUsageCounts,
): { items: HelpItem[]; navigableCount: number } {
  const items: HelpItem[] = [];

  // Shortcuts section
  items.push({ kind: 'header', label: 'Keyboard Shortcuts' });
  for (const [key, desc] of SHORTCUTS) {
    items.push({ kind: 'shortcut', key, desc });
  }

  // Commands section
  const commands = skillsData?.commands ?? [];
  if (commands.length > 0) {
    items.push({ kind: 'header', label: 'Commands' });
    for (const cmd of commands) {
      items.push({ kind: 'command', cmd, uses: commandUsage?.[cmd.name] ?? 0 });
    }
  }

  // Skills section
  const skills = skillsData?.skills ?? [];
  if (skills.length > 0) {
    items.push({ kind: 'header', label: 'Skills' });
    for (const skill of skills) {
      items.push({ kind: 'skill', skill });
    }
  }

  const navigableCount = items.filter(i => i.kind !== 'header').length;
  return { items, navigableCount };
}

/** Map a navigable index to the flat items array index */
export function navigableToFlat(items: HelpItem[], navIndex: number): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'header') {
      if (count === navIndex) return i;
      count++;
    }
  }
  return items.length - 1;
}

/** Get navigable item count (pure function of skillsData) */
export function getHelpItemCount(skillsData?: SkillsData): number {
  const { navigableCount } = buildHelpItems(skillsData);
  return navigableCount;
}
