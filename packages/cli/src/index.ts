/**
 * Entry point: route to TUI or CLI command.
 *
 * - No args + TTY → launch TUI
 * - No args + no TTY → run `cldctrl list` (pipeable)
 * - Subcommand → delegate to Commander
 * - Alias shortcuts: `cc <alias> [-n] [-c] [prompt...]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { isTTY } from './core/platform.js';
import { pruneClosedSessions } from './core/tracker.js';

// Set console window title early (Windows uses process.title for the titlebar)
process.title = 'CLD CTRL';

/**
 * Try to resolve a positional arg as a project alias or name match.
 * Lazy-imports heavy modules to avoid loading them for TUI-only paths.
 */
async function resolveProjectAlias(alias: string): Promise<{ path: string; name: string } | null> {
  const { loadConfig } = await import('./config.js');
  const { buildProjectList } = await import('./core/projects.js');
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
  const args = process.argv.slice(2);
  const isMini = args.includes('--mini') || args.includes('-m');

  // Prune stale tracked sessions (skip for mini mode — adds ~50ms startup latency)
  if (!isMini) {
    try { pruneClosedSessions(); } catch { /* ignore */ }
  }

  // Lazy CLI construction — avoid loading Commander/zod/git/github modules for TUI paths
  let _cli: import('commander').Command | null = null;
  const getCli = async () => {
    if (!_cli) {
      const { createCli } = await import('./cli.js');
      _cli = createCli();
    }
    return _cli;
  };

  // Demo mode: load synthetic data for screenshots/recording
  // Usage: --demo [variant]  where variant is: full (default), fresh, no-github, minimal
  if (args.includes('--demo')) {
    const { setDemoMode } = await import('./core/demo-data.js');
    const idx = args.indexOf('--demo');
    const validVariants = ['full', 'fresh', 'no-github', 'minimal'] as const;
    const nextArg = args[idx + 1];
    const variant = nextArg && validVariants.includes(nextArg as any)
      ? nextArg as typeof validVariants[number]
      : 'full';
    setDemoMode(variant);
    // Strip --demo and variant arg from args so they don't confuse Commander
    args.splice(idx, nextArg === variant ? 2 : 1);
    // If no other args, fall through to TUI launch below
  }

  // Safe mode: bypass diff renderer for debugging rendering issues
  if (args.includes('--safe')) {
    const { setSafeMode } = await import('./core/platform.js');
    setSafeMode(true);
    args.splice(args.indexOf('--safe'), 1);
  }

  // Mini TUI mode: fast 3-phase wizard (Ctrl+Up hotkey, quick task)
  if (args.includes('--mini') || args.includes('-m')) {
    if (isTTY()) {
      const { renderMiniApp } = await import('./tui/MiniApp.js');
      await renderMiniApp();
    } else {
      await (await getCli()).parseAsync(['node', 'cldctrl', 'list']);
    }
    return;
  }

  // Snapshot mode: render one TUI frame to stdout (for visual testing without TTY)
  if (args.includes('--snapshot')) {
    // FORCE_COLOR must be set before chalk/Ink load to enable ANSI output when piped
    if (process.env.SNAPSHOT_ANSI === '1') {
      process.env.FORCE_COLOR = '3';
      (process.stdout as any).isTTY = true;
      (process.stderr as any).isTTY = true;
    }
    const { runSnapshot } = await import('./tui/snapshot.js');
    await runSnapshot();
    return;
  }

  // If no subcommand provided
  if (args.length === 0 || (args.length === 1 && (args[0] === '--verbose' || args[0] === '--quiet'))) {
    if (isTTY()) {
      // Single-instance guard: prevent multiple TUI instances
      const { getConfigDir } = await import('./config.js');
      const pidPath = path.join(getConfigDir(), 'tui.pid');
      try {
        const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        if (existingPid && existingPid !== process.pid) {
          try {
            process.kill(existingPid, 0); // signal 0 = check if alive
            console.log('CLD CTRL is already running. Press Ctrl+Up to focus it, or close the other instance first.');
            process.exit(0);
          } catch (e: any) {
            if (e.code === 'EPERM') {
              // Process exists but no permission — still running
              console.log('CLD CTRL is already running.');
              process.exit(0);
            }
            // ESRCH = process doesn't exist — stale PID file, continue
          }
        }
      } catch { /* no PID file — first instance */ }
      // Write our PID
      try {
        fs.mkdirSync(path.dirname(pidPath), { recursive: true });
        fs.writeFileSync(pidPath, process.pid.toString());
      } catch { /* ignore */ }
      const cleanupPid = () => { try { fs.unlinkSync(pidPath); } catch { /* ignore */ } };
      process.on('exit', cleanupPid);

      // Launch interactive TUI
      try {
        const { renderApp } = await import('./tui/App.js');
        await renderApp();
      } catch (err) {
        // Fallback if TUI fails (e.g., missing dependencies)
        console.error(`TUI failed to start: ${err}`);
        console.error('Falling back to list view...\n');
        await (await getCli()).parseAsync(['node', 'cldctrl', 'list']);
      }
    } else {
      // Non-TTY: pipe-friendly list output
      await (await getCli()).parseAsync(['node', 'cldctrl', 'list']);
    }
    return;
  }

  // Check for alias-based direct launch: cc <alias> [-n] [-c] [prompt...]
  // Only if the first arg doesn't look like a known subcommand
  const cli = await getCli();
  const knownCommands = cli.commands.map(c => c.name());
  knownCommands.push('help', 'version');
  const firstArg = args[0];
  if (firstArg && !firstArg.startsWith('-') && !knownCommands.includes(firstArg)) {
    const project = await resolveProjectAlias(firstArg);
    if (project) {
      const hasNew = args.includes('-n');
      const hasContinue = args.includes('-c');

      // Collect remaining args as prompt (skip flags and alias)
      const promptParts = args.slice(1).filter(a => a !== '-n' && a !== '-c');
      const prompt = promptParts.length > 0 ? promptParts.join(' ') : undefined;

      if (hasNew || hasContinue || prompt) {
        // Direct launch, skip TUI
        const { launchClaude } = await import('./core/launcher.js');
        const { trackSession } = await import('./core/tracker.js');
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
