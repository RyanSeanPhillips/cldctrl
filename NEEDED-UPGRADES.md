# cldctrl — needed upgrades

Surfaced 2026-06-20 while trying to spin up a brand-new project ("paper-radio")
from the control plane. Two clear gaps.

> **Status (2026-06-20): DONE.** Both gaps are addressed:
> - `create_project` and `rescan_projects` MCP tools added (`mcp-server.ts`,
>   backed by `core/create-project.ts`). `create_project` creates the folder,
>   seeds `CLAUDE.md` from context, `git init`s, registers in `config.json`, and
>   optionally launches — leaving the project ready for `launch_session`.
> - The project model is now documented in [PROJECT-MODEL.md](./PROJECT-MODEL.md).
>
> The original scope is kept below for reference.

## 1. Robust "create / register a new project" capability
**Problem:** There is no supported way to start a *new* project from control.
`launch_session({ project })` rejects any path that is not already registered
("Project not found: <path>"). So a freshly created folder cannot be opened as a
session, which blocks the whole "control dispatches work into a new project" flow.

**What we found about the registry (so a fix is grounded):**
- `%APPDATA%/cldctrl/project-names.json` — a flat `path -> name` map.
- `%APPDATA%/cldctrl/project-index.json` — separate index (larger; not fully inspected).
- `list_projects` does NOT just echo `project-names.json`: e.g. `tzdata` is present in
  the names map but absent from `list_projects`, so there is extra filtering/derivation.
- Per the project CLAUDE.md, the authoritative sources are the `projects` array in
  `config.json` plus `core/scanner.ts` discovery (BFS keyed on `PROJECT_INDICATORS` =
  CLAUDE.md, .git, package.json, etc.); `project-names.json` / `project-index.json` are
  caches. The TUI `S` key triggers a scan; the daemon also scans. So a folder with a
  CLAUDE.md + .git is discoverable on the next scan. Hand-editing the cache JSONs is the
  wrong fix; drive it through scan/config instead.

**Desired — one tool that handles it all in the background:**
- A single MCP `create_project({ path, name?, context })` tool. You point it at a
  location and hand it the context the new project needs; it then, in the background:
  creates the folder if missing, seeds a `CLAUDE.md` from `context` (background + starter
  instructions), runs `git init`, scans/registers so the project is immediately known,
  and returns it ready for `launch_session` (optionally launching it in the same call).
  One call, no manual folder/registry steps.
- Internally this needs a scan/refresh step. Expose that as a small standalone
  `rescan_projects` tool too (useful on its own, and the quickest individual win), but the
  headline is the one-shot `create_project`.
- Discovery already keys on `PROJECT_INDICATORS` (CLAUDE.md, .git, package.json) via
  `core/scanner.ts`, and the authoritative project list is the `projects` array in
  `config.json` plus that scan (the `%APPDATA%` JSONs are caches). So `create_project` is
  mostly "make CLAUDE.md + .git, add to config / scan" wrapped in one call.

## 2. Document how projects are handled (in general)
There is currently no doc explaining the project model. Write one covering:
- Where the registry lives and which files are involved (`project-names.json`,
  `project-index.json`, anything else).
- How discovery / scanning works and what triggers it (relationship to Claude Code's
  `~/.claude` project list).
- Naming rules and how `list_projects` derives its output (the filtering that hides
  things like `tzdata`).
- How to add / remove / rename a project safely.

## Immediate workaround used for paper-radio
Created `C:\Users\rphil2\Dropbox\paper-radio` manually (folder + git + CLAUDE.md). To
register it: start a Claude Code session in that folder so Claude Code records it, then
let cldctrl rescan. After that, control's `launch_session`/handoffs should work on it.
