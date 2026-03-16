# CLD CTRL

Cross-platform mission control for Claude Code. Node.js CLI/TUI with React/Ink.

## Quick Reference

- **Package**: `packages/cli/` — monorepo, single package for now
- **Entry**: `src/index.ts` → lazy-loads TUI or CLI based on args
- **TUI**: `src/tui/App.tsx` (full dashboard), `src/tui/MiniApp.tsx` (popup wizard)
- **Config**: `~/.config/cldctrl/config.json` (or `%APPDATA%\cldctrl\`)
- **Cache**: `~/.config/cldctrl/cache.json` (written by daemon every 5 min)
- **Log**: `~/.config/cldctrl/debug.log` (JSON, 5MB rotation)
- **License**: AGPL-3.0

## Running

```bash
# Full TUI dashboard
cc                    # or: cldctrl, cld

# Mini popup (Ctrl+Up hotkey)
cc --mini

# CLI commands
cc list [--json]      # list projects with git status
cc launch <name>      # launch project in Claude Code
cc stats [--json]     # daily usage stats
cc issues [project]   # GitHub issues
cc summarize          # generate AI summaries for all sessions
cc setup              # install Ctrl+Up hotkey
cc daemon             # start background poller

# Demo mode (synthetic data for screenshots)
cc --demo [full|fresh|no-github|minimal]

# Safe mode (bypass diff renderer — more flicker, zero corruption)
cc --safe

# Debug diff renderer (logs frame stats to debug.log)
# Linux/macOS: DEBUG_DIFF=1 cc
# Windows cmd: set DEBUG_DIFF=1 && cc
# Windows PowerShell: $env:DEBUG_DIFF="1"; cc
```

## Architecture

```
src/
├── index.ts              Entry point — lazy-loads CLI or TUI
├── cli.ts                Commander CLI (lazy-loaded, not on TUI path)
├── config.ts             Zod-validated config with migration v1→v4
├── constants.ts          Colors, chars, defaults, shared formatters
├── types.ts              All type definitions (Config, Project, Session, etc.)
├── daemon.ts             Background poller: git/issues/stats → cache.json
├── core/
│   ├── projects.ts       Slug gen, discovery, list building (fast + full paths)
│   ├── sessions.ts       JSONL parsing, session stats, rolling usage
│   ├── git.ts            Git status + recent commits via child process
│   ├── github.ts         GitHub issues via `gh` CLI
│   ├── launcher.ts       Launch Claude Code with env cleanup
│   ├── tracker.ts        PID-based session tracking
│   ├── tailer.ts         Live JSONL tailing with incremental byte-offset parsing
│   ├── activity.ts       Full session activity parsing (tools, models, tokens)
│   ├── usage.ts          Per-project daily usage aggregation
│   ├── background.ts     Daemon cache I/O, seen-issues persistence
│   ├── summaries.ts      AI summary generation via `claude --print`
│   ├── platform.ts       Cross-platform helpers (paths, TTY, file explorer)
│   ├── logger.ts         Structured JSON logging with rotation
│   ├── command-usage.ts  Slash command usage scanning
│   ├── skills.ts         Claude Code commands/skills discovery
│   ├── sixel.ts          Sixel image protocol support
│   ├── demo-data.ts      Synthetic data for --demo mode
│   ├── filetree.ts       File tree: lazy dir reading, gitignore, icons, preview
│   └── scanner.ts        Project scanner: BFS discovery with depth limit
└── tui/
    ├── App.tsx            Root TUI: split-pane layout, data orchestration
    ├── MiniApp.tsx         Mini popup: 3-phase wizard
    ├── diffRenderer.ts    Differential screen rendering (eliminates flicker)
    ├── snapshot.tsx        Screenshot capture for testing
    ├── components/
    │   ├── ProjectPane.tsx     Left pane: project list + git badges + calendar
    │   ├── DetailPane.tsx      Right pane: sessions, issues, commits, previews
    │   ├── ActiveBadge.tsx     Live session status indicator
    │   ├── CalendarHeatmap.tsx  Weekly grid with ░▒▓█ shading
    │   ├── MatrixGlitch.tsx    Easter egg: Matrix-style green cascade
    │   ├── FilterBar.tsx       Type-to-filter overlay
    │   ├── PromptBar.tsx       New session prompt input
    │   ├── StatusBar.tsx       Bottom status bar
    │   ├── HelpOverlay.tsx     Help screen
    │   ├── ProgressBar.tsx     Budget progress bar
    │   └── Welcome.tsx         First-run welcome screen
    ├── hooks/
    │   ├── useAppState.ts      Reducer: config + projects + navigation
    │   ├── useBackgroundData.ts Polling hooks: git, issues, usage, live tailing
    │   ├── useKeyboard.ts      Keyboard input handler
    │   ├── useAnimations.ts    Pulse, clock, spinner, animated counter
    │   ├── useMiniState.ts     Mini TUI state reducer
    │   └── useFileTree.ts      File tree state: lazy loading, expand/collapse
    └── games/
        └── GameScreen.tsx      Hidden games (Ctrl+G)
```

## Performance Architecture

### Startup Path (target: <500ms to first paint)

1. `index.ts` loads only `platform.ts` and `tracker.ts` eagerly
2. CLI module (`cli.ts` + Commander/zod/git/github) lazy-loaded only for subcommands
3. TUI uses `buildProjectListFast()` — cached names, no git spawns
4. Background hooks read daemon cache for instant git statuses + calendar data
5. Full project names (with git remote extraction) refresh 500ms after mount

### Render Performance

- `usePulse(800)`: boolean toggle for pulsing indicators
- `useSpinner(150)`: braille spinner at 6.7fps (not 12.5fps)
- `useClock()`: extracted to `ClockDisplay` component — 1s re-render scoped to header only
- `useAnimatedCounter(32ms)`: ease-out token count animation
- `MatrixGlitch`: 150ms interval during rare 2-3s bursts
- `enrichedProcesses`: value-based equality check prevents unnecessary Map allocations
- `ProjectPane` and `DetailPane` wrapped in `React.memo`

### Data Flow

```
Daemon (background process)
  ↓ writes cache.json every 5 min
TUI hooks (useBackgroundData.ts)
  ↓ read cache on mount for instant first paint
  ↓ poll for fresh data in background
  ↓ shallowEqual prevents no-op re-renders
Components
  ↓ DetailSnapshot cache for instant scroll
  ↓ settledPath debounce (150ms) prevents expensive fetches during rapid scroll
```

## Critical Gotchas

### 1. Claude Code nesting detection

Claude Code sets `CLAUDECODE=1` when running. To launch Claude Code from within Claude Code, clear all `CLAUDE*` env vars **except** `CLAUDE_CODE_GIT_BASH_PATH` (needed for git-bash on Windows). See `launcher.ts:getCleanEnv()`.

### 2. React hooks rules in useBackgroundData.ts

All hooks must be called unconditionally. Demo mode checks use `const demo = isDemoMode()` at the top, then guard side effects inside hooks with `if (demo) return`. Never add an early return before hook calls.

### 3. Dropbox/EBUSY errors on Windows

`tsup` build may fail with `EBUSY: resource busy or locked` due to Dropbox sync locking temp files. Just retry the build.

### 4. Diff renderer and Ink rendering model

The renderer (`diffRenderer.ts`) intercepts both `stdout.write()` AND `stderr.write()`
during alternate screen mode. It uses a "last write replaces" strategy — each write()
call replaces the previous one (not accumulated). Ink writes each complete frame as a
single write() call, so the last write per event-loop tick IS the latest frame.

A `setImmediate` flush processes the latest write: strips non-SGR control sequences,
splits into lines, and redraws ALL lines with explicit cursor positioning. No line
diffing is used — full redraw every frame prevents stale-line bleed-through.

**Critical: content-before-erase pattern.** Each line is written as:
```
\x1b[row;1H\x1b[0m{content}\x1b[0m\x1b[K
```
Content overwrites old content in-place, then `\x1b[K` erases the tail. NEVER use
`\x1b[2K` (erase entire line) before content — it creates a visible blank-line flash
that terminals don't fully batch, even with DEC 2026 synchronized output.

stderr is suppressed during alt screen to prevent console.error, unhandled rejection
warnings, or logger verbose output from corrupting the display.

**Rules for future changes:**
1. Never use `overflow="hidden"` on Ink Box components — it's broken in Ink 5.x
   (randomly drops lines instead of clipping). Enforce height budgets manually.
2. Every rendered row must be counted: borders = 2 rows, `marginTop={1}` = 1 row.
3. Use `innerHeight = height - 2` when a Box has `borderStyle`.
4. Cap list items to fit within available rows — don't rely on Ink to clip.
5. **NEVER use `console.log` / `console.error` in TUI-path code.** stdout writes
   replace the current frame with garbage. stderr is suppressed but still lost.
   Use `logger.ts` for debug output instead.
6. Test with real data, not just `--demo`. Demo uses synchronous static data
   and won't expose timing-dependent rendering bugs.
7. **NEVER use line diffing** in the renderer. Full redraw every frame. The
   performance cost is negligible (~7KB/frame) and eliminates all sync issues.
8. **NEVER use buffer accumulation** — "last write replaces" is simpler and correct.
9. **NEVER use `\x1b[2K` before content** — always content-then-`\x1b[K]`.
10. `cc --safe` bypasses the diff renderer entirely as a fallback.

### 5. JSONL files can be huge

Session files can reach 50MB. Always read only what you need:
- `getProjectPathFromSlug()`: reads first 32KB + regex fallback for truncated lines
- `tailer.ts`: caps initial read to last 1MB
- `sessions.ts`: streams with readline, respects `maxSessionFileSize`

### 7. Session detection and idle tracking

Three detection sources in `processes.ts` (priority order):
1. **Markers** (`pids/*.json`) — cc-launched sessions. Trusted while file exists.
2. **Tracked PIDs** (`tracked-sessions.json`) — legacy, PIDs are unreliable.
3. **JSONL mtime** — externally-launched sessions. Creates one `ActiveSession` per
   recent JSONL file (supports multiple sessions per project).

Two thresholds:
- `ACTIVE_THRESHOLD_MS` (5h) — how far back to look for sessions (conversations window)
- `IDLE_THRESHOLD_MS` (5min) — sessions older than this show as idle (yellow dot, dimmed)

**Critical:** The idle check must use `!!session.idle`, NOT `session.tracked && session.idle`.
The `tracked` flag is only set for marker/PID sessions. Mtime-detected sessions have
`tracked: undefined`, so `tracked && idle` is always false — they never appear idle.

Hidden projects with active sessions are auto-unhidden: `useActiveProcesses` receives
`hiddenPaths` so mtime detection can find them, and the auto-add effect dispatches
`UNHIDE_PATHS` to remove them from `config.hidden_projects`.

`H` key toggles `showHidden` state (display integration pending).

### 8. File tree and scanner

- **File tree** (`useFileTree.ts`): Lazy-loads directories on expand. Caches children in `Map<relativePath, FileNode[]>`. Resets when project changes. Respects `.gitignore` via `parseGitignore()`. File type icons from extension/name maps.
- **Scanner** (`scanner.ts`): Synchronous BFS with configurable depth limit (default 5). Uses `PROJECT_INDICATORS` (CLAUDE.md, .git, package.json, etc.). `SKIP_DIRS` excludes node_modules, .git, AppData, etc. Supports `AbortSignal` for cancellation.
- Detail pane tabs: `sessions | commits | issues | files` — `f` key quick-jumps to files, `S` triggers scan.

### 9. File path case sensitivity

Windows paths are case-insensitive. Use `normalizePathForCompare()` from `platform.ts` for path comparisons. The daemon cache uses raw paths as keys.

## Color Palette

Defined in `constants.ts`. Both ANSI escape sequences (`COLORS`) and Ink hex values (`INK_COLORS`):

- Background: `#06080d` (near-black)
- Highlight: `#235F28` (selected row green)
- Accent: `#e87632` (CLD orange)
- Text: `#CCCCCC`, Dim: `#808080`
- Green: `#2dd4bf` (teal success)
- Yellow: `#f59e0b` (amber warning)
- Blue: `#388cff` (secondary blue)

## Config Schema (v4)

```json
{
  "config_version": 4,
  "projects": [{ "name": "My Project", "path": "/path/to/project", "alias": "mp" }],
  "hidden_projects": [],
  "launch": { "explorer": true, "vscode": true, "claude": true },
  "icon_color": "#DA8F4E",
  "global_hotkey": { "modifiers": "Ctrl", "key": "Up" },
  "project_manager": { "enabled": true },
  "daily_budget_tokens": 1000000,
  "notifications": {
    "github_issues": { "enabled": true, "poll_interval_minutes": 5 },
    "usage_stats": { "enabled": true, "show_tooltip": true }
  }
}
```

## Dependencies (7 production)

| Package | Size | Purpose |
|---------|------|---------|
| commander | ~200KB | CLI arg parsing (lazy-loaded) |
| cross-spawn | ~30KB | Cross-platform child process spawning |
| ink | ~1MB | React for terminal UIs |
| react | ~300KB | React runtime |
| p-limit | ~24KB | Concurrency limiter for git/gh spawns |
| zod | ~4.8MB | Config schema validation |
| node-notifier | ~5.5MB | Desktop notifications (daemon only) |

## Testing

```bash
# Type check
npx tsc --noEmit

# Build
npx tsup

# Manual smoke tests
cc --demo --snapshot    # renders one frame, exits
cc --demo              # full TUI with synthetic data
cc --version           # quick startup test
cc list --json         # CLI pipeline test
```
