# CLD CTRL — Roadmap & Backlog

A living list of shipped work, tracked features, and parked ideas so nothing gets
lost. Big items are also tracked as GitHub issues (linked). Last updated **2026-07-17**
(strategic refresh — folds in a Codex step-back review; see "Direction" at the bottom).

> **Strategic throughline (sharpened 2026-07-17).** The skin (terminals/UI) is
> table-stakes the first parties commoditize. The moat is the cross-project,
> cross-vendor local **brain** — but "brain" is NOT "a searchable pile of
> transcripts." The product is a **trustworthy continuity + delegation layer**:
> it knows what happened, what's still true, what should happen next, and whether
> delegated work actually finished. Bias new work toward *verified continuity
> across agents*; treat terminal-hosting as plumbing.
>
> **The switching wedge (make this the demo, the homepage, the benchmark):**
> *"Codex implemented this three weeks after Claude designed it — CLD CTRL
> retrieved the decision, supplied only the relevant context, dispatched the work
> in the correct worktree, and showed the tests and diff when it finished."* That
> closed loop is something first parties structurally won't build. Everything
> that doesn't serve it is dilution.

---

## ▶ Suggested next sequence (reconciled 2026-07-17 from a Codex + Claude review)

Both reviews agree the DIRECTION is verified continuity + delegation over
searchable transcripts. They disagreed on build order, and the code-grounded
review (Claude, having read `handoff.ts`/`vector-index.ts`/`types.ts`) wins it:
the wedge is **~80% already built**, the "outcome ledger" is weeks of speculative
precompute that re-introduces the staleness trap, and the whole thesis is
**settleable in a week with a mechanical test**. So — cheapest-credible-first,
prove the thesis before investing behind it:

0. **Land the restart-lifecycle arc + close #13/#15.** Merge after the real-server
   acceptance test; verify + close. Cheap, clears the decks. *(In flight.)*
0.5 **Instrument your own dogfooding (a day).** You run this session inside a
   cockpit tile — measure whether YOU actually reach for the already-shipped
   `search_conversations` + handoff-slice-1 this week. If you don't reach for them,
   no ledger will change that. Cheapest experiment in the whole plan.
1. **The `verify()` primitive — build ONCE, reuse everywhere.**
   `verify(claim | task, repo) → { pass | fail, evidence }`, held to
   **mechanically-checkable facts only**: the git diff exists, `tsc`/tests pass, the
   files a brief named got touched, a read-back matches the stated git state. **No
   LLM grading an LLM** — that's an unfalsifiable green-check regress. Handoff, jobs,
   and the memory-audit all consume this ONE primitive (both reviews scattered
   verification across #9/#10/#12 — it's a single reusable thing).
2. **Handoff v2 as a closed loop — the cheapest credible wedge (days, not weeks).**
   On top of the existing `buildHandoffBrief` (already assembles goal + git state +
   touched files + recent commits + notepad + transcript tail into a capped,
   inspectable pack): (a) expose it as an edit-before-send preview in the ⇄ flow;
   (b) the receiving agent's first action is a structured read-back; (c) cldctrl
   mechanically diffs the read-back + post-work state against the brief via
   `verify()` → ✅/⚠️. THAT is the wedge loop: "Claude designed it, Codex picked it
   up, cldctrl supplied the context and confirmed the handoff landed."
3. **The 1-week thesis test (decides everything below).** Take 5 real Claude→Codex
   handoffs from your own history; for each, build the pack, dispatch, apply ONE
   mechanical gate — did the receiver touch the named files, does `tsc` + tests pass
   afterward? If pass/fail is informative on those 5, "verified continuity" is a real
   moat and the ledger/jobs investment is justified. If you find yourself wanting an
   LLM to grade "did it capture the intent," you've hit the boundary — scope
   `verified` down to what git + the test runner prove, and stop there.
4. **Faithfulness/staleness audit (the cheap truth-instrument).** Parse memory/notes
   into discrete claims; `verify()` each against the live repo → ✅/⚠️/❌/🤷 + evidence;
   surface in the dashboard. Run it BEFORE building any derived-memory layer — it's
   the instrument that tells you whether derived memory helps at all. *(Currently
   mis-filed in the memory backlog; it's actually a lead item.)*
5. **Release hardening around the privileged local control plane.** Threat-model +
   test browser→localhost→PTY access, first-run, migrations, recovery, uninstall,
   packaging. See **🚀 Release readiness** — the biggest risk lives here.

**DEFERRED behind the 1-week test — do NOT build speculatively:**
- **Outcome "ledger."** An outcome is a *lossy summary of a transcript*; the
  transcript is the thing that's never wrong. A precomputed durable ledger drifts
  from source the instant the repo changes — the exact staleness trap #12 warns of,
  plus a token tax proportional to corpus size (120+ sessions re-extracted as they
  change). Right shape: transcripts + provenance retrieval stay canonical; an
  "outcome" is an **on-demand VIEW over the top-k retrieved passages per query**, not
  a table to reconcile. Build only if the wedge proves it earns its keep.
- **#10 driver JOB STATE MACHINE.** A 7-state FSM is premature formalization for zero
  concurrent users; `types.ts` already has pending|in_progress|done — the enum was
  never the hard part. The value is the one word "verified," which #1 delivers. Defer
  the framework; build the primitive.
- **#12 continuous memory.** Only after the audit + trust controls exist and a
  lift-eval shows warm (memory injected) beats cold on checkable tasks.

---

## ✅ Recently shipped

### July 2026
- **Dashboard restart-lifecycle arc** *(this week — on `linux-compat`/`restart-lifecycle`, not yet on master; pending real-server acceptance test).* `cc stop` + `cc restart` (supervised: stop → wait for port quiet → spawn successor → poll `/api/id` for a *different* instanceId). Hardened **server identity** (`/api/id` + `product` marker) so a probe POSITIVELY confirms ours before any destructive stop/kill — a foreign 200-JSON service is never killed; legacy pre-marker servers still recognized by overview shape. **Disk-persisted tile sessions** so a restart RESUMES a 'new' tile's conversation instead of forking it (force-discovery at shutdown → capture → consult on reconnect). **Browser auto-reload** on server-instance change (overlay + recovery, no reload-loop, no stale bundle). **Build-manifest "restart to load" pill** (content-hash, atomic, deterministic). **⏻ power menu** (Restart / Stop with truthful session counts). Reviewed on 3 axes (correctness/spec/standards); 41/41 E2E. **Plausibly closes #13 + #15.**
- **Linux compat (PR #18, merged)** — terminal-launch args fixed for wezterm/foot/xfce4-terminal (centralized `linuxTerminalArgs`), `/api/reveal` Windows-guarded, on-demand `.desktop`+icon install for the app-mode taskbar icon. Reviewed; latch-on-failure bug fixed. *Advances #16.*
- **App-mode is now the PRIMARY surface** — bare `cc` opens a chromeless Chrome `--app` dashboard window; `cc --tui` is the fallback; `cc web`/`--open` for a normal tab. First-run setup. Pop-out conversation windows (tile → own OS window, same server-side PTY, notepad travels).
- **Multi-vendor** — Codex + Antigravity conversations in the sidebar (⬡/✦ chips, known-project gated) with per-vendor resume routing (Codex `resume`, Antigravity `--conversation`); Codex usage row + tokens-by-vendor in Stats + Codex rate limit; Antigravity reader via built-in `node:sqlite`. Vendor-neutral search spans Claude + Codex.
- **Agent handoff (slice 1)** — build a handoff brief from on-disk state (works when the outgoing agent is DEAD); ⇄ opens a sibling tile prefilled + backlinked.
- **Docked per-conversation notepad**, read-aloud **karaoke** highlighting (word+passage, skips citations/math), **KaTeX/LaTeX** in notepad previews + a convert/copy/merge pipeline (`convert_to_latex` MCP tool).
- **Semantic search tier-0** — query-time re-rank via local transformers.js all-MiniLM (enabled + verified).
- **Server idle-exit + PTY orphan sweep**, titlebar theme-color pre-paint + live title/favicon badge, usage-% FROZEN bug fixed (re-probe past TTL), pre-release packaging checks (`check-publish.mjs`).

### June 2026 (condensed)
- Threaded `consult_agent` (multi-turn Codex/Claude council, half 1). Docked notepad. Per-conversation context-window meter. Vendor-neutral search — Codex CLI indexed (#11 phase 1). Compose-box. Message-in primitive (#9 partial: `send_to_session`/`read_session`). Drag-to-reorder tiles. Cockpit Stats tab. Per-project focus chips + default-to-cockpit. Auto-reconnect after sleep. Terminal Ctrl+C/V, clickable file paths. Branded favicon + tab attention. #8 fixed (multi-word prompt quoting). Stats KPI light-theme fix.

---

## 🚀 Release readiness (NEW — surfaced by the 2026-07-17 review)

**The core is already proven** — the primary user finds it essential daily (project
management + re-entry). So this list is NOT "is the tool good?" — it's "does a
STRANGER's first 10 minutes and the trust story hold up?" That's a much shorter,
more shippable gate than the reviews implied. The likely true blockers are just:
**(1) accurate README/positioning, (2) a security once-over of the localhost
control plane, (3) verified clean install + uninstall on a fresh machine (esp.
non-Windows).** The rest can follow a v0.x launch.

**Minimum bar:** a new user on Windows/macOS/Linux can install, auto-discover
existing Claude/Codex history, open+resume a session, **restart without
duplication or context replay**, search across vendors, and **fully uninstall
without manual repair**. Plus:

- [ ] **Positioning/docs are STALE** — README, screenshots, `package.json`
  description/keywords still present a Claude-focused TUI, while app-mode +
  multi-vendor are the real identity. Align name, README, first-run flow,
  supported-platform matrix, and a clear stable/experimental/vendor-dependent
  split. *Highest-urgency release blocker.*
- [ ] **Security review of the whole privileged control plane** — every localhost
  endpoint, WebSocket, CSRF boundary, file-open/reveal path, PTY input route, MCP
  mutation. (The restart-lifecycle endpoints were just reviewed; extend to the
  rest.) *This is the single biggest risk — see Direction.*
- [ ] **CI tests the product you now ship** — the workflow doesn't run `npm test`
  and smoke-tests the demo TUI, not the app-mode server / restart lifecycle / PTY
  persistence / vendor routing / foreign-process protection. The strategic modules
  (search, vector index, handoff, MCP coordination) aren't in the suite. Add real
  integration tests + app/server smoke; run `npm test` in CI.
- [ ] **Telemetry: opt-OUT, but DISCLOSED + one-flag-off** *(owner's decision
  2026-07-17 — opt-out, not opt-in; both reviews argued opt-in, overruled by the
  owner)*. The trust risk isn't opt-out per se — it's *undisclosed* collection
  discovered at launch. So keep it opt-out but ship a plain privacy line naming the
  **launch/heartbeat analytics beacon** (the surface-tagged one) + the single flag
  to disable it. **The version-check ping is exempt** — it's low-sensitivity
  operational (like npm's), not analytics; no disclosure burden. No secrets or
  transcript content in any beacon, ever. (Optional: an in-app "send anonymized
  problem report" for structured bug signal — but not required.)
- [ ] **Recovery + migrations** — corrupt config/index/session-metadata → backup or
  rebuild path; versioned data migrations with rollback expectations.
- [ ] **`node-pty` → `optionalDependency`** — a failed native build shouldn't abort
  `npm i -g cldctrl` for TUI-only users (already lazy-required; degrade cleanly with
  a "live terminals unavailable" message).
- [ ] **Reconsider the bare `cc` alias** — collides with the C compiler + existing
  user aliases; keep it but don't make a globally invasive alias the only happy path.
- [ ] **5–10 external installs before any broad announcement.** Your machine is
  unusually configured with years of project state — it is not representative.

---

## 🟠 Tracked features (GitHub issues)

- **[#9] Verify launched-session kickoff + message-into-running-session** — primitive shipped (`send_to_session`/`read_session`); the wedge is context-assembly + read-back verify (next-seq #2).
- **[#10] Cross-project coordination (driver)** — **defer the state-machine framework** (premature for zero concurrent users; `types.ts` already has the status enum). The whole value is the word "verified" → delivered by the `verify()` primitive (next-seq #1). Revisit the FSM only if the wedge proves out and real multi-job load appears.
- **[#12] Continuous decaying working memory** — **rename "verified project state + selective recall."** Deferred behind: the staleness audit (next-seq #4), trust controls (provenance/status/supersession/scope/injection-preview/forget), and a lift-eval (warm beats cold). And an "outcome" is an on-demand view over retrieved passages, not a precomputed decaying store.
- **[#13] Reopening re-fires a kickoff prompt into a duplicate session** — **likely FIXED by the restart-lifecycle arc; verify + close.**
- **[#14] Wayfinder integration** — *defer* (composability, weak core-adoption value, another external schema to maintain).
- **[#15] Restart resumes stale context → agent redoes finished work** — **likely FIXED by the restart-lifecycle arc; verify + close (its repro IS the acceptance test).**
- **[#16] Linux support rough edges** — advanced by PR #18; keep a running list of remaining edges.
- **[#17] App-mode window has no AUMID (Windows taskbar grouping)** — cldctrl/PhysioMetrics/Chrome collapse into one button. Real app-mode polish; scope with the packaging/setup work.

---

## 🧭 Direction / strategic notes (updated 2026-07-17)

- **⭐ REAL-USAGE SIGNAL (primary user, 2026-07-17) — the daily-driver value is
  cross-project MANAGEMENT + frictionless RE-ENTRY, NOT the "brain."** The one
  person who lives in cldctrl finds it *essential* — for managing many projects and
  getting back into them — and explicitly NOT for the memory/verify/delegation
  stuff. That is already-built (sidebar + cross-vendor search + resume routing +
  cockpit + the restart-lifecycle re-entry). This OVERRIDES both AI reviews'
  "moat = brain, terminal-hosting = plumbing" thesis (neither reviewer uses the
  tool): the "plumbing" IS the current value, and the risk of "a dashboard people
  admire but don't need" is already disproven for the wedge user. **Implications:**
  (1) the brain (verify/continuity/memory) is an EXPANSION bet, not the reason to
  use it today — don't gate release on it; (2) polishing management + re-entry and
  SHIPPING is competitive with, maybe ahead of, the brain work for near-term
  leverage; (3) the pitch should lead with "manage + re-enter every project across
  every agent," with the brain as the where-it's-going story.
- **Users want outcomes, but transcripts stay canonical.** Power users want: what did
  we decide? is it still current? what changed? what failed? where's the evidence? —
  not "the conversation where we discussed X." BUT an outcome is a *lossy summary*;
  the transcript is the thing that's never wrong. So the outcome is a **view
  generated on-demand over retrieved passages**, not a precomputed store you must
  keep reconciled. Codex's "outcome ledger as canonical" over-rotated to precompute
  and smuggled back the staleness trap; keep sessions the source, generate outcomes
  per query.
- **Next milestone = "verified continuity across agents"** — recover current truth →
  hand it to another vendor with inspectable context → dispatch → verify → (maybe)
  update state. **"Verified" MUST mean mechanically-checkable**: git diff exists,
  `tsc`/tests pass, named files touched, read-back matches git state. The moment
  "verified" means "an LLM judged it honored the intent," it's an unfalsifiable
  green-check regress with no ground truth. Keep verification on the mechanical side
  of that line — that's the difference between a moat and a nice sentence.
- **Don't design the brain before proving anyone reaches for it.** You run this very
  session inside a cockpit tile — the cheapest signal in the plan is whether YOU
  reach for the already-shipped search + handoff this week. Instrument that first.
- **Biggest risk = a trust failure in the privileged localhost control plane.**
  CLD CTRL reads private transcripts + repo state, controls live PTYs, injects
  commands, launches agents. A browser-origin mistake, permissive WebSocket, path
  traversal, foreign-process misidentification, or unsafe default could leak
  transcripts or execute commands — and one credible incident kills the
  "local-first, trustworthy" promise that IS the moat. Security is a feature here.
- **Second risk = "a beautiful dashboard people admire but don't need."** Antidote
  is not more cockpit polish — it's shipping ONE undeniable closed-loop continuity
  workflow and measuring whether users repeatedly rely on it.
- **TUI: freeze hours-spent, but it's NOT a "two-products" problem.** Codex framed
  the TUI + cockpit as two products competing for the brain — wrong: nearly all the
  real work (verify, retrieval, memory trust, jobs, search) is **surface-agnostic
  core** both consume; only the thin presentation layer is duplicated, and it's
  small + stable. The TUI is also the zero-dependency fallback (node-pty optional,
  app-mode needs Chrome; SSH/headless/Linux users may have ONLY the TUI). So: stop
  spending *hours* adding TUI features, yes — but don't treat it as a competing
  product, and don't rip it out.
- **Wedge audience:** power users juggling many projects across multiple AI CLIs,
  and people whose first-party GUI is blocked/unavailable.
- **Rebrand — defer behind the wedge.** "CLD CTRL" reads as *Claude* Control, but a
  name doesn't out-argue a working demo that dispatches Codex + Antigravity. The
  migration (npm, docs, config keys, screenshots) is days of churn that buys nothing
  pre-adoption. Decide the name cheaply when you must; do the one bounded migration
  LATE, after the wedge proves out. Keep `cc` as the command (but note it collides
  with the C compiler + user aliases — don't make a globally invasive alias the only
  happy path).

### Explicitly drop / defer (solo-dev leverage triage)
- **Tauri shell** — defer until Chrome app-mode causes a *demonstrated* adoption/
  reliability problem. Months of packaging + per-platform maintenance, not brain
  leverage. (app-mode/PWA is the cheap interim; noted below.)
- **Multi-agent council as a product feature** — defer; opinions are easy to
  generate, hard to evaluate. Durable dispatch + verification matter more.
- **Grafting claude-mem wholesale (esp. ChromaDB)** — DON'T. `vector-index.ts` is
  already a real persistent incremental cosine index (crash-safe, sane caps) at
  personal-corpus scale; grafting a database in is strictly worse. BUT claude-mem's
  actual value isn't "ideas" — it's its **extraction prompts + its schema for what a
  memory IS** (the expensive-to-get-right part). Study those closely; don't
  hand-wave "import ideas." (SQLite/FTS may earn its place for durable structured
  state; Chroma doesn't.)
- **Wayfinder (#14)**, **inline image gallery expansion**, **deeper Stats polish**,
  **broad background-agent visualization** (build only the "needs you" interrupt
  queue), **exhaustive Antigravity/Gemini parity** (common denominator + tolerant
  adapters), **fine cockpit/tile-layout polish** — all defer/freeze after critical
  defects.

---

## 🧬 Vendor-neutral project merge model (design note, 2026-06-25 — still current)

How cldctrl unifies Claude / Codex / Gemini into one per-project view. Underpins
the outcome ledger and cross-vendor continuity.

**Key insight: there's no vendor "project model" to reconcile.** All three are CLIs
launched *in a directory*; each implicitly defines a project as that working dir.
That shared **cwd** is the join key — extract each session's cwd, normalize
(`normalizePathForCompare`), and **that path IS the project**.

**Where each vendor records the cwd:**
| Vendor | Session storage | cwd location |
|---|---|---|
| Claude | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` | `cwd` field per line (folder encoding is lossy → read from content) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta.payload.cwd` |
| Antigravity | local `.db` (read via `node:sqlite`) | cwd-based |
| Gemini | `~/.gemini/…` (TBD) | cwd-based; confirm when integrating |

**Pattern (proven in `conversation-search.ts`):** a per-vendor **SessionSource
adapter** maps native storage → `{ sessionId, projectPath(=cwd), lastTs, vendor, … }`;
attribution = normalized-path match. Merge in layers: (1) sessions-per-project *(built
for Claude+Codex+Antigravity)*; (2) project universe = union of every dir any vendor
touched ∪ registered; (3) resume/launch routing per vendor *(built)*; (4) **project
context = ONE canonical brief projected into each vendor's convention file**
(`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) — where it stops being plumbing and becomes the
brain. This is the same canonical-state idea as the outcome ledger.

---

## 📋 Backlog — Cockpit / Web UX (parked; freeze after critical defects)
- **Embedded images inline in conversations → gallery** — terminals can't render
  images, so screenshots/figures are invisible; detect image refs in output, show a
  thumbnail rail → the existing lightbox. *Build only if visual-dev users become a
  measured core segment (deferred per review).*
- **Surface Claude Code background agents** — Tier 1 ONLY: a "needs you" interrupt
  queue (poll `claude agents --json`, flash `blocked`/`waitingFor: permission`, fold
  into `get_active_sessions`). Defer richer agent visualization.
- **CTRL as a default cockpit tile** (attach to the same server-side control PTY as
  the dock; fresh-on-restart except a very-recent reopen). **Promote Stats to a
  top-level route** (it's account-global, currently a cockpit sub-tab) — functional
  fix only. Subagent-tree viz; AI-sharpened titles; per-tile diff viewer/preview.
- **Multi-monitor / extended cockpit** — pop-outs already clear the usability bar
  (v1 shipped); v2 Window-Management-API auto-place and v3 native multi-window are
  Tauri-gated → deferred.

## 📋 Backlog — Setup / Config / Packaging
- **App-mode + PWA install** (Window Controls Overlay, pinnable taskbar icon) — the
  cheap "native feel" interim; keep instead of Tauri for now.
- **Cross-browser parity fallbacks** — clipboard paste / Web Speech / Media Session
  degrade gracefully off Chromium; never hard-fail on a missing API. (Also helps a
  future Tauri-on-WebKit path.)
- **Tool-permissions GUI** — edit Claude Code allow/ask/deny lists in-app (global +
  per-project), templates, confirm-before-write.
- **Zero-config first-run is a HARD principle** — `cc` auto-discovers projects;
  `cc serve` just works; welcome wizard detects claude/git/gh; hotkey+daemon opt-in.
  Only prerequisite = Claude Code installed.

## 📋 Backlog — Memory & the vendor-neutral brain (reframed)
Three-tier model, but **truth/provenance is the hard part, not storage**:
- **(L) Long-term recall — BUILT** (`search_conversations`, cross-vendor).
- **(S) Semantic/vector — tier-0 SHIPPED** (local MiniLM re-rank). Deepen with the
  existing simple local index; do NOT adopt Chroma.
- **(W) Verified project state + selective recall (= reframed #12)** — the outcome
  ledger + trust controls + relevance-gated top-k retrieval (prefill+confirm), NOT
  auto-inject-everything. Prior art: MemGPT/Letta, Generative Agents.
- **Memory-eval harness (the differentiator nobody else has built):**
  (1) **Faithfulness/staleness audit** — parse each memory/outcome into discrete
  claims; a fresh agent verifies against the live repo (codeindex/grep/read) →
  ✅/⚠️/❌/🤷 + evidence; surface in the dashboard with re-verify/update/delete.
  **Start here.** (2) **Lift eval** — representative tasks cold (no memory) vs warm;
  memory earns its place only when warm beats cold on checkable outcomes.
- **Keep, don't replace, the markdown-git memory** (`MEMORY.md` + per-fact files =
  curated human-readable truth). Index/retrieve over both curated + auto-captured.

---

## 🛠 Build strategy — parallel worktrees + dogfooding the orchestrator
The endgame: use the driver-jobs machine (#10) to drive parallel worktree builds of
the *disjoint* backlog — ships features AND validates the orchestrator on real work
("cldctrl builds cldctrl"). Parallelize only file-DISJOINT, well-specified,
independently-verifiable tasks (most cockpit items edit the same hot files → keep
sequential). For unattended runs, pull the isolation layer (git worktree +
`--dangerously-skip-permissions` for trusted repos, devcontainer/microVM for
untrusted) — the differentiated piece is NOT the cage, it's the **queue + verify-gate
(tsc/tsup/smoke + Chrome UI pass) + morning report in the dashboard**. Start small
(2–3 truly independent slices) before scaling.

See also `NEEDED-UPGRADES.md` and `PROJECT-MODEL.md`.
