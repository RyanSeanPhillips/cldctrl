# cldctrl Remote Worker — Design Notes

Status: idea, not started. Captured 2026-06-26. Pick up later.

## Goal

Let long-running jobs (mostly coding, some assistant tasks) keep running when the
laptop closes, on an always-on box, reachable/monitorable from the control plane.
The trigger was: "jobs/tasks don't have to stop on my commute home." Hardware: an
Ubuntu box (always-on target); this Windows machine has WSL for building/testing.

## Hard constraints (operator stated)

- STAY ON THE CLAUDE SUBSCRIPTION. No pay-as-you-go API billing. => coding and
  assistant jobs both run as **headless Claude Code** (`claude -p`), not via any
  API-billed harness. This is why Hermes-as-brain is OUT (it bills per token).
- Inbound SSH to the box is BLOCKED. => no push-to-box. Use a pull model.
- Pilot: one job at a time (subscription rate/usage limits).

## Core architecture: ship it AS a mode of cldctrl

Make the worker a ROLE of cldctrl, not a separate tool. One codebase, two modes:

- **control mode** (runs here on Windows): orchestrates, files jobs, monitors.
- **worker mode** (runs on the Ubuntu box): `cldctrl worker --name homebox`.
  systemd-managed daemon that pulls jobs, sandboxes, runs headless Claude Code,
  opens PRs, posts status.

Deploy story becomes: **install cldctrl on the box, run `cldctrl worker`.** Done.
Sub-decision (lean: one binary + mode flag, not a separate runner subpackage).

Give each worker a NAME/profile so control can monitor SEVERAL boxes at once
(dashboard: "homebox: 2 jobs running, 1 PR open"). Scales past one machine.

## The seam: GitHub as the bus (solves the SSH block)

Box can't take inbound SSH but can reach OUT over HTTPS. So the box pulls work;
nothing on it is internet-reachable.

1. Control (here): operator describes what to build -> CTRL writes a task spec ->
   files it as a GitHub issue labeled `agent-task` (or a queue entry) + records an
   `upsert_task` (in_progress) with the issue/PR number.
2. Worker (box): daemon polls for `agent-task` issues. Per job: create a git
   **worktree on a fresh branch** -> spin a **Docker sandbox** -> run headless
   Claude Code (`claude -p "<spec>"`) inside it so it can "just go for it"
   without touching main or the host.
3. Report back: commit -> push branch -> open **draft PR** -> post status COMMENTS
   on the issue (heartbeats: started / branch created / tests passing / PR opened)
   -> Slack ping with the PR link + summary.

GitHub doubles as bus AND review surface. Every autonomous attempt is a branch +
PR the operator can read, run, or throw away from their phone. That IS the
"sandboxed and/or branched environment" the operator asked for.

## Monitoring from control (answers "can cldctrl watch the box")

Yes — because the box reports state INTO GitHub and control reads GitHub. No
direct connection needed. Make dispatch/status first-class cldctrl MCP tools
(e.g. `dispatch_remote_task`, `list_remote_jobs`) instead of raw `gh`, so the
dashboard shows remote progress natively. CTRL can also poll on a schedule and
ping the operator when a job finishes or stalls.

## Why Ubuntu helps

- Docker runs natively (cheap, real sandbox; no WSL layer).
- systemd keeps the worker always-on + auto-restarts it (the "always available"
  backbone; one service-unit file).
- git worktrees, cron, POSIX shell, headless Claude Code all native.
Windows machine stays the control plane (no Docker needed); natural split.

## Test on WSL first

WSL is a real Linux rehearsal rig and exercises the actual code paths:
- Docker via Desktop WSL integration (or native in-distro).
- systemd works in WSL2 with `systemd=true` in `wsl.conf` (test the real unit).
- Headless Claude Code on subscription installed + logged in INSIDE the distro —
  validate this early; it must work identically on the real box.
Loop to prove in WSL: control files an issue -> worker picks it up -> sandbox ->
runs job -> opens PR -> control monitors. If that round-trips, Ubuntu deploy is
just install + point at the same repos. Delta WSL vs bare-metal is small for
Docker + systemd + Claude Code.

## Guardrails before it goes autonomous

- Sandbox blast radius: Docker, no host mount beyond the worktree, scoped GitHub
  token (push branches + open PRs, NOT admin), a kill switch, PR-only output
  (never writes main).
- If the assistant slice ever uses anything API-billed, cap it. (For now,
  everything is subscription via headless Claude Code, so no API spend.)

## Hermes' place in the end state

Dropped for the pilot (bills per token). Revisit ONLY its messaging gateway later
if the operator wants live human<->agent chat over Slack/Signal and is willing to
meter just that one piece. MIT-licensed, so extracting the gateway is legally
clean if we go there. Architecture/ideas worth stealing regardless:
lineage-based compression (child sessions from summaries) and the
register-vs-expose tool split.

## Open question parked here: inter-session messaging

Operator asked whether to steal Hermes' messaging so cldctrl sessions can talk to
each other directly. Finding: cldctrl ALREADY has the primitive — `send_to_session`
(inject a message into a running cockpit session) + `read_session` +
`get_active_sessions` + `consult_agent`. That's hub-and-spoke agent-to-agent
coordination through the control plane, which is what's actually needed. Hermes'
gateway is a human<->agent platform bridge, NOT session-to-session IPC, so it's
the wrong thing to extract for this. Likely work = extend send_to_session
(e.g. allow worker/headless sessions as targets, not just open cockpit tiles),
not import Hermes.
