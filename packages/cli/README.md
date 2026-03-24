# CLD CTRL

<p align="center">
  <strong>Mission control for Claude Code</strong>
  <br>
  <a href="https://cld-ctrl.com">Website</a> · <a href="https://www.npmjs.com/package/cldctrl">npm</a> · <a href="https://github.com/RyanSeanPhillips/cldctrl/issues">Issues</a>
  <br><br>
  <a href="https://www.npmjs.com/package/cldctrl"><img src="https://img.shields.io/npm/v/cldctrl?color=%23e87632&style=flat-square" alt="npm version"></a>
  <a href="https://github.com/RyanSeanPhillips/cldctrl"><img src="https://img.shields.io/github/stars/RyanSeanPhillips/cldctrl?color=%23e87632&style=flat-square" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/RyanSeanPhillips/cldctrl?color=%23e87632&style=flat-square" alt="license"></a>
</p>

A terminal dashboard and session manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Track sessions, monitor token usage and costs, manage projects, and launch Claude Code — all from one place. Zero config: auto-discovers your existing Claude Code history.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot.png" alt="CLD CTRL dashboard — Claude Code session manager" width="700">
  <br>
  <em>Split-pane dashboard: projects, live conversations, sessions, git status, usage stats, calendar heatmap</em>
</p>

## Install

```
npm i -g cldctrl
```

Requires Node.js 18+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed. Also works with `npx cldctrl`.

## Features

### Session Intelligence
See every conversation across every project with token counts, tool usage, cost estimates, and model info. Resume any session with one key.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot.png" alt="Sessions view" width="600">
</p>

### Live Conversations
Watch active Claude Code sessions in real-time. See what tools are being used, token counts updating live, and which sessions are active vs idle.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_conversations.png" alt="Live conversations" width="600">
</p>

### Usage & Rate Limits
Rolling 5-hour and 7-day usage windows with live rate limit probing. Tier detection, overage monitoring, and per-session cost estimates. Calendar heatmap shows daily usage and commit patterns.

### GitHub Issues
Open issues per project with author and labels. Press Enter on an issue to launch Claude Code with a "fix this issue" prompt.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_issues.png" alt="Issues view" width="600">
</p>

### File Browser
Browse project files with lazy-loaded directory tree. Respects `.gitignore`, shows file type icons, highlights `CLAUDE.md` files. Press Enter to open in VS Code.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_files.png" alt="File browser" width="600">
</p>

### Git Status & Commits
Branch, uncommitted changes, unpushed commits, and behind count shown inline for every project. Commit history with additions/deletions per file.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_commits.png" alt="Commits view" width="600">
</p>

### Session Detail
Drill into individual conversations to see token breakdown, tool usage, model info, MCP servers, and a full activity timeline.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_conversation_detail.png" alt="Session detail" width="600">
</p>

### Settings Editor
Edit all settings inline — budget, launch options, notifications, hotkey config. No need to edit JSON files.

<p align="center">
  <img src="https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/master/docs/screenshot_settings.png" alt="Settings" width="600">
</p>

### More

- **Zero config** — Auto-discovers projects from your Claude Code history. No manual setup.
- **Project launcher** — Open file explorer, VS Code, and Claude Code in one action.
- **Project scanner** — Discover new projects across your filesystem.
- **Slash commands** — See which Claude Code commands are available and how often they're used.
- **Cross-platform** — Windows, macOS, and Linux with platform-specific terminal detection.
- **Responsive** — Adapts to narrow terminals with single-pane mode below 80 columns.
- **Global hotkey** — Ctrl+Up to launch from anywhere (configurable).

## Usage

```bash
# Full TUI dashboard
cldctrl                   # or: cld, cc

# CLI commands
cldctrl list              # List all projects with git status
cldctrl launch <name>     # Launch Claude Code for a project
cldctrl stats             # Show usage statistics
cldctrl issues            # Show GitHub issues across projects
cldctrl add <path>        # Add a project
cldctrl summarize         # Generate AI summaries for sessions
cldctrl setup             # Set up global hotkey

# Demo mode (synthetic data)
cldctrl --demo
```

## Keyboard Shortcuts

### Navigation

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up / down |
| `g` / `G` | Jump to top / bottom |
| `Ctrl+d` / `Ctrl+u` | Half-page scroll |
| `Tab` | Switch pane focus |
| `/` | Filter projects |
| `Esc` | Back / close overlay |
| `?` | Help overlay |

### Actions

| Key | Action |
|-----|--------|
| `Enter` | Launch / resume / open |
| `n` | New Claude Code session |
| `c` | Continue last session |
| `l` | Live conversations view |
| `o` | Open in file explorer |
| `p` | Pin / unpin project |
| `h` | Hide project |
| `r` | Refresh projects |
| `S` | Scan for new projects |
| `,` | Settings editor |

### Detail Pane

| Key | Action |
|-----|--------|
| `s` | Sessions tab |
| `c` | Commits tab |
| `i` | Issues tab |
| `f` | Files tab |
| `Left` / `Right` | Cycle tabs |

## How It Works

CLD CTRL reads Claude Code's session data from `~/.claude/projects` to discover your projects and session history. It parses JSONL session files for token counts, tool usage, and model info. A background daemon polls for git status, GitHub issues, and usage data, caching results for instant startup.

Active sessions are detected via JSONL file modification times — no plugins or hooks required. Multiple simultaneous sessions per project are supported.

On first run, a welcome wizard checks your environment (Claude Code, git, gh) and auto-discovers all your projects. No configuration needed.

## Requirements

- **Node.js** 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and in PATH
- `gh` CLI (optional — for GitHub issue integration)
- VS Code (optional — for project/file opening)

## Configuration

Projects are auto-discovered from `~/.claude/projects` and can also be configured manually. Config lives at `~/.config/cldctrl/config.json` (or `%APPDATA%\cldctrl\` on Windows). Use the built-in settings editor (`,` key) or edit directly:

```json
{
  "config_version": 4,
  "projects": [
    { "name": "My Project", "path": "/path/to/project" }
  ],
  "launch": { "explorer": true, "vscode": true, "claude": true },
  "daily_budget_tokens": 1000000,
  "notifications": {
    "github_issues": { "enabled": true, "poll_interval_minutes": 5 },
    "usage_stats": { "enabled": true }
  }
}
```

## Author

**Ryan Phillips** — [@RyanSeanPhillips](https://github.com/RyanSeanPhillips)

## License

[AGPL-3.0](LICENSE) — you can use CLD CTRL freely, but if you modify and distribute it (or run it as a service), you must open-source your changes under the same license.

Copyright 2025-2026 Ryan Phillips. All rights reserved.
