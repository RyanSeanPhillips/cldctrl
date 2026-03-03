# ClaudeDock v4

Windows system tray application for launching Claude Code projects. Written in PowerShell 5.1 with WinForms.

## Quick Reference

- **Main file**: `ClaudeDock.ps1` (~2600 lines, single-file app)
- **Config**: `config.json` (gitignored, see `config.example.json` for schema)
- **Icon**: `ClaudeDock.ico` (64x64 PNG-compressed ICO, 543 bytes)
- **Log**: `debug.log` (structured JSON, one event per line, 5MB rotation)
- **Seen issues**: `seen-issues.json` (persists seen issue IDs to prevent duplicate notifications)
- **License**: AGPL-3.0 (see LICENSE, NOTICE, CLA.md)

## Running

```powershell
# Launch (hidden window, runs in system tray)
powershell -ExecutionPolicy Bypass -File ClaudeDock.ps1

# Kill and restart (helper script)
powershell -ExecutionPolicy Bypass -File restart.ps1
```

The app registers a global hotkey (default: Ctrl+Up) and runs a WinForms message loop. Uses a named mutex (`Global\ClaudeDock_SingleInstance`) to prevent duplicate instances.

## Architecture

Single-file PowerShell 5.1 app. No modules or dependencies beyond .NET Framework 4.x (ships with Windows).

### Key Components

| Lines | Section | Purpose |
|-------|---------|---------|
| 1-42 | Startup | Logging init, single-instance mutex guard |
| 43-120 | Win32 API | C# interop for RegisterHotKey, virtual desktops |
| 122-230 | Config | Validation, loading, schema migration (v1 -> v2 -> v3 -> v4) |
| 235-280 | Icon | Load .ico, create bitmap for UI rendering |
| 287-540 | Session Data | Stats, recent sessions, preview, git status (background jobs) |
| 547-665 | GitHub | Issue fetching via `gh` CLI (background jobs) |
| 666-860 | Notifications | Seen-issues persistence, issue notifications, usage stats tooltip |
| 861-960 | Project Discovery | Auto-discover projects from `~/.claude/projects`, merge with config |
| 961-1060 | Accelerators/Update | Keyboard shortcut assignment, update check |
| 1061-1250 | Launcher Logic | Show/hide, filtering, fuzzy search, navigation |
| 1251-1430 | Phased UI | Phase 1 (project list), Phase 2 (actions), Phase 3 (issues) |
| 1431-1530 | Toast | Launch feedback notification window |
| 1531-2100 | Form + Paint | WinForms initialization, all GDI+ custom painting |
| 2100-2160 | Launch Actions | Open Explorer, VS Code, Claude Code in cmd |
| 2160-2310 | Context Menu | Right-click tray menu with project submenus |
| 2310-2430 | Main Loop | Background poll timer, hotkey handler, ApplicationContext.Run() |

### 17 Features

1. **Session stats** - Token counts, cost, message counts from JSONL session files
2. **Auto-discovery** - Finds projects from `~/.claude/projects` directory slugs
3. **GitHub issues** - Fetches open issues via `gh` CLI for projects with remotes
4. **Issue fix launch** - Opens Claude Code with `--prompt "Fix #N: title"`
5. **Safety/quality pass** - Launch option for code review prompts
6. **Fuzzy search** - Type-to-filter with substring matching across all phases
7. **Toast notifications** - Visual feedback when launching projects
8. **Session preview** - Shows last user message on hover in phase 2
9. **Update checking** - Compares version against GitHub releases API
10. **Structured logging** - JSON event log with rotation (`debug.log`)
11. **Config migration** - Automatic v1 -> v2 -> v3 -> v4 schema upgrade
12. **AGPL licensing** - License, notice, and CLA files
13. **Scrollable project list** - Shows ~7 items initially, scrolls to 12, with above/below indicators
14. **Pin/unpin projects** - Right-click any project to pin (promotes to top) or unpin
15. **Project Manager** - Launches Claude Code with full project inventory for prioritization review
16. **GitHub issue notifications** - Background polling with balloon notifications for new issues (configurable interval, click to open launcher)
17. **Usage stats tooltip** - Hover tray icon to see daily token/message totals, updated every 5 minutes

## Critical PowerShell 5.1 Gotchas

These are hard-won lessons. Violating any of these will cause subtle, hard-to-debug failures.

### 1. Scriptblock closures don't capture function-local variables

When a scriptblock is used as a .NET delegate (event handler, timer tick, paint handler), it does **NOT** see function-local variables in PS 5.1. It only sees `$script:` and `$global:` scope.

```powershell
# BROKEN - $myVar is $null inside the handler
function Show-Thing {
    $myVar = "hello"
    $form.add_Paint({ $g.DrawString($myVar, ...) })  # $myVar is $null!
}

# CORRECT - use $script: scope
$script:myVar = "hello"
$form.add_Paint({ $g.DrawString($script:myVar, ...) })
```

**Every variable** accessed inside WinForms event handlers, timer ticks, and paint delegates must be `$script:` scoped.

### 2. ErrorActionPreference "Stop" causes JIT crash dialogs

`$ErrorActionPreference = "Stop"` at script level bleeds into WinForms delegate callbacks. Non-terminating errors become unhandled .NET exceptions that bypass try/catch and trigger JIT debugging dialogs.

**The global ErrorActionPreference MUST be "Continue"**. Add explicit try/catch inside every event handler.

### 3. Icon.ToBitmap() and DrawIcon() fail on PNG-compressed .ico files

The ClaudeDock.ico contains a PNG-compressed entry. .NET Framework's `Icon.ToBitmap()` and `Graphics.DrawIcon()` both throw "Requested range extends past the end of the array."

**Solution**: Load the .ico file as a `Bitmap` via `MemoryStream`:
```powershell
$bytes = [System.IO.File]::ReadAllBytes($icoPath)
$stream = New-Object System.IO.MemoryStream(,$bytes)
$bmp = New-Object System.Drawing.Bitmap($stream)
```

### 4. Claude Code nesting detection

Claude Code sets `CLAUDECODE=1` (no underscore) when running. To launch Claude Code from within a Claude Code environment, clear all `CLAUDE*` env vars **except** `CLAUDE_CODE_GIT_BASH_PATH` (needed for git-bash on Windows).

### 5. Background jobs for non-blocking UI

Git status, GitHub issue fetching, update checks, and usage stats all run in `Start-Job` background jobs. Results are polled via timers. The 500ms `issueTimer` handles UI-visible data; the 30s `backgroundPollTimer` handles issue notifications and usage stats. Never call blocking operations (git, network) on the UI thread.

### 6. GDI+ resource management

All brushes, pens, fonts, and graphics objects must be `Dispose()`d. Leaks cause GDI handle exhaustion and eventual crashes. The paint handler creates and disposes resources on each paint call.

## Color Palette

Terminal/command-prompt style. Defined in the paint handler (~line 1381):

- Background: `(12, 12, 12)` - true black
- Highlight: `(35, 95, 40)` - green (like diff added-line highlight)
- Border: `(48, 48, 48)`
- Accent: `(204, 120, 50)` - warm amber
- Text: `(204, 204, 204)` - light gray
- Green: `(22, 198, 12)` - terminal green
- Font: Consolas (monospace throughout)

## Config Schema (v4)

```json
{
    "config_version": 4,
    "projects": [
        { "name": "My Project", "path": "C:\\path\\to\\project", "hotkey": "M" }
    ],
    "hidden_projects": [],
    "launch": { "explorer": true, "vscode": true, "claude": true },
    "icon_color": "#DA8F4E",
    "global_hotkey": { "modifiers": "Ctrl", "key": "Up" },
    "project_manager": { "enabled": true },
    "notifications": {
        "github_issues": { "enabled": true, "poll_interval_minutes": 5 },
        "usage_stats": { "enabled": true, "show_tooltip": true }
    }
}
```

- `project_manager.enabled`: Set to `false` to hide the Project Manager item from the launcher. Default: `true`.
- `notifications.github_issues.enabled`: Enable/disable background issue polling and balloon notifications. Default: `true`.
- `notifications.github_issues.poll_interval_minutes`: How often to check for new issues. Default: `5`.
- `notifications.usage_stats.enabled`: Enable/disable daily usage stats aggregation. Default: `true`.
- `notifications.usage_stats.show_tooltip`: Show token/message counts in tray tooltip on hover. Default: `true`.

## Testing

No automated test suite. Manual testing workflow:

1. Kill existing: `powershell -ExecutionPolicy Bypass -File restart.ps1`
2. Check `debug.log` for startup errors
3. Press Ctrl+Up to open launcher
4. Navigate phases, launch projects, verify toast
5. Right-click tray icon for context menu
6. Verify scrolling: arrow down past 7th item, check scroll indicators
7. Right-click a project to pin/unpin
8. Press M or select "Project Manager" to launch inventory review
9. Hover tray icon — tooltip shows "ClaudeDock" initially, then updates with usage after ~30s
10. Wait 5 min (or lower `poll_interval_minutes`) — if a new issue exists, balloon notification appears
11. Click balloon — launcher opens
12. Set `notifications.github_issues.enabled: false` — no more issue polling
13. Set `notifications.usage_stats.show_tooltip: false` — tooltip reverts to "ClaudeDock"
14. Restart app — `seen-issues.json` persists, no duplicate notifications
15. Kill app — no orphaned PowerShell background jobs

## Helper Scripts

- `restart.ps1` - Kill running instance and relaunch
- `inspect_ico.ps1` - Debug utility for examining .ico file structure
- `generate-icon.ps1` - Generate the rocket ship .ico programmatically
- `generate-screenshots.ps1` - Generate documentation screenshots
- `create-shortcut.ps1` - Create Windows shortcut for startup
- `install.bat` / `uninstall.bat` - Add/remove from Windows startup
- `ClaudeDock.vbs` - VBScript wrapper for silent launch (no console flash)
