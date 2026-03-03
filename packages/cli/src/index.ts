/**
 * Entry point: route to TUI or CLI command.
 *
 * - No args + TTY → launch TUI
 * - No args + no TTY → run `cldctrl list` (pipeable)
 * - Subcommand → delegate to Commander
 */

import { createCli } from './cli.js';
import { isTTY } from './core/platform.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cli = createCli();

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

  // Delegate to Commander for subcommands
  await cli.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message ?? err}`);
  process.exit(1);
});
