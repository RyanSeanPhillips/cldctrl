# CLD CTRL — Roadmap & Backlog

A living list of shipped work, tracked features, and parked ideas so nothing gets
lost. Big items are also tracked as GitHub issues (linked). Last updated **2026-06-24**.

> Strategic throughline (see "Direction" at the bottom): the skin (terminals/UI) is
> table-stakes that the first parties commoditize; the **moat is the cross-project,
> cross-vendor, local "brain"** (orchestration + memory + search across Claude/Codex/
> Gemini). Bias new work toward the brain; treat terminal-hosting as plumbing.

---

## ▶ Suggested next sequence
0. **Restart `cc serve` + refresh, then smoke-test the shipped work first** — especially the terminal-touching changes (Ctrl+C/V, clickable paths, reconnect-after-sleep, double-Ctrl+C warning, tab attention) and the Stats tab. Fix any regressions before building on top.
1. **1–2 friction-removing easy wins — be selective, don't grind skin.** The **compose-box** is the standout (kills real daily friction: editing + spellcheck + paste in the chat); drag-reorder/resize if quick. Most other cockpit polish is skin the first parties commoditize — do only what removes your own daily friction (you're the dogfood loop).
2. **[#11] CodexSource → unified search — the keystone.** It's simultaneously *better memory* (cross-vendor long-term recall) **and** the *first real Codex integration*, so it covers two goals at once and is the substrate for everything below. Deterministic, independently valuable.
3. **Vector/semantic search** over that unified corpus (memory tier S).
4. **[#10]/[#9] conversation-interaction wiring** — driver-model coordination + read-back/inject.
5. **[#12] working memory** — last; experimental; start with the dumb per-project recap v0.

---

## ✅ Recently shipped (June 2026)
- **Cockpit Stats tab** — token usage by 5h block + 7-day cumulative (2nd axis), per-turn billed, context-per-conversation with 1M reference lines, cache-miss (eviction vs reload) timeline, tool-result context, MCP/agent tables, live usage strip, clickable image lightbox; 24h/3d/7d/30d range.
- **Per-project focus chips** + **default-to-cockpit** + "New in cockpit"; re-resume focuses the existing tile.
- **Auto-reconnect** cockpit tiles after sleep/idle-kill.
- **Terminal**: light-theme contrast fix (`minimumContrastRatio`), **Ctrl+C copy / Ctrl+V paste**, **double-Ctrl+C exit warning**, **clickable file paths** (→ open in VS Code / reveal in Explorer).
- **Branded favicon** (orange ⌃ tile) + **tab attention** (flash title + badge favicon when a conversation needs input while you're on another tab).
- **Launch-queue** fix (cockpit-launch was a single slot that could clobber; now a queue).
- **#8 fixed/closed** — `launch_session` no longer truncates multi-word prompts (Windows `cmd /c` quoting → temp `.bat`).

---

## 🟠 Tracked features (GitHub issues)
Recommended build order: **#11 → #10 → #9 → #12**.

- **[#9] Verify launched-session kickoff + message-into-running-session** — read back a launched session's opening turns to confirm it got the prompt; inject a follow-up into a running session. (Primitive that #10 builds on.)
- **[#10] Cross-project coordination (driver model)** — one conversation drives: reads another project, dispatches a change (inject into a running cockpit tile **prefill+confirm**, or launch a coordinated session), and verifies. Optional shared coordination-task thread.
- **[#11] Vendor-neutral conversation index** — read Codex (then Gemini) sessions into cldctrl search so it spans Claude+Codex; reverse is ~free (search is an MCP tool Codex already has). *First slice = `CodexSource` + unified index. Codex's own schema corrections are on the issue.* **← recommended next build.**
- **[#12] Continuous decaying working memory** — daemon distills convos into tiered, time-decaying global + per-project memory that seeds new sessions (prefill+confirm). **Hardest/experimental — do last; start with a dumb per-project recap v0.** (Human-memory design lens captured on the issue.)

---

## 📋 Backlog — Cockpit / Web UX (parked; not yet issues)
- **Compose-box overlay** — a real textarea above the terminal for full editing + **spellcheck** + paste, sends to the PTY on Enter. Fixes "can't click-to-edit" and "no spellcheck" together (terminal limitations).
- **Drag-to-reorder** cockpit tiles + **tile resize/span** (extend a tile into an empty grid cell).
- **Scratchpad ↔ conversation pairing** — auto-reopen a chat's scratchpad on resume.
- **Live/active-sessions list → into the sidebar** (the "conversations tab = all cockpit" other half).
- **Embedded images in agent output** — show images the agent is referencing/creating inline.
- **CTRL visual-bug-report** — capture screenshot + console → CTRL drafts a GitHub issue (draft → confirm → `gh`).
- **Subagent-tree visualization** — live tree of subagents a project spawned (from JSONL `isSidechain`/`parentUuid` + Task blocks).
- **AI-sharpened session titles** — on-demand concise title via the summarizer.
- **Per-tile diff viewer** + **preview pane** (embedded browser for a running app/HTML/PDF).

## 📋 Backlog — Setup / Config
- **Desktop / taskbar launcher → launch in APP MODE** — a `.lnk`/taskbar pin that opens the dashboard as a **chromeless standalone window** via `chrome --app=http://localhost:<port>` (or `msedge --app=`), plus a **web app manifest (PWA)** so it's "Install"-able as an app with the cldctrl favicon. Reuses the installed browser, zero bundling, gives the native-app feel. Extend `cc setup` / `setup-windows.ts` (macOS/Linux variants too).
  - App mode = the browser with ALL chrome stripped (no tabs/omnibox/bookmarks/extensions), just content + a thin OS title bar + its own taskbar icon (the favicon). Same engine, browser UI hidden. Command: `chrome --app=http://localhost:<port>` / `msedge --app=…`; `--user-data-dir` to isolate profile (trade-off: loses shared logins/extensions).
- **True standalone app (keep as a first-class option, not just for distribution)** — a **Tauri** shell (native WebView2/WKWebView, few-MB binary, no browser dependency) wrapping the localhost UI. The user wants the real-app feel available, not only the app-mode hack. Avoid Electron (bundles Chromium, ~100MB+ — too heavy). App-mode/PWA is the cheap interim; Tauri is the polished endpoint.
- **Cross-browser feature parity** — make it fully usable beyond Chromium. Add graceful fallbacks where Chrome-only APIs degrade: **clipboard paste** (`navigator.clipboard.readText` is blocked in Firefox → fall back to a paste-target textarea / the terminal's native paste), **Web Speech** read-aloud (absent/spotty in Firefox; partial in Safari → feature-detect + hide controls), **Media Session** hands-free keys (Chromium-only → degrade silently). Document the support matrix and never hard-fail on a missing API.
- **Make web the primary surface** — default the launch/hotkey to `web`; keep the **TUI as a frozen minimal fallback** (SSH/headless/quick-glance) but stop investing in it (two front-ends = double skin maintenance). Browser compat: works in any modern browser; **Chromium (Chrome/Edge) is best** — `clipboard.readText` (Ctrl+V paste), Web Speech (read-aloud), and Media Session (hands-free) are Chromium-strongest; Firefox/Safari work with minor gaps.
- **Tool-permissions GUI** — edit Claude Code's allow/ask/deny lists in-app (global + per-project `settings.local.json`); templates ("read-only", "full-auto"); confirm-before-write.

## 📋 Backlog — Memory & the vendor-neutral brain
Three-tier model (cldctrl as the orchestration layer, exposed to any agent via MCP):
- **(L) Long-term recall — BUILT** (keyword `search_conversations`; cross-vendor via #11).
- **(S) Semantic / vector search — TODO.** Embeddings over the conversation corpus for fuzzy recall. Evaluate **mem0 / Zep / txtai / LanceDB / Chroma** (and claude-vault for FTS5).
- **(W) Working memory that doesn't pollute context — TODO** (= #12). Relevance-gated retrieval (top-k for the task) vs auto-injecting everything; prior art: MemGPT/Letta, Generative Agents memory stream.
- **"Hermes" memory agent** — identify the specific tool the user saw, then evaluate fit.
- **`originSessionId` back-links** from memory files (search issue #2 item 4).
- **Multi-agent council (layer 3)** — Claude drafts → Codex critiques → Claude revises, orchestrated by the control plane (layers 1–2 done: vendor-neutral terminals + `consult_agent`).
- **Agent-spawn-with-context** — wire "narrow a search → spawn a session seeded with that topic + a goal" (bridge tools exist).

---

## 🧭 Direction / strategic notes (not tasks, but steer priorities)
- **Moat = the brain, not the skin.** Anthropic/OpenAI ship first-party apps (parallel sessions, worktrees, diff/preview); don't compete on UI polish. Invest in cross-project orchestration, cross-vendor memory/search, and data-stays-local — things they structurally won't build.
- **Wedge audience:** power users juggling many projects across multiple AI CLIs, and people whose first-party GUI is blocked/unavailable.
- **Rebrand (pre-launch, low priority):** "CLD CTRL" reads as *Claude* Control, which fights the vendor-neutral story. Decide before public launch — rename to a pronounceable vendor-neutral name **or** re-interpret "CLD" as Cloud/Coding. Keep `cc` as the command.
- **Analytics:** opt-out/disclosure still deferred; version-check-shaped request not built.

See also `NEEDED-UPGRADES.md` (the original create_project gap, now done) and `PROJECT-MODEL.md`.
