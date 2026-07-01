/**
 * Control plane workspace for `cc control`.
 *
 * A dedicated Claude Code workspace under the config dir that acts as the
 * operator's mission-control chat: cross-project planning, task tracking, and
 * dispatching work into individual projects (via the cldctrl MCP `launch_session`).
 *
 * It is just a directory with a persona `CLAUDE.md`, a structured task store
 * (`tasks.json`), and a `recaps/` folder. The chat itself is a normal Claude
 * Code session launched with `--continue` so it's the same ongoing conversation
 * every time. No new chat UI, no email/account integration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { getSessionDir } from './projects.js';
import { log } from './logger.js';
import type { ControlTask, ControlTaskStore } from '../types.js';

// ── Paths ───────────────────────────────────────────────────

/** The control workspace directory (cwd for the control session). */
export function getControlDir(): string {
  return path.join(getConfigDir(), 'control');
}

function getPersonaPath(): string {
  return path.join(getControlDir(), 'CLAUDE.md');
}

function getTasksPath(): string {
  return path.join(getControlDir(), 'tasks.json');
}

function getRecapsDir(): string {
  return path.join(getControlDir(), 'recaps');
}

// ── Persona ─────────────────────────────────────────────────

/**
 * The mission-control persona. Written to the workspace CLAUDE.md on first run.
 * Kept in sync via a version marker so upgrades can refresh it without clobbering
 * a user who hand-edited theirs (we only overwrite when our marker is present).
 */
const PERSONA_VERSION = 6;
const PERSONA_MARKER = `<!-- cldctrl-control-persona v${PERSONA_VERSION} -->`;

function buildPersona(): string {
  return `${PERSONA_MARKER}
# CTRL — CLD CTRL Control Plane

You are **CTRL**, the operator's mission-control agent for thinking across all of
their projects. You are a dispatcher and planner, not the place where hands-on
coding happens.

This chat may be a **fresh daily conversation** — you do NOT carry memory from a
previous CTRL thread in-context. Your durable memory lives in the workspace, not
in the chat history: at the start of a new conversation, orient yourself by
calling \`read_tasks\` (the operator's task store) and skimming the latest file in
\`recaps/\`. Record durable progress with \`upsert_task\` and by writing recaps —
that's how continuity survives across daily conversations.

## Your tools

The \`cldctrl\` MCP server is available. Use it as your source of truth:
- \`list_projects\` — every project the operator tracks.
- \`get_project_context\` — recent sessions, git status, commits, and open issues
  for one project. Use this before reasoning about a project's state.
- \`get_active_sessions\` — what's currently running across all projects.
- \`launch_session\` — open a new Claude Code session **in a project's own
  directory**, optionally seeded with a prompt. This is how you hand off work.
- \`set_project_group\` — organize how projects are grouped in the dashboard
  sidebar (Apps / Research / Professional / Exploring, or a custom group). When
  the operator asks to recategorize ("put X in Exploring", "group the job stuff
  under Professional"), call this; \`group:'auto'\` reverts to auto-categorization.

The \`gh\` CLI is available for GitHub (issues, PRs). \`read_tasks\` and
\`upsert_task\` (cldctrl MCP) are your persistent memory — see below.

If a **Google Calendar** MCP is connected, you may read it to see the operator's
deadlines and commitments. Calendar is optional: if it isn't available, fall back
to task due-dates (see below) and don't block on it.

## What you do here

- **Plan & track**: help the operator decide what to work on, in what order,
  across projects. Keep the picture in your head grounded in real data from the
  MCP, not assumptions.
- **Remember**: maintain the task list with \`read_tasks\` / \`upsert_task\`. When
  the operator mentions something to do, a decision, or progress, record it.
  When work gets handed off or finished, update the relevant task. When a task
  has a deadline, set its \`due\` field (ISO \`YYYY-MM-DD\`) — this is what the
  background nudges run on, so it works even when calendar isn't connected.
- **Recap**: when asked (or on a schedule), summarize recent activity and
  progress across projects and write it to \`recaps/\`.
- **Draft**: you can draft text — including email replies — as plain text the
  operator copies out themselves. Email and calendar access, when connected, are
  covered in their own sections below. You never send mail and never modify the
  mailbox.

## Handoff: detecting drift into a project

Watch for the conversation turning into hands-on work on **one specific
project** — debugging it, designing its features, or anything that wants its
files, its CLAUDE.md, its git, and its code index in scope. That work belongs in
a session in that project's directory, not here.

When you notice this, **stop and offer a handoff**. Do not launch unannounced.
Phrase it as a choice, and include whether to carry context:

> This is really about **<project>**. Want me to start a session there?
> - **with context** — I'll seed it with a summary of what we just worked out
> - **fresh** — just open it clean
> - **stay here** — keep going in control

- If **with context**: write a tight seed prompt — what you two figured out, the
  goal, and any constraints/decisions — and call
  \`launch_session({ project, prompt })\`.
- If **fresh**: \`launch_session({ project })\` with no prompt.
- If **stay**: continue here.

After a handoff, record it with \`upsert_task\` (status \`in_progress\`, the
project set) so control remembers it dispatched work there.

## Calendar

If Google Calendar is connected:
- **Read freely** to understand deadlines, meetings, and free time, and factor
  them into planning.
- **Adding entries requires explicit confirmation, every time.** Draft the event
  (title, date/time, duration) and show it to the operator. Only create it after
  they say yes to that specific entry. Never add, move, or delete an event
  without a per-event OK. You have no standing permission to change the calendar.

## Email

If a Gmail (or other email) MCP is connected:
- **Read-only, for now.** You may read the inbox to find messages that need a
  reply and surface them — "you've got 3 emails waiting on a response."
- **Draft as chat text only.** Write proposed replies as plain text in the
  conversation for the operator to copy into their mail client. Do **not** write
  to the mailbox — no Gmail drafts — and **never send** anything.
- Creating drafts directly in Gmail (saved to Drafts, still never sent) is a
  **future opt-in** the operator may enable once they trust it. Until they say so
  explicitly, stay text-only.

## Staying on track

At the start of a session, and whenever it's relevant, reconcile three things:
what the operator is **actively doing** (\`get_active_sessions\`), what's **due
soon** (task \`due\` dates + calendar), and what **matters most**. Speak up when:
- A deadline is near or overdue.
- They're heads-down in one project while something more time-critical sits in
  another — name it plainly: "you're in X, but Y is due tomorrow."

Be direct but not naggy — flag it once, then let them decide.

## Style

Concise and operational. Lead with the state of things and the decision to make.
You are the place the operator opens to ask "what should I be doing, and where do
things stand" — answer that quickly.
`;
}

// ── Bootstrap ───────────────────────────────────────────────

/**
 * Ensure the control workspace exists: directory, persona CLAUDE.md, empty
 * task store, recaps folder. Idempotent. Refreshes the persona only when our
 * version marker is present and outdated (never clobbers a user-authored file).
 *
 * @returns the control directory path.
 */
export function ensureControlWorkspace(): string {
  const dir = getControlDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(getRecapsDir(), { recursive: true });

  // Persona: write if missing, or refresh if it's a stale cldctrl-managed one.
  const personaPath = getPersonaPath();
  let writePersona = true;
  if (fs.existsSync(personaPath)) {
    try {
      const existing = fs.readFileSync(personaPath, 'utf-8');
      const managed = existing.includes('cldctrl-control-persona');
      const current = existing.includes(PERSONA_MARKER);
      // Only overwrite a managed-but-outdated persona; leave user edits alone.
      writePersona = managed && !current;
    } catch {
      writePersona = false;
    }
  }
  if (writePersona) {
    fs.writeFileSync(personaPath, buildPersona());
  }

  // Task store: create empty if missing.
  if (!fs.existsSync(getTasksPath())) {
    writeTaskStore({ version: 1, tasks: [] });
  }

  log('info', { function: 'ensureControlWorkspace', dir });
  return dir;
}

/**
 * Whether the control workspace already has at least one Claude Code
 * conversation on disk. Used to decide between `--continue` (resume the ongoing
 * control thread) and a fresh session — a brand-new workspace has nothing to
 * continue, so launching with `--continue` errors ("No conversation found").
 */
export function hasControlHistory(): boolean {
  try {
    const dir = getSessionDir(getControlDir());
    return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Newest control-conversation activity (max JSONL mtime in ms), or 0 if none.
 * Drives the daily fresh-vs-continue decision when CTRL is opened: within the
 * window → continue the current thread; older → start a fresh one.
 */
export function getLatestControlActivity(): number {
  try {
    const dir = getSessionDir(getControlDir());
    let max = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > max) max = m;
    }
    return max;
  } catch {
    return 0;
  }
}

// ── Task store ──────────────────────────────────────────────

/** Read the task store, tolerating a missing or corrupt file. */
export function readTaskStore(): ControlTaskStore {
  try {
    const raw = fs.readFileSync(getTasksPath(), 'utf-8');
    const parsed = JSON.parse(raw) as ControlTaskStore;
    if (parsed && Array.isArray(parsed.tasks)) {
      return { version: 1, tasks: parsed.tasks };
    }
  } catch {
    /* fall through to empty */
  }
  return { version: 1, tasks: [] };
}

/** Atomically persist the task store (temp + rename, same as config). */
function writeTaskStore(store: ControlTaskStore): void {
  const tasksPath = getTasksPath();
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  const json = JSON.stringify(store, null, 2) + '\n';
  const tmpPath = tasksPath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, tasksPath);
}

function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface UpsertTaskInput {
  /** Omit to create a new task; pass an existing id to update it. */
  id?: string;
  title?: string;
  project?: string;
  status?: ControlTask['status'];
  notes?: string;
  /** ISO date (YYYY-MM-DD) or datetime. Pass null/'' to clear. */
  due?: string | null;
}

/**
 * Create or update a task. Without an id, creates a new task (title required).
 * With a known id, merges the provided fields. Returns the resulting task,
 * or null if an unknown id was given.
 */
export function upsertTask(input: UpsertTaskInput): ControlTask | null {
  const store = readTaskStore();
  const now = new Date().toISOString();

  if (input.id) {
    const existing = store.tasks.find((t) => t.id === input.id);
    if (!existing) return null;
    if (input.title !== undefined) existing.title = input.title;
    if (input.project !== undefined) existing.project = input.project;
    if (input.status !== undefined) existing.status = input.status;
    if (input.notes !== undefined) existing.notes = input.notes;
    if (input.due !== undefined) existing.due = input.due || undefined;
    existing.updated = now;
    writeTaskStore(store);
    return existing;
  }

  const title = (input.title || '').trim();
  if (!title) return null;
  const task: ControlTask = {
    id: newTaskId(),
    title,
    project: input.project,
    status: input.status || 'pending',
    notes: input.notes,
    due: input.due || undefined,
    created: now,
    updated: now,
  };
  store.tasks.push(task);
  writeTaskStore(store);
  return task;
}

// ── Nudges (proactive deadline / focus reminders) ───────────

export interface Nudge {
  /** Stable dedup key — same key won't notify twice until its tier changes. */
  key: string;
  title: string;
  message: string;
}

export interface NudgeInput {
  tasks: ControlTask[];
  /** Names of projects with a currently-active (non-idle) session. */
  activeProjects: string[];
  /** Epoch ms "now" (injectable for tests). Defaults to Date.now(). */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `now` until `due` (negative = overdue). */
function daysUntil(dueIso: string, now: number): number | null {
  const t = Date.parse(dueIso.length <= 10 ? `${dueIso}T23:59:59` : dueIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / DAY_MS);
}

/** Coarse urgency tier for a day delta, or null if not yet worth nudging (>3 days). */
function dueTier(days: number): 'overdue' | 'today' | 'tomorrow' | 'soon' | null {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 3) return 'soon';
  return null;
}

function whenLabel(tier: string, days: number): string {
  switch (tier) {
    case 'overdue': return `overdue by ${Math.abs(days)}d`;
    case 'today': return 'due today';
    case 'tomorrow': return 'due tomorrow';
    default: return `due in ${days}d`;
  }
}

/**
 * Compute deadline + focus-mismatch nudges from tasks and active sessions.
 * Pure: no I/O, no dedup — caller filters against seen state. Deliberately
 * conservative so background notifications don't cry wolf.
 */
export function computeNudges(input: NudgeInput): Nudge[] {
  const now = input.now ?? Date.now();
  const active = new Set(input.activeProjects.map((p) => p.toLowerCase()));
  const nudges: Nudge[] = [];

  for (const task of input.tasks) {
    if (task.status === 'done' || !task.due) continue;
    const days = daysUntil(task.due, now);
    if (days === null) continue;
    const tier = dueTier(days);
    if (!tier) continue;

    const proj = task.project ? ` (${task.project})` : '';
    // Deadline reminder — one per task per tier.
    nudges.push({
      key: `deadline:${task.id}:${tier}`,
      title: `Deadline ${whenLabel(tier, days)}`,
      message: `${task.title}${proj}`,
    });

    // Focus mismatch — only for the most urgent tiers, only when the operator
    // is actively in some *other* project and not the one this task belongs to.
    if ((tier === 'overdue' || tier === 'today') && task.project) {
      const onThis = active.has(task.project.toLowerCase());
      if (active.size > 0 && !onThis) {
        const where = [...input.activeProjects][0];
        nudges.push({
          key: `focus:${task.id}:${tier}`,
          title: 'Heads up on your focus',
          message: `You're in ${where}, but "${task.title}"${proj} is ${whenLabel(tier, days)}.`,
        });
      }
    }
  }

  return nudges;
}

/**
 * Read tasks, compute nudges against the given active projects, and return only
 * the ones not yet delivered (marking them delivered). One call per poll tick.
 * Caller supplies active project names so this module stays free of process/
 * project deps. Returns [] when there's nothing to nudge.
 */
export function gatherFreshNudges(activeProjects: string[], now?: number): Nudge[] {
  const { tasks } = readTaskStore();
  if (tasks.length === 0) return [];
  const nudges = computeNudges({ tasks, activeProjects, now });
  return takeFreshNudges(nudges);
}

// ── Nudge dedup state ───────────────────────────────────────

function getNudgeStatePath(): string {
  return path.join(getConfigDir(), 'nudge-state.json');
}

/** Load the set of already-delivered nudge keys. */
export function loadNudgedKeys(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(getNudgeStatePath(), 'utf-8'));
    if (Array.isArray(raw)) return new Set(raw.filter((k): k is string => typeof k === 'string'));
  } catch {
    /* none yet */
  }
  return new Set();
}

/** Persist delivered nudge keys (atomic temp+rename). */
export function saveNudgedKeys(keys: Set<string>): void {
  const statePath = getNudgeStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify([...keys]) + '\n');
  fs.renameSync(tmpPath, statePath);
}

/**
 * Return only the nudges whose key hasn't fired before, and record them as
 * delivered. Caller is responsible for actually showing them.
 */
export function takeFreshNudges(nudges: Nudge[]): Nudge[] {
  const seen = loadNudgedKeys();
  const fresh = nudges.filter((n) => !seen.has(n.key));
  if (fresh.length > 0) {
    for (const n of fresh) seen.add(n.key);
    saveNudgedKeys(seen);
  }
  return fresh;
}
