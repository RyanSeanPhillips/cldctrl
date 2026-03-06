/**
 * Discover installed Claude Code slash commands and skills.
 * Reads from ~/.claude/commands/ (user), project .claude/commands/,
 * and ~/.claude/plugins/ (marketplace).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger.js';

export interface ClaudeCommand {
  name: string;          // slash command name (e.g. "review-team")
  description: string;
  source: 'user' | 'project' | 'plugin';
  pluginName?: string;   // for plugin-sourced commands
  filePath: string;
}

export interface ClaudeSkill {
  name: string;
  description: string;
  source: 'plugin';
  pluginName: string;
  filePath: string;
}

/**
 * Parse frontmatter from a markdown file.
 * Returns the description field if found.
 */
function parseFrontmatter(filePath: string): { description?: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---')) return {};

    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return {};

    const frontmatter = content.slice(3, endIdx);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    return {
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Scan a directory for .md command files.
 */
function scanCommandDir(dir: string, source: ClaudeCommand['source'], pluginName?: string): ClaudeCommand[] {
  const commands: ClaudeCommand[] = [];
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const filePath = path.join(dir, f);
      const name = path.basename(f, '.md');
      const { description } = parseFrontmatter(filePath);
      commands.push({
        name,
        description: description ?? '',
        source,
        pluginName,
        filePath,
      });
    }
  } catch { /* ignore */ }
  return commands;
}

/**
 * Discover all available slash commands.
 */
export function discoverCommands(projectPath?: string): ClaudeCommand[] {
  const commands: ClaudeCommand[] = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  // 1. User-level commands (~/.claude/commands/)
  commands.push(...scanCommandDir(path.join(claudeDir, 'commands'), 'user'));

  // 2. Project-level commands (.claude/commands/)
  if (projectPath) {
    commands.push(...scanCommandDir(path.join(projectPath, '.claude', 'commands'), 'project'));
  }

  // 3. Plugin commands (~/.claude/plugins/marketplaces/*/plugins/*/commands/)
  try {
    const marketplacesDir = path.join(claudeDir, 'plugins', 'marketplaces');
    if (fs.existsSync(marketplacesDir)) {
      for (const marketplace of fs.readdirSync(marketplacesDir)) {
        // Official plugins
        const pluginsDir = path.join(marketplacesDir, marketplace, 'plugins');
        if (fs.existsSync(pluginsDir)) {
          for (const plugin of fs.readdirSync(pluginsDir)) {
            const cmdDir = path.join(pluginsDir, plugin, 'commands');
            commands.push(...scanCommandDir(cmdDir, 'plugin', plugin));
          }
        }
        // External plugins
        const extDir = path.join(marketplacesDir, marketplace, 'external_plugins');
        if (fs.existsSync(extDir)) {
          for (const plugin of fs.readdirSync(extDir)) {
            const cmdDir = path.join(extDir, plugin, 'commands');
            commands.push(...scanCommandDir(cmdDir, 'plugin', plugin));
          }
        }
      }
    }
  } catch { /* ignore */ }

  return commands;
}

/**
 * Discover all available skills.
 */
export function discoverSkills(): ClaudeSkill[] {
  const skills: ClaudeSkill[] = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  try {
    const marketplacesDir = path.join(claudeDir, 'plugins', 'marketplaces');
    if (!fs.existsSync(marketplacesDir)) return [];

    for (const marketplace of fs.readdirSync(marketplacesDir)) {
      for (const subdir of ['plugins', 'external_plugins']) {
        const pluginsDir = path.join(marketplacesDir, marketplace, subdir);
        if (!fs.existsSync(pluginsDir)) continue;

        for (const plugin of fs.readdirSync(pluginsDir)) {
          const skillsDir = path.join(pluginsDir, plugin, 'skills');
          if (!fs.existsSync(skillsDir)) continue;

          for (const skillDir of fs.readdirSync(skillsDir)) {
            const skillFile = path.join(skillsDir, skillDir, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;

            const { description } = parseFrontmatter(skillFile);
            skills.push({
              name: skillDir,
              description: description ?? '',
              source: 'plugin',
              pluginName: plugin,
              filePath: skillFile,
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  return skills;
}

/**
 * Get a combined summary of commands and skills.
 */
export function getSkillsSummary(projectPath?: string): {
  commands: ClaudeCommand[];
  skills: ClaudeSkill[];
} {
  return {
    commands: discoverCommands(projectPath),
    skills: discoverSkills(),
  };
}
