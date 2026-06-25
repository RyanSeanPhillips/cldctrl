# CLD CTRL — Roadmap & Backlog

A living list of shipped work, tracked features, and parked ideas so nothing gets
lost. Big items are also tracked as GitHub issues (linked). Last updated **2026-06-24**.

> Strategic throughline (see "Direction" at the bottom): the skin (terminals/UI) is
> table-stakes that the first parties commoditize; the **moat is the cross-project,
> cross-vendor, local "brain"** (orchestration + memory + search across Claude/Codex/
> Gemini). Bias new work toward the brain; treat terminal-hosting as plumbing.

---

## ▶ Suggested next sequence
0. **Restart `cc serve` + refresh, then smoke-test the shipped work first** — see the **🧪 Testing watch** section below for the live-verify checklist. Fix any regressions before building on top.
1. ✅ **DONE — compose-box + drag-to-reorder** (the friction-removing easy wins). e2e-verified.
2. ✅ **DONE (phase 1) — [#11] CodexSource → unified search.** Codex sessions are indexed cross-vendor. Next #11 slices: Codex in per-project/recent lists, Codex resume-in-cockpit, Codex usage in Stats, Gemini source.
3. **Vector/semantic search** over that unified (now cross-vendor) corpus (memory tier S).
4. **[#10]/[#9] conversation-interaction wiring** — *#9 message-in shipped (`send_to_session`/`read_session`)*; remaining = the driver model (#10) + faithful worktree resume + a launch→read-back verify flow.
5. **[#12] working memory** — last; experimental; start with the dumb per-project recap v0.

---

## ✅ Recently shipped (June 2026)
- **Threaded consult (multi-agent council, half 1)** — `consult_agent` can now hold a MULTI-TURN conversation with Codex/Claude instead of one-shot: the result returns a `thread_id`; pass it back and the agent **resumes its own session** (Codex `exec resume`, Claude `-p --resume`) so it remembers prior turns — you send only what's new (e.g. each round of edits) instead of re-pasting history. Vendor session id captured from JSON output (`session_id` / `thread.started.thread_id`), mapped behind an opaque cldctrl handle persisted under the config dir. Gemini stays one-shot. Verified end-to-end against the real Codex CLI (turn 2 recalled a secret from turn 1). Pairs with #9/#10 coordination.
- **Docked per-conversation notepad** — the per-tile ✎ floating-scratchpad button is now a 📓 notepad that DOCKS inside the conversation tile (50/50 split with the terminal; maximize for a roomy write+chat). Keyed by tile id → resuming a chat reopens the same draft (stable file under the scratch dir via `/api/scratch?key`). Autosave + Ctrl+S, edit/preview, 2.5s sync of the agent's edits (won't clobber unsaved text), "📎 → chat" drops the file path into the compose box so the agent can edit the same draft. Open-state persists on the tile (`CockpitTile.noteOpen`). Built for drafting prose with the agent.
- **Per-conversation context-window meter** — each terminal tile's header shows a bar + % of how full that conversation's context is (last assistant turn's cacheRead+input+cacheCreation ÷ model window; 200k or 1M). Green→amber→red at 65/85%, tooltip shows raw tokens + a /compact nudge. Pure client wiring over the already-sent `sessions[].contextSize`.
- **Vendor-neutral search — Codex CLI indexed (#11 phase 1)** — `search_conversations` + the dashboard search now span Claude **and** OpenAI Codex (`~/.codex/sessions` rollouts → the same index, each result tagged `vendor`). Schema verified against real files and reviewed by Codex itself. Dashboard shows a CODEX chip and guards the Claude-only resume paths. The reverse is ~free: a Codex session gets unified recall over your whole Claude history via the same MCP tool. *Remaining #11: per-project/recent lists include Codex, Codex resume-in-cockpit, Codex usage in Stats, Gemini.*
- **Compose-box** — a real `<textarea>` under each terminal tile (✎ header toggle): native click-to-edit, spellcheck, paste; sends into the PTY on Enter (Shift+Enter newline; multiline wrapped in bracketed-paste). Auto-grows.
- **Message-in / coordination primitive (#9 partial)** — inject text into a RUNNING cockpit session. MCP `send_to_session` (prefill+confirm by default, autoSend to submit) + `read_session` (read back recent turns to verify a launched kickoff). Reuses the dashboard-bridge queue; the compose-box is the confirm surface. *Remaining #9: faithful worktree resume; a launch→read-back verify flow.*
- **Drag-to-reorder cockpit tiles** — grip on each tile header; reorders `cp.tiles`, DOM re-ordered via insertBefore so PTYs/xterm state survive (verified the terminal stays live with content preserved).
- **Cockpit Stats tab** — token usage by 5h block + 7-day cumulative (2nd axis), per-turn billed, context-per-conversation with 1M reference lines, cache-miss (eviction vs reload) timeline, tool-result context, MCP/agent tables, live usage strip, clickable image lightbox; 24h/3d/7d/30d range.
- **Per-project focus chips** + **default-to-cockpit** + "New in cockpit"; re-resume focuses the existing tile.
- **Auto-reconnect** cockpit tiles after sleep/idle-kill.
- **Terminal**: light-theme contrast fix (`minimumContrastRatio`), **Ctrl+C copy / Ctrl+V paste**, **double-Ctrl+C exit warning**, **clickable file paths** (→ open in VS Code / reveal in Explorer).
- **Branded favicon** (orange ⌃ tile) + **tab attention** (flash title + badge favicon when a conversation needs input while you're on another tab).
- **Launch-queue** fix (cockpit-launch was a single slot that could clobber; now a queue).
- **#8 fixed/closed** — `launch_session` no longer truncates multi-word prompts (Windows `cmd /c` quoting → temp `.bat`).
- **Stats KPI cards blank on LIGHT themes — fixed** (commit `8191125`). `--text-bright` was referenced (KPI values, card `<h2>` titles, legend bold) but never declared in any theme, so it fell back to `#fff` → white-on-white on daylight/paper. Declared per theme + hardened fallback to `var(--text)`.

---

## 🧪 Testing watch — verify live / dogfood (after `cc serve` restart + refresh)
Everything here is code- and Playwright-e2e-verified, but **needs confirmation in real daily use** (the dogfood loop). Keep an eye on these specifically — last updated 2026-06-24:
- **Stats KPI cards on light themes** (fix `8191125`) — confirm values + card titles + legend numbers render on **daylight/paper** (were invisible white-on-white). ⚠️ **Audit watch:** grep for any other `var(--text-bright, …)` or hardcoded `#fff`/white text that could be invisible on light themes elsewhere (this class of bug hides until you switch themes).
- **Compose-box** (`bd162c1`) — Enter sends, Shift+Enter newline, **multiline reaches the agent intact via bracketed-paste** (no per-line submit) across claude *and* codex; spellcheck/paste work; ✎ toggle; auto-grow + compact-when-empty.
- **Message-in / #9** (`send_to_session` / `read_session`) — prefill+confirm into a running tile, autoSend path, and the "session isn't open in the cockpit" message. Watch matching by `discoveredSessionId` for `new` tiles.
- **Drag-to-reorder** (`bd162c1`) — PTY survives a reorder (verified); watch real multi-tile reorders and that order persists across a restart.
- **CodexSource / #11** (`d7b0e22` + lastTs fix `+ index v3`) — cross-vendor results, CODEX chip, guarded resume paths. Recency now uses file mtime for long sessions. ⚠️ **Known gap to watch:** the 40k-char doc cap fills from the file START, so **long Codex rollouts only index their opening** — late-session content isn't searchable until semantic/FTS lands (the vector-search item). Same limitation applies to long Claude sessions.
- **Docked notepad** (`9a7ff6b`) — 📓 toggles a notepad inside the tile; type prose, autosave + Ctrl+S, edit/preview; the agent's edits to the file sync in without clobbering unsaved text; "📎 → chat" path hand-off; **persists across resume** (write, close the tile, re-resume → same draft returns). ⚠️ Watch: per-conversation file keying for `new` tiles (keyed by tile id, not yet discoveredSessionId — a brand-new conversation gets a fresh notepad each spawn, which is fine; re-resume of a saved one is the case that must persist).
- **Context-window meter** (`3433d40`) — confirm the bar/% tracks real context growth and the color ramp/tooltip read right; check 1M-context models show `/1M`.
- **Prior batch still needing live confirm** — session **auto-restore** on reopen, reconnect-after-sleep, double-Ctrl+C warning, tab attention. *(Ctrl+C/V copy-paste and Stats integration already confirmed live by the user.)*

### 🐞 To investigate
- **Phantom conversation count** *(reported 2026-06-25)* — cockpit reported **2 cldctrl + 1 physiometrics** conversations but only 1 cldctrl tile was visible (a 2nd was open last night, then minimized/closed). Likely the **active-session count** (mtime-detected recent JSONLs in the 5h window) ≠ **open cockpit tiles** — so a detected-but-not-open session inflates the count, OR a stale tile persisted in the `cldctrl.session.v1` restore without rendering. Check: (1) where the "2" is sourced (active-sessions badge vs conversation list vs tile count); (2) whether the count includes sessions with no tile; (3) restore dedup. Need: a clear distinction between "conversations detected" and "tiles open", and a way to surface/open a detected-but-closed conversation rather than silently counting it.

---

## 🟠 Tracked features (GitHub issues)
Recommended build order: **#11 → #10 → #9 → #12**.

- **[#9] Verify launched-session kickoff + message-into-running-session** — read back a launched session's opening turns to confirm it got the prompt; inject a follow-up into a running session. (Primitive that #10 builds on.)
- **[#10] Cross-project coordination (driver model)** — one conversation drives: reads another project, dispatches a change (inject into a running cockpit tile **prefill+confirm**, or launch a coordinated session), and verifies. Optional shared coordination-task thread.
- **[#11] Vendor-neutral conversation index** — read Codex (then Gemini) sessions into cldctrl search so it spans Claude+Codex; reverse is ~free (search is an MCP tool Codex already has). *First slice = `CodexSource` + unified index. Codex's own schema corrections are on the issue.* **← recommended next build.**
- **[#12] Continuous decaying working memory** — daemon distills convos into tiered, time-decaying global + per-project memory that seeds new sessions (prefill+confirm). **Hardest/experimental — do last; start with a dumb per-project recap v0.** (Human-memory design lens captured on the issue.)

---

## 📋 Backlog — Cockpit / Web UX (parked; not yet issues)
- **Multi-monitor / extended cockpit (pop-out windows)** — split the cockpit across screens: pop a filtered subset of tiles into a second window and drag it to another monitor (e.g. overflow conversations → an "extended cockpit"). ENABLER (already true): PTYs live SERVER-SIDE in the named-terminal registry (replay buffer + multi-client), so windows are just *views* that attach by tile id — tiles can split/duplicate across windows without losing state. Phases: **v1** pop-out a filtered window (reuse focus-chip filtering; per-window tile set via `?tiles=…`/window id; works in any browser, drag to monitor 2; app-mode = feels like a 2nd app); **v2** auto-place via the **Window Management API** (`getScreenDetails()`, Chrome, "Move to other screen" button, fallback to manual drag); **v3** native multi-window in the **Tauri** app (positioned/remembered per monitor). Needs per-window scoping of the `cldctrl.session.v1` restore (primary + named popouts).
- **Promote Stats to a top-level destination** — *(user-requested 2026-06-25: "move the stats thing out of the cockpit … probably not there")*. Usage stats are account-GLOBAL but are currently a sub-tab of the Cockpit, so they only appear on the Conversations pane + Cockpit view (hidden in List view, project detail, and search — NOT gated on tiles, but feels conversation-dependent). Quick fix: a **"Stats" button in the top bar** reachable from anywhere. Cleaner: make Stats its own top-level view/route (sibling of Conversations/Detail). `#stats` overlay already exists; just needs a view flag independent of `cockpit.tab`.
- **Stats: precompute once, toggle instantly** — *(user-requested 2026-06-25: switching 24h/3d/7d/30d is slow)*. Range toggles appear to recompute/refetch each time. Compute the full series once (widest range) and slice/aggregate client-side per range, or cache per-range results so re-selecting is instant. Investigate `web/stats.ts` + the `/api/stats` path; confirm whether the cost is server recompute or client re-render.
- **Figure lightbox → near-fullscreen zoom** — *(user-requested 2026-06-25)*. The Stats image lightbox works; make clicking any figure pop it up LARGE (≈90% viewport, not edge-to-edge) with a dimmed backdrop + click/Esc to close. Extend the existing lightbox in the Stats/cockpit image viewer.
- **Compose-box overlay** — a real textarea above the terminal for full editing + **spellcheck** + paste, sends to the PTY on Enter. Fixes "can't click-to-edit" and "no spellcheck" together (terminal limitations).
- **Drag-to-reorder** cockpit tiles + **tile resize/span** (extend a tile into an empty grid cell).
- ✅ **DONE — Scratchpad ↔ conversation pairing** — shipped as the **docked notepad** (`9a7ff6b`): keyed per conversation, reopens on resume.
- **Live/active-sessions list → into the sidebar** (the "conversations tab = all cockpit" other half).
- **Embedded images in agent output** — show images the agent is referencing/creating inline.
- **CTRL visual-bug-report** — capture screenshot + console → CTRL drafts a GitHub issue (draft → confirm → `gh`).
- **Subagent-tree visualization** — live tree of subagents a project spawned (from JSONL `isSidechain`/`parentUuid` + Task blocks).
- **AI-sharpened session titles** — on-demand concise title via the summarizer.
- **Per-tile diff viewer** + **preview pane** (embedded browser for a running app/HTML/PDF).

## 📋 Backlog — Pre-release packaging / zero-config hardening
- **Make `node-pty` an `optionalDependency`** (currently a hard dep). It's native (needs a matching prebuild or a C++/Python toolchain); a failed build can abort the WHOLE `npm i -g cldctrl` even for TUI-only users. `serve.ts` already lazy-`require`s it in try/catch, so the app degrades cleanly — moving it to optional protects the single-command install. Surface a clear "live terminals unavailable (node-pty not installed)" message in the cockpit when missing.
- **Verify `prepublishOnly` ships the web bundle** — confirm `npm run build` (tsup + build-web onSuccess) reliably emits `dist/web/app.js`+`app.css` before publish (it's in `files` via `dist`). Add a quick publish-time check.
- **Zero-config first-run is a HARD principle** — `cc` auto-discovers `~/.claude/projects`; `cc serve` just works; welcome wizard detects claude/git/gh; hotkey + daemon stay opt-in (`cc setup`). Only prerequisite = Claude Code installed (state plainly in install docs). Keep it this way.
- Reconsider the `postinstall` console tip (some CI/security setups block install scripts; harmless but optional).

## 📋 Backlog — Setup / Config
- **Desktop / taskbar launcher → launch in APP MODE** — a `.lnk`/taskbar pin that opens the dashboard as a **chromeless standalone window** via `chrome --app=http://localhost:<port>` (or `msedge --app=`), plus a **web app manifest (PWA)** so it's "Install"-able as an app with the cldctrl favicon. Reuses the installed browser, zero bundling, gives the native-app feel. Extend `cc setup` / `setup-windows.ts` (macOS/Linux variants too).
  - App mode = the browser with ALL chrome stripped (no tabs/omnibox/bookmarks/extensions), just content + a thin OS title bar + its own taskbar icon (the favicon). Same engine, browser UI hidden. Command: `chrome --app=http://localhost:<port>` / `msedge --app=…`; `--user-data-dir` to isolate profile (trade-off: loses shared logins/extensions).
- **True standalone app (keep as a first-class option, not just for distribution)** — a **Tauri** shell wrapping the localhost UI. NOTE: Tauri uses the OS's NATIVE webview, which is a different engine per platform — **WebView2/Chromium on Windows, WKWebView/WebKit on macOS, WebKitGTK on Linux** — so it does NOT give one engine everywhere; Safari-class WebKit gaps reappear on mac/Linux. (Only Electron gives one Chromium everywhere, but it bundles ~100MB+ — rejected.) Tauri's real win for our gaps: **native plugins for clipboard / TTS / global shortcuts** bypass browser API restrictions, so the gated features can be solved natively inside the app. Bigger lift (Rust toolchain, packaging, code-signing, auto-update) → it's the polished DISTRIBUTION endpoint; app-mode/PWA is the cheap interim.
- **Cross-browser feature parity** — NOT a substitute for Tauri; they're complementary (Tauri = controlled desktop runtime; parity = the zero-install "open in any browser" path, which we keep). Cheap graceful fallbacks where Chrome-only APIs degrade — and these ALSO help Tauri-on-WebKit (mac/Linux): **clipboard paste** (`navigator.clipboard.readText` blocked in Firefox → paste-target textarea / native paste), **Web Speech** read-aloud (absent/spotty Firefox; partial Safari → feature-detect + hide controls), **Media Session** hands-free keys (Chromium-only → degrade silently). Document the support matrix; never hard-fail on a missing API. Near-term (Windows + Chrome) neither is urgent — app mode already covers it.
- **Make web the primary surface** — default the launch/hotkey to `web`; keep the **TUI as a frozen minimal fallback** (SSH/headless/quick-glance) but stop investing in it (two front-ends = double skin maintenance). Browser compat: works in any modern browser; **Chromium (Chrome/Edge) is best** — `clipboard.readText` (Ctrl+V paste), Web Speech (read-aloud), and Media Session (hands-free) are Chromium-strongest; Firefox/Safari work with minor gaps.
- **Tool-permissions GUI** — edit Claude Code's allow/ask/deny lists in-app (global + per-project `settings.local.json`); templates ("read-only", "full-auto"); confirm-before-write.

## 📋 Backlog — Memory & the vendor-neutral brain
Three-tier model (cldctrl as the orchestration layer, exposed to any agent via MCP):
- **(L) Long-term recall — BUILT** (keyword `search_conversations`; cross-vendor via #11).
- **(S) Semantic / vector search — TODO.** Embeddings over the conversation corpus for fuzzy recall. Evaluate **mem0 / Zep / txtai / LanceDB / Chroma** (and claude-vault for FTS5). **Leading candidate: graft claude-mem's generic core (SQLite+FTS5 + ChromaDB + MCP/HTTP retrieval) — see "Integration plan" below.**
- **(W) Working memory that doesn't pollute context — TODO** (= #12). Relevance-gated retrieval (top-k for the task) vs auto-injecting everything; prior art: MemGPT/Letta, Generative Agents memory stream.
- **"Hermes" memory agent — identified.** The tool is **claude-mem** ([thedotmack/claude-mem](https://github.com/thedotmack/claude-mem), AGPL-3.0); the "frozen-snapshot derived from Hermes" framing comes from the AgentOS writeups ([Geeky Gadgets](https://www.geeky-gadgets.com/claude-code-agentos-memory-upgrade/)). See the integration plan below.
- **`originSessionId` back-links** from memory files (search issue #2 item 4).
- **Multi-agent council (layer 3)** — Claude drafts → Codex critiques → Claude revises, orchestrated by the control plane (layers 1–2 done: vendor-neutral terminals + `consult_agent`).
- **Agent-spawn-with-context** — wire "narrow a search → spawn a session seeded with that topic + a goal" (bridge tools exist).

### Integration plan — graft claude-mem's generic core + per-agent adapters + eval harness
The goal is a **vendor-neutral memory layer** (the moat), not another Claude-only plugin. claude-mem
is structurally ideal: it's a *thin Claude-Code integration shell over a thick generic core*, and the
core's retrieval surface is **already MCP + HTTP** — the exact seam we need. License is **AGPL-3.0,
same as cldctrl**, so we can fork/vendor cleanly. ([architecture overview](https://docs.claude-mem.ai/architecture/overview), [Augment Code writeup](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code))

**Coupling map (decides what we reuse vs. rebuild):**

| Layer | Claude-specific? | Plan |
|---|---|---|
| Capture (hooks: SessionStart, PreToolUse-Read, PostToolUse, Stop) | ✅ | **rebuild** as per-agent adapter (cldctrl owns session launch/drive) |
| Compression (Anthropic Agent SDK summarizer) | ✅ | **abstract** — one pluggable summarizer model, decoupled from the *driven* agent |
| Injection (SessionStart context API) | ✅ | **rebuild** as inject-at-launch per agent (cldctrl controls the launch cmd) |
| Storage (SQLite + FTS5) | ❌ generic | **vendor as-is** |
| Vectors (ChromaDB) | ❌ generic | **vendor as-is** |
| Retrieval (HTTP API + MCP server, port 37777) | ❌ generic | **vendor as-is** — already works for any MCP agent |
| Viewer UI | ❌ generic | optional; we have the cockpit |

**Why it fits the neutral-controller goal:** retrieval is *already* LLM-neutral — Codex CLI and Gemini
CLI both speak MCP, so they query the same store unchanged. Only capture + injection are per-agent, and
those are exactly the layer cldctrl already owns (`launch_session`, `send_to_session`, `read_session`,
dashboard bridge). **Neutral retrieval ships first/easily; neutral capture rolls out agent-by-agent**
(Claude hooks → Codex → Gemini), with JSONL-tailing as the fallback capture path where an agent's hook
ecosystem is thin (we already index `~/.codex/sessions` rollouts for #11).

**Sequencing (fits the existing #11→#10→#9→#12 order):**
1. Vendor the generic core (SQLite+FTS5 + ChromaDB + retrieval MCP/HTTP); wire behind cldctrl's existing `search_conversations`/MCP so it's usable from any agent. Pairs with **#11** (Codex already in the unified corpus to embed).
2. Pluggable summarizer (drop the hard Anthropic-SDK dependency on non-Claude paths).
3. Per-agent capture adapter: Claude hooks first, then Codex/Gemini; JSONL-tail fallback. Ties to **#12 working memory**.
4. Inject-at-launch adapter (relevance-gated top-k, prefill+confirm — not auto-inject-everything; reuses the #9 `send_to_session` confirm surface).

**Keep, don't replace, the markdown-git memory.** Current `MEMORY.md` + per-fact files are *curated,
human-readable truth* and the thing the eval audits; claude-mem is *auto-captured observations*. Use the
vector layer to index/retrieve over **both**.

**Memory-eval harness (the differentiator — agent-neutral, the part nobody else has built):**
- **Faithfulness/staleness audit** — parse each memory file into discrete claims; a fresh agent verifies each against the live repo (codeindex/grep/read as ground truth) → ✅confirmed / ⚠️stale / ❌wrong / 🤷unverifiable + evidence. Tractable; **start here.** Surface verdicts in the dashboard with re-verify/update/delete actions (a daemon "memory health" job).
- **Lift eval** — run representative tasks cold (no memory) vs. warm (memory injected); memory earns its place only when warm beats cold. Anchor on tasks with checkable outcomes (LLM-judged "usefulness" is noisy).

**Caveats:** (1) capture fidelity varies per agent — MCP retrieval is uniform, auto-capture is uneven; (2) AGPL graft is fine (we're AGPL) but makes the obligation explicit; (3) two memory systems coexist by design — don't merge blindly.

**Sources:** [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) · [architecture overview](https://docs.claude-mem.ai/architecture/overview) · [Augment Code writeup](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code) · [hybrid memory: storage/injection/recall](https://www.mindstudio.ai/blog/hybrid-ai-memory-system-claude-code-storage-injection-recall) · [AgentOS/Hermes framing](https://www.geeky-gadgets.com/claude-code-agentos-memory-upgrade/) · alternatives: [mem0 self-hosted MCP](https://dev.to/n3rdh4ck3r/how-to-give-claude-code-persistent-memory-with-a-self-hosted-mem0-mcp-server-h68), [Memory Vault (Postgres+pgvector)](https://www.makeuseof.com/fixed-claudes-memory-problem-postgres-database-changed-everything/)

---

## 🛠 Build strategy — parallel worktrees + dogfooding the orchestrator
Idea: build the backlog using git-worktree isolation + parallel agents, AND use it to test an orchestrator layer driving separate conversations (cldctrl builds cldctrl).
- **Parallelize only file-DISJOINT, well-specified, independently-verifiable tasks.** Most cockpit/web items edit the SAME hot files (`web/cockpit.ts`, `main.ts`, `views.ts`, `store.ts`, `app.css`, `serve.ts`) → naive fan-out = merge conflicts. Good parallel candidates: **#11 CodexSource** (core/), **desktop launcher** (setup-windows.ts), packaging/docs. Keep web-UI-heavy items (compose-box, multi-monitor, top-level Stats, drag-reorder) SEQUENTIAL.
- **The worktree merge-after flow matters** (already backlogged) — it's what makes parallel sane; have it before fanning out widely.
- **Chicken-and-egg for the orchestrator test:** the orchestrator = #9/#10 (message-into-session, read-back/verify, driver model) — NOT built yet. Today only a SEMI-manual version is possible (existing: createWorktree + cockpit "isolated worktree" new-session, launch_session, consult_agent, control-plane chat). Clean sequence: **build #9→#10 first, then use them to drive parallel worktree builds of the disjoint backlog** — ships features AND validates the orchestrator on real work.
- **Costs:** token cost scales with N agents; for a solo dev the per-branch REVIEW burden can eat the speedup unless tasks are well-isolated. **Start small** — a 2–3 task parallel experiment on truly independent slices to learn the worktree + merge-after workflow before scaling.
- **Unattended/overnight runs — pull the isolation, don't build it.** For "set a task list, skip approvals, review in the morning," the isolation layer is solved open-source; don't reinvent it. Options by threat model: running OUR OWN trusted repo → **git worktree + `--dangerously-skip-permissions`** (fast, local, real E2E testing) or Anthropic's reference **`.devcontainer`** (firewall + non-root, built for unattended skip-permissions); running UNTRUSTED code → a microVM (**E2B**, Firecracker) — a container can't stop a malicious project exfiltrating creds *inside* it. We have the **Cloudflare `sandbox-sdk`** skill on hand too. The differentiated cldctrl piece is NOT the cage — it's the **queue + verify-gate (`tsc`/`tsup`/smoke + Chrome UI pass on the cockpit) + morning report in the dashboard.** UI/UX review works well on the **web cockpit** via Claude-in-Chrome (clicks, screenshots, console/network); the **Ink TUI** is snapshot-only. Sources: [Claude Code devcontainer docs](https://code.claude.com/docs/en/devcontainer) · [skip-permissions safety contradiction (#19978)](https://github.com/anthropics/claude-code/issues/19978) · [sandbox roundup](https://blaxel.ai/blog/code-execution-sandboxes-for-ai-agents) · [unlimited-session microVMs (Northflank)](https://northflank.com/blog/best-code-execution-sandbox-for-ai-agents).

## 🧭 Direction / strategic notes (not tasks, but steer priorities)
- **Moat = the brain, not the skin.** Anthropic/OpenAI ship first-party apps (parallel sessions, worktrees, diff/preview); don't compete on UI polish. Invest in cross-project orchestration, cross-vendor memory/search, and data-stays-local — things they structurally won't build.
- **Wedge audience:** power users juggling many projects across multiple AI CLIs, and people whose first-party GUI is blocked/unavailable.
- **Rebrand (pre-launch, low priority):** "CLD CTRL" reads as *Claude* Control, which fights the vendor-neutral story. Decide before public launch — rename to a pronounceable vendor-neutral name **or** re-interpret "CLD" as Cloud/Coding. Keep `cc` as the command.
- **Analytics:** opt-out/disclosure still deferred; version-check-shaped request not built.

See also `NEEDED-UPGRADES.md` (the original create_project gap, now done) and `PROJECT-MODEL.md`.
