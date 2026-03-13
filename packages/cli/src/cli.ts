/**
 * Commander CLI setup: all subcommands.
 * cldctrl list, launch, stats, issues, add, remove, config
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, APP_NAME, CHARS } from './constants.js';
import { loadConfig, saveConfig, getConfigDir, getConfigPath } from './config.js';
import { buildProjectList, getProjectSlug } from './core/projects.js';
import { formatTokenCount, getRollingUsageStats } from './core/sessions.js';
import { getGitStatus, formatGitStatus } from './core/git.js';
import { getIssues, isGhAvailable, getGhInstallUrl, sanitizeIssueTitle } from './core/github.js';
import { launchClaude } from './core/launcher.js';
import { trackSession } from './core/tracker.js';
import { initLogger, setVerbose, log } from './core/logger.js';
import { getClaudeProjectsDir, pathIsSafe, isTTY, normalizePathForCompare } from './core/platform.js';
import type { Config, Project } from './types.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('cldctrl')
    .description('Mission control for Claude Code')
    .version(VERSION)
    .option('--verbose', 'Enable debug output to stderr')
    .option('--quiet', 'Suppress non-essential output')
    .hook('preAction', (_thisCommand, actionCommand) => {
      const opts = program.opts();
      if (opts.verbose) {
        setVerbose(true);
        initLogger({ verbose: true });
      } else {
        initLogger();
      }
    });

  // ── list ────────────────────────────────────────────────

  program
    .command('list')
    .description('List all projects with git status')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const { config } = loadConfig();
      const projects = buildProjectList(config);

      if (opts.json) {
        const output = [];
        for (const p of projects) {
          const git = await getGitStatus(p.path);
          output.push({
            name: p.name,
            path: p.path,
            pinned: p.pinned,
            discovered: p.discovered,
            git: git ? { branch: git.branch, dirty: git.dirty, ahead: git.ahead, behind: git.behind } : null,
          });
        }
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        return;
      }

      if (projects.length === 0) {
        console.log('No projects found. Run `cldctrl add <path>` or use Claude Code to auto-discover.');
        return;
      }

      let lastWasPinned = true;
      for (const p of projects) {
        // Separator between pinned and discovered
        if (lastWasPinned && p.discovered) {
          console.log(`  ${CHARS.separator.repeat(3)} Discovered ${CHARS.separator.repeat(3)}`);
          lastWasPinned = false;
        }

        const git = await getGitStatus(p.path);
        const gitStr = formatGitStatus(git);
        const pin = p.pinned ? '' : '  ';
        const prefix = p.pinned ? CHARS.pointer : ' ';
        console.log(`  ${prefix} ${p.name.padEnd(20)} ${gitStr}`);
      }
    });

  // ── launch ──────────────────────────────────────────────

  program
    .command('launch <name>')
    .description('Launch a project in Claude Code')
    .option('--new', 'Start a new session')
    .option('--resume <id>', 'Resume a specific session')
    .action(async (name: string, opts) => {
      const { config } = loadConfig();
      const projects = buildProjectList(config);
      const nameLower = name.toLowerCase();
      const project = projects.find(
        (p) => p.name.toLowerCase() === nameLower
      );

      if (!project) {
        console.error(`Project "${name}" not found. Run \`cldctrl list\` to see available projects.`);
        process.exit(1);
      }

      const result = launchClaude({
        projectPath: project.path,
        isNew: opts.new,
        sessionId: opts.resume,
      });

      if (result.success) {
        if (result.pid) {
          trackSession(result.pid, project.path);
        }
        if (!program.opts().quiet) {
          console.log(`${CHARS.check} ${result.message}: ${project.name}`);
        }
      } else {
        console.error(`${CHARS.cross} ${result.message}`);
        process.exit(1);
      }
    });

  // ── stats ───────────────────────────────────────────────

  program
    .command('stats')
    .description('Show daily usage stats')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const claudeDir = getClaudeProjectsDir();
      const stats = await getRollingUsageStats(claudeDir);

      if (opts.json) {
        process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
        return;
      }

      console.log(`${APP_NAME} Usage Stats (${stats.date})`);
      console.log(`  Messages: ${stats.messages}`);
      console.log(`  Tokens:   ${formatTokenCount(stats.tokens)}`);
    });

  // ── issues ──────────────────────────────────────────────

  program
    .command('issues [project]')
    .description('List open GitHub issues')
    .option('--json', 'Output as JSON')
    .action(async (projectName: string | undefined, opts) => {
      if (!isGhAvailable()) {
        console.log(`GitHub CLI (gh) not found. Install it to see issues:`);
        console.log(`  ${getGhInstallUrl()}`);
        return;
      }

      const { config } = loadConfig();
      const projects = buildProjectList(config);

      const targetProjects = projectName
        ? projects.filter((p) => p.name.toLowerCase() === projectName.toLowerCase())
        : projects;

      if (targetProjects.length === 0) {
        console.log(projectName
          ? `Project "${projectName}" not found.`
          : 'No projects found.'
        );
        return;
      }

      const allIssues: Array<{ project: string; issues: Awaited<ReturnType<typeof getIssues>> }> = [];

      for (const p of targetProjects) {
        const issues = await getIssues(p.path);
        if (issues.length > 0) {
          allIssues.push({ project: p.name, issues });
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(allIssues, null, 2) + '\n');
        return;
      }

      if (allIssues.length === 0) {
        console.log('No open issues found.');
        return;
      }

      for (const { project, issues } of allIssues) {
        console.log(`\n${project}:`);
        for (const issue of issues) {
          const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
          console.log(`  #${issue.number} ${issue.title}${labels}`);
        }
      }
    });

  // ── add ─────────────────────────────────────────────────

  program
    .command('add <path>')
    .description('Add a project to config')
    .option('--name <name>', 'Display name for the project')
    .action((projectPath: string, opts) => {
      const resolvedPath = path.resolve(projectPath);

      if (!fs.existsSync(resolvedPath)) {
        console.error(`Path does not exist: ${resolvedPath}`);
        process.exit(1);
      }

      if (!pathIsSafe(resolvedPath)) {
        console.error(`Path contains unsafe characters: ${resolvedPath}`);
        process.exit(1);
      }

      const name = opts.name ?? path.basename(resolvedPath);
      const { config } = loadConfig();

      // Check for duplicates
      const exists = config.projects.some(
        (p) => normalizePathForCompare(p.path) === normalizePathForCompare(resolvedPath)
      );
      if (exists) {
        console.log(`Project already exists: ${name}`);
        return;
      }

      config.projects.push({ name, path: resolvedPath });
      saveConfig(config);

      if (!program.opts().quiet) {
        console.log(`${CHARS.check} Added: ${name} (${resolvedPath})`);
      }
    });

  // ── remove ──────────────────────────────────────────────

  program
    .command('remove <name>')
    .description('Remove a project from config')
    .action((name: string) => {
      const { config } = loadConfig();
      const idx = config.projects.findIndex(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );

      if (idx === -1) {
        console.error(`Project "${name}" not found in config.`);
        process.exit(1);
      }

      const removed = config.projects.splice(idx, 1)[0];
      saveConfig(config);

      if (!program.opts().quiet) {
        console.log(`${CHARS.check} Removed: ${removed.name}`);
      }
    });

  // ── config ──────────────────────────────────────────────

  const configCmd = program
    .command('config')
    .description('Manage configuration');

  configCmd
    .command('show')
    .description('Print config location and contents')
    .action(() => {
      const configPath = getConfigPath();
      console.log(`Config: ${configPath}\n`);
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        process.stdout.write(content);
      } catch {
        console.log('(no config file yet — run any command to create one)');
      }
    });

  configCmd
    .command('edit')
    .description('Open config in $EDITOR')
    .action(() => {
      const configPath = getConfigPath();
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';

      // Ensure config exists first
      const { config, isNew } = loadConfig();
      if (isNew) saveConfig(config);

      const spawn = require('cross-spawn') as typeof import('cross-spawn');
      const child = spawn.spawn(editor, [configPath], { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code !== 0) {
          console.error(`Editor exited with code ${code}`);
        }
      });
    });

  configCmd
    .command('path')
    .description('Print config directory path')
    .action(() => {
      console.log(getConfigDir());
    });

  // ── summarize ──────────────────────────────────────────

  program
    .command('summarize')
    .description('Generate AI summaries for all session transcripts')
    .option('--concurrency <n>', 'Max parallel Claude calls', '2')
    .action(async (opts) => {
      const { generateMissingSummaries, generateMissingIssueSummaries } = await import('./core/summaries.js');
      const { config } = loadConfig();
      const projects = buildProjectList(config);

      if (projects.length === 0) {
        console.log('No projects found.');
        return;
      }

      let totalGenerated = 0;
      const concurrency = parseInt(opts.concurrency, 10) || 2;

      // Session summaries
      for (const p of projects) {
        if (!program.opts().quiet) {
          process.stdout.write(`${CHARS.pointer} ${p.name} sessions...`);
        }

        try {
          const count = await generateMissingSummaries(p.path, concurrency, (sessionId, _summary) => {
            if (!program.opts().quiet) {
              process.stdout.write(` ${CHARS.check}`);
            }
          });
          totalGenerated += count;

          if (!program.opts().quiet) {
            console.log(count > 0 ? ` (${count} generated)` : ' (up to date)');
          }
        } catch (err) {
          if (!program.opts().quiet) {
            console.log(` ${CHARS.cross} error`);
          }
        }
      }

      // Issue summaries
      let totalIssueSummaries = 0;
      if (isGhAvailable()) {
        for (const p of projects) {
          if (!program.opts().quiet) {
            process.stdout.write(`${CHARS.pointer} ${p.name} issues...`);
          }

          try {
            const issues = await getIssues(p.path);
            if (issues.length === 0) {
              if (!program.opts().quiet) console.log(' (no issues)');
              continue;
            }
            const count = await generateMissingIssueSummaries(p.path, issues, concurrency, (_num, _summary) => {
              if (!program.opts().quiet) {
                process.stdout.write(` ${CHARS.check}`);
              }
            });
            totalIssueSummaries += count;

            if (!program.opts().quiet) {
              console.log(count > 0 ? ` (${count} generated)` : ' (up to date)');
            }
          } catch (err) {
            if (!program.opts().quiet) {
              console.log(` ${CHARS.cross} error`);
            }
          }
        }
      }

      if (!program.opts().quiet) {
        console.log(`\n${CHARS.check} Done. Generated ${totalGenerated} session + ${totalIssueSummaries} issue summaries.`);
      }
    });

  // ── skills ──────────────────────────────────────────────

  program
    .command('skills')
    .description('List available Claude Code commands and skills')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const { getSkillsSummary } = await import('./core/skills.js');
      const { commands, skills } = getSkillsSummary();

      if (opts.json) {
        process.stdout.write(JSON.stringify({ commands, skills }, null, 2) + '\n');
        return;
      }

      const userCmds = commands.filter(c => c.source === 'user');
      const pluginCmds = commands.filter(c => c.source === 'plugin');

      if (userCmds.length > 0) {
        console.log(`\n  ${CHARS.pointer} User Commands`);
        for (const cmd of userCmds) {
          console.log(`    /${cmd.name.padEnd(22)} ${cmd.description}`);
        }
      }

      if (pluginCmds.length > 0) {
        console.log(`\n  ${CHARS.pointer} Plugin Commands`);
        for (const cmd of pluginCmds) {
          const src = cmd.pluginName ? ` (${cmd.pluginName})` : '';
          console.log(`    /${cmd.name.padEnd(22)} ${cmd.description}${src}`);
        }
      }

      if (skills.length > 0) {
        console.log(`\n  ${CHARS.pointer} Skills (auto-triggered)`);
        for (const skill of skills) {
          const src = skill.pluginName ? ` (${skill.pluginName})` : '';
          console.log(`    ${skill.name.padEnd(24)} ${skill.description.slice(0, 60)}${src}`);
        }
      }

      const total = commands.length + skills.length;
      if (total === 0) {
        console.log('No commands or skills found.');
        console.log('Create custom commands in ~/.claude/commands/ as .md files.');
      } else {
        console.log(`\n  ${total} total (${commands.length} commands, ${skills.length} skills)`);
      }
    });

  // ── analyze ─────────────────────────────────────────────

  program
    .command('analyze [project]')
    .description('Analyze sessions to suggest skills and project memories')
    .option('--sessions <n>', 'Recent sessions to scan per project', '10')
    .option('--json', 'Raw JSON output')
    .action(async (projectName: string | undefined, opts) => {
      const { analyzeProject, saveSkill, saveMemory } = await import('./core/analyzer.js');
      const { config } = loadConfig();
      const projects = buildProjectList(config);

      const targetProjects = projectName
        ? projects.filter(p => p.name.toLowerCase() === projectName.toLowerCase())
        : projects;

      if (targetProjects.length === 0) {
        console.log(projectName ? `Project "${projectName}" not found.` : 'No projects found.');
        return;
      }

      const sessionCount = parseInt(opts.sessions, 10) || 10;
      const allResults: { skills: import('./core/analyzer.js').SkillSuggestion[]; memories: import('./core/analyzer.js').MemorySuggestion[] } = { skills: [], memories: [] };

      if (!opts.json) {
        console.log(`Analyzing ${targetProjects.length} project${targetProjects.length > 1 ? 's' : ''} (${sessionCount} sessions each)...\n`);
      }

      for (const p of targetProjects) {
        if (!opts.json) {
          process.stdout.write(`${CHARS.pointer} ${p.name}...`);
        }

        try {
          const result = await analyzeProject(p.path, p.name, sessionCount);
          allResults.skills.push(...result.skills);
          allResults.memories.push(...result.memories);

          if (!opts.json) {
            console.log(` ${CHARS.check} ${result.skills.length} skills, ${result.memories.length} memories`);
          }
        } catch (err) {
          if (!opts.json) {
            console.log(` ${CHARS.cross} error: ${String(err)}`);
          }
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(allResults, null, 2) + '\n');
        return;
      }

      if (allResults.skills.length === 0 && allResults.memories.length === 0) {
        console.log('\nNo suggestions found. Try with more sessions or different projects.');
        return;
      }

      console.log('');

      // Interactive: present each suggestion
      const rl = await import('node:readline');
      const prompt = rl.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise(r => prompt.question(q, r));

      for (const skill of allResults.skills) {
        console.log(`${CHARS.check} Skill suggestion: /${skill.name}`);
        console.log(`  ${skill.description}`);
        if (skill.evidence.length > 0) {
          console.log(`  Evidence: ${skill.evidence[0].slice(0, 100)}`);
        }
        const answer = await ask('  Save? [y/n] ');
        if (answer.trim().toLowerCase() === 'y') {
          const saved = saveSkill(skill);
          console.log(`  ${CHARS.check} Saved to ${saved}\n`);
        } else {
          console.log(`  Skipped.\n`);
        }
      }

      for (const memory of allResults.memories) {
        console.log(`${CHARS.check} Memory suggestion: ${memory.project}`);
        console.log(`  [${memory.category}] ${memory.content}`);
        if (memory.evidence.length > 0) {
          console.log(`  Evidence: ${memory.evidence[0].slice(0, 100)}`);
        }
        // Find the project path for saving
        const targetProject = targetProjects.find(p => p.name === memory.project);
        if (targetProject) {
          const answer = await ask('  Save to CLAUDE.md? [y/n] ');
          if (answer.trim().toLowerCase() === 'y') {
            const saved = saveMemory(memory, targetProject.path);
            console.log(`  ${CHARS.check} Appended to ${saved}\n`);
          } else {
            console.log(`  Skipped.\n`);
          }
        }
      }

      prompt.close();
      console.log(`${CHARS.check} Done.`);
    });

  // ── setup ───────────────────────────────────────────────

  program
    .command('setup')
    .description('Install Ctrl+Up hotkey listener (cross-platform)')
    .option('--uninstall', 'Remove the hotkey listener from startup')
    .action(async (opts) => {
      const { setupHotkey, removeHotkey } = await import('./core/setup.js');
      if (opts.uninstall) {
        const result = removeHotkey();
        console.log(result.message);
        process.exit(result.success ? 0 : 1);
      } else {
        const result = setupHotkey();
        console.log(result.message);
        process.exit(result.success ? 0 : 1);
      }
    });

  // ── daemon ──────────────────────────────────────────────

  program
    .command('daemon')
    .description('Start background polling + notifications')
    .action(async () => {
      // Dynamic import to keep daemon code separate
      const { startDaemon } = await import('./daemon.js');
      await startDaemon();
    });

  return program;
}
