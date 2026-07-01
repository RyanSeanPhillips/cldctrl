/**
 * Entry point: route to the dashboard app, the classic TUI, or a CLI command.
 *
 * - No args + TTY → open the web dashboard as an app window (launchDashboardApp)
 * - `--tui` + TTY → the classic Ink TUI dashboard
 * - No args + no TTY → run `cldctrl list` (pipeable)
 * - Subcommand → delegate to Commander
 * - Alias shortcuts: `cc <alias> [-n] [-c] [prompt...]`
 */

import { isTTY, getPlatform } from './core/platform.js';
import { pruneClosedSessions } from './core/tracker.js';
import { installErrorHandlers, reportError } from './core/error-report.js';

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

/**
 * First-run bootstrap for the app-launcher contract. On the very first `cc`
 * (or after the setup contract bumps) it does a best-effort SILENT setup —
 * installs the Start-Menu shortcut on Windows — then writes a marker so it never
 * runs again. NEVER blocks or fails the launch: any error is swallowed.
 */
async function maybeFirstRunSetup(): Promise<void> {
  try {
    const { getConfigDir } = await import('./config.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const SETUP_VERSION = 1;
    const marker = path.join(getConfigDir(), 'setup.json');
    let prev: { appSetupVersion?: number } | null = null;
    try { prev = JSON.parse(fs.readFileSync(marker, 'utf-8')); } catch { /* first run */ }
    if (prev && (prev.appSetupVersion ?? 0) >= SETUP_VERSION) return;

    const firstEver = !prev;
    let shortcutOk = true;
    if (getPlatform() === 'windows') {
      try {
        const { installAppShortcut } = await import('./core/setup-windows.js');
        shortcutOk = installAppShortcut({ desktop: false }).success; // Start Menu only — silent
      } catch { shortcutOk = false; /* non-fatal */ }
    }
    try {
      fs.mkdirSync(getConfigDir(), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ appSetupVersion: SETUP_VERSION, shortcutOk, completedAt: new Date().toISOString() }, null, 2));
    } catch { /* non-fatal */ }
    if (firstEver) {
      console.log('CLD CTRL now opens the dashboard. Run `cc --tui` for the classic terminal UI.');
      // If the automatic shortcut failed, point at the manual command rather than
      // leaving the user with no icon and no explanation.
      if (!shortcutOk) console.log('Tip: run `cc shortcut` to add a Start-Menu/desktop shortcut.');
    }
  } catch { /* never block launch on setup */ }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isMini = args.includes('--mini') || args.includes('-m');

  // `cc --tui` opts into the classic Ink TUI; bare `cc` now opens the web
  // dashboard as an app window. Strip the flag from BOTH args and process.argv so
  // it never reaches Commander (which parses process.argv for subcommands).
  const wantsTui = args.includes('--tui');
  if (wantsTui) {
    const i = args.indexOf('--tui'); if (i >= 0) args.splice(i, 1);
    const j = process.argv.indexOf('--tui'); if (j >= 0) process.argv.splice(j, 1);
  }

  // Scrubbed crash telemetry (default ON, opt-out). Baseline surface = 'cli';
  // the TUI/mini paths refine it to 'tui' once they mount. Reads no config here
  // (cheap raw opt-out read happens lazily only if a crash actually fires), so
  // it doesn't touch the zero-zod fast startup path.
  const noSub = args.length === 0 || args.every((a) => a.startsWith('-'));
  installErrorHandlers(isTTY() && (isMini || noSub) ? 'tui' : 'cli');

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
      if (wantsTui) {
        // Classic Ink TUI. Single-instance guard: one TUI per virtual desktop
        // (Windows), else one globally. Records our PID + exit cleanup.
        const { acquireInstanceLock } = await import('./core/instance-guard.js');
        const decision = acquireInstanceLock();
        if (!decision.ok) {
          console.log(decision.message);
          process.exit(0);
        }
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
        // Default: open the web dashboard as an app window.
        await maybeFirstRunSetup();
        try {
          const { launchDashboardApp } = await import('./core/app-launch.js');
          await launchDashboardApp();
        } catch (err) {
          console.error(`Could not open the dashboard: ${err}`);
          console.error('Run `cc --tui` for the terminal UI, or `cc serve` to serve it manually.');
        }
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
  reportError(err, 'cli', 'main');
  console.error(`Fatal error: ${err.message ?? err}`);
  process.exit(1);
});
