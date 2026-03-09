/**
 * Entry point: route to TUI or CLI command.
 *
 * - No args + TTY → launch TUI
 * - No args + no TTY → run `cldctrl list` (pipeable)
 * - Subcommand → delegate to Commander
 * - Alias shortcuts: `cc <alias> [-n] [-c] [prompt...]`
 */

import { createCli } from './cli.js';
import { isTTY } from './core/platform.js';
import { loadConfig } from './config.js';
import { buildProjectList } from './core/projects.js';
import { launchClaude } from './core/launcher.js';
import { trackSession, pruneClosedSessions } from './core/tracker.js';

/**
 * Try to resolve a positional arg as a project alias or name match.
 */
function resolveProjectAlias(alias: string): { path: string; name: string } | null {
  const { config } = loadConfig();
  const lower = alias.toLowerCase();

  // Check explicit aliases first
  for (const p of config.projects) {
    if (p.alias && p.alias.toLowerCase() === lower) {
      return { path: p.path, name: p.name };
    }
  }

  // Fuzzy match on name
  const projects = buildProjectList(config);
  for (const p of projects) {
    if (p.name.toLowerCase() === lower) {
      return { path: p.path, name: p.name };
    }
  }

  // Partial match — require unambiguous prefix
  const prefixMatches = projects.filter(p => p.name.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) {
    return { path: prefixMatches[0].path, name: prefixMatches[0].name };
  }
  if (prefixMatches.length > 1) {
    console.error(`Ambiguous alias "${alias}". Did you mean:`);
    for (const p of prefixMatches) console.error(`  - ${p.name}`);
    process.exit(1);
  }

  return null;
}

async function main(): Promise<void> {
  // Prune stale tracked sessions from previous runs
  try { pruneClosedSessions(); } catch { /* ignore */ }

  const args = process.argv.slice(2);
  const cli = createCli();

  // Demo mode: load synthetic data for screenshots/recording
  if (args.includes('--demo')) {
    const { setDemoMode } = await import('./core/demo-data.js');
    setDemoMode();
    // Strip --demo from args so it doesn't confuse Commander
    const idx = args.indexOf('--demo');
    if (idx !== -1) args.splice(idx, 1);
    // If no other args, fall through to TUI launch below
  }

  // Mini TUI mode: fast 3-phase wizard (Ctrl+Up hotkey, quick task)
  if (args.includes('--mini') || args.includes('-m')) {
    if (isTTY()) {
      const { renderMiniApp } = await import('./tui/MiniApp.js');
      await renderMiniApp();
    } else {
      await cli.parseAsync(['node', 'cldctrl', 'list']);
    }
    return;
  }

  // Snapshot mode: render one TUI frame to stdout (for visual testing without TTY)
  if (args.includes('--snapshot')) {
    const { runSnapshot } = await import('./tui/snapshot.js');
    runSnapshot();
    return;
  }

  // If no subcommand provided
  if (args.length === 0 || (args.length === 1 && (args[0] === '--verbose' || args[0] === '--quiet'))) {
    if (isTTY()) {
      // Launch interactive TUI
      try {
        const { renderApp } = await import('./tui/App.js');
        await renderApp();
      } catch (err) {
        // Fallback if TUI fails (e.g., missing dependencies)
        console.error(`TUI failed to start: ${err}`);
        console.error('Falling back to list view...\n');
        await cli.parseAsync(['node', 'cldctrl', 'list']);
      }
    } else {
      // Non-TTY: pipe-friendly list output
      await cli.parseAsync(['node', 'cldctrl', 'list']);
    }
    return;
  }

  // Check for alias-based direct launch: cc <alias> [-n] [-c] [prompt...]
  // Only if the first arg doesn't look like a known subcommand
  const knownCommands = cli.commands.map(c => c.name());
  knownCommands.push('help', 'version');
  const firstArg = args[0];
  if (firstArg && !firstArg.startsWith('-') && !knownCommands.includes(firstArg)) {
    const project = resolveProjectAlias(firstArg);
    if (project) {
      const hasNew = args.includes('-n');
      const hasContinue = args.includes('-c');

      // Collect remaining args as prompt (skip flags and alias)
      const promptParts = args.slice(1).filter(a => a !== '-n' && a !== '-c');
      const prompt = promptParts.length > 0 ? promptParts.join(' ') : undefined;

      if (hasNew || hasContinue || prompt) {
        // Direct launch, skip TUI
        console.log(`Launching ${project.name}...`);
        const result = launchClaude({
          projectPath: project.path,
          isNew: hasNew,
          prompt,
        });
        if (result.success && result.pid) {
          trackSession(result.pid, project.path);
        }
        if (!result.success) {
          console.error(`Launch failed: ${result.message}`);
          process.exit(1);
        }
        return;
      }

      // Just alias, no flags — open TUI pre-selected
      // TODO: pass pre-select hint to TUI
      if (isTTY()) {
        try {
          const { renderApp } = await import('./tui/App.js');
          await renderApp();
        } catch (err) {
          console.error(`TUI failed to start: ${err}`);
        }
      }
      return;
    }
  }

  // Delegate to Commander for subcommands
  await cli.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message ?? err}`);
  process.exit(1);
});
