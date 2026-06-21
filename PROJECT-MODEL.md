# The cldctrl project model

How cldctrl decides what counts as a "project," where that list comes from, and
how to add / remove / rename one safely. Written 2026-06-20 alongside the
`create_project` / `rescan_projects` MCP tools.

## The short version

A project is a filesystem directory. The **authoritative** list of projects is:

1. The `projects` array in **`config.json`** (explicitly registered / "pinned"), plus
2. Whatever **`core/scanner.ts`** discovery turns up (folders containing a
   `PROJECT_INDICATOR` file), plus
3. Projects that have **Claude Code sessions** under `~/.claude/projects/`.

Everything else — `project-names.json`, `project-index.json` — is a **cache** that
makes startup fast. Hand-editing those caches is the wrong fix; they get
regenerated. Register through `config.json` (or a scan) instead.

## Where the data lives

Config dir is `%APPDATA%\cldctrl\` on Windows, `~/.config/cldctrl/` elsewhere
(see `getConfigDir()` in `config.ts`; a legacy `claudedock` dir is honored if present).

| File | Role | Authoritative? | Writer |
|------|------|----------------|--------|
| `config.json` | Registered projects (`projects[]`), hidden list, settings | **Yes** | `saveConfig()` |
| `project-index.json` | Cached filesystem-scan results (`core/project-index.ts`) | No (cache) | scan / `mergeIntoIndex()` |
| `project-names.json` | `path → display name` map for fast first paint (`core/project-cache.ts`) | No (cache) | `buildProjectList()` |
| `~/.claude/projects/<slug>/*.jsonl` | Claude Code's own session transcripts | n/a (external) | Claude Code |

The `<slug>` is the project path with `[:\/_ ]` replaced by `-` (`getProjectSlug()`).
`cldctrl` reconstructs the real path by reading the first ~32KB of a session JSONL
for its `cwd` field (`getProjectPathFromSlug()`), not by un-slugging the name.

## How the list is built (`core/projects.ts`)

`buildProjectList(config)` unions three sources, deduped by normalized path
(case-insensitive on Windows/macOS), in this order:

1. **Config projects** (`config.projects`) — marked `pinned: true`. These always
   appear. The display name is the configured `name` unless it equals the folder
   basename, in which case `extractProjectName()` derives a nicer one from
   `package.json` / `pyproject.toml` / `Cargo.toml` / git remote.
2. **Discovered projects** — `discoverProjects()` walks `~/.claude/projects/`,
   keeps slug dirs that have at least one `.jsonl`, resolves each back to its real
   `cwd`, and adds it (unless already present or hidden). Gated by the
   `auto_discovery` feature flag.
3. **Indexed projects** — `readProjectIndex()` returns folders found by a previous
   filesystem scan. These may have no Claude sessions yet.

Then two final passes run over the union:

- **`filterNestedProjects()`** — drops any *non-pinned* project whose path is a
  strict subdirectory of another project. (Pinned subfolders survive.) This is why
  a folder can be present in `project-names.json` yet absent from `list_projects`:
  e.g. `tzdata` living inside a parent repo is filtered out as nested.
- **`disambiguateNames()`** — when two projects share a display name, appends
  `parent/child` so they read distinctly.

Two more exclusions apply to **every** source (config / discovered / indexed), so
noise can't slip in via one path while being filtered on another:

- **`isNonProjectPath()`** — drops the home root, OS shell folders
  (Documents/Desktop/Downloads/…), and anything inside a Python env's
  `site-packages`. The scanner also has `site-packages` in `SKIP_DIRS` so it never
  descends there in the first place.
- **`config.hidden_projects`** (normalized paths) — explicit hides, honored
  throughout and across rescans.

`buildProjectListFast()` is the same pipeline minus the expensive name extraction
(uses the `project-names.json` cache, falls back to basename) — used for first paint.

## What triggers discovery / scanning

- **TUI `S` key** — runs `scanForProjects()` (BFS, depth 5, keyed on
  `PROJECT_INDICATORS`), then `mergeIntoIndex()` to persist results to
  `project-index.json`. See `App.tsx`.
- **Daemon** — performs the same scan/refresh on its background cycle.
- **`rescan_projects` MCP tool** — runs the scan + index merge on demand and
  reports newly-discovered projects (`core/create-project.ts`).
- **Passive discovery** — every `buildProjectList()` re-reads
  `~/.claude/projects/`, so any folder that has had a Claude Code session shows up
  on the next list build without an explicit scan.

`PROJECT_INDICATORS` = `CLAUDE.md`, `.git`, `package.json`, `pyproject.toml`,
`setup.py`, `Cargo.toml`, `go.mod`, `Makefile`, `CMakeLists.txt`, `build.gradle`,
`.sln`, `Gemfile`, `mix.exs`, `dune-project`, `flake.nix`, `Pipfile`,
`requirements.txt`. A directory with `.git` is treated as one project and not
descended into. `SKIP_DIRS` (node_modules, venvs, build dirs, AppData, …) are
never entered.

## Naming rules

- Configured name wins, unless it's just the folder basename — then
  `extractProjectName()` derives one from project metadata or the git remote.
- Discovered/indexed projects use `extractProjectName()` (or the cached name in
  the fast path).
- Duplicate names get a `parent/child` suffix via `disambiguateNames()`.

## Adding / removing / renaming safely

**Add a new project (recommended): `create_project` MCP tool** — creates the
folder, seeds `CLAUDE.md` from supplied context, `git init`s, and registers it in
`config.json` in one call, leaving it ready for `launch_session`. Idempotent.

**Add an existing folder:** either start a Claude Code session in it (passive
discovery picks it up), run a scan (`S` key / `rescan_projects` — needs a
`PROJECT_INDICATOR` present), or add an entry to `config.projects` in `config.json`.

**Rename:** set/change `name` (and optionally `alias`) on the project's entry in
`config.projects`. For discovered-only projects, add a config entry to pin the name.
Do **not** edit `project-names.json` — it's regenerated from the list build.

**Remove / hide:** the `hide_project` MCP tool adds the path to
`config.hidden_projects` — durable across rescans, reversible with
`unhide_project` (by full path, or by folder basename). You can also edit
`config.hidden_projects` directly; the `H` key toggles hidden visibility in the
TUI. To fully drop a registered project, delete its entry from `config.projects`.
The index/name caches self-prune stale paths.

**Clean up noise:** most non-project clutter (shell folders, library dirs) is now
filtered automatically by `isNonProjectPath()`. For anything that still slips
through, `hide_project` silences it permanently.

## Relationship to Claude Code

cldctrl never modifies `~/.claude/`. It only *reads* `~/.claude/projects/` to
discover projects and parse session activity. Launching a session
(`launch_session` / `launchAndTrack`) opens a real Claude Code terminal in the
project dir; Claude Code then writes its own session JSONL, which in turn makes the
project discoverable on the next list build even if it was never registered.
