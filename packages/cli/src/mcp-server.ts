/**
 * MCP (Model Context Protocol) server for cldctrl.
 * Exposes project data and session management as tools that Claude Code
 * conversations can use. Runs as a standalone stdio process — no TUI/Ink.
 *
 * Tools:
 * - list_projects: all projects with name, path, alias
 * - get_project_context: sessions, git, commits, issues for one project
 * - get_active_sessions: cross-project active/idle session list
 * - launch_session: open a new Claude Code terminal window
 * - rescan_projects: re-run filesystem discovery so new folders become known
 * - create_project: create + register a new project end-to-end (folder, CLAUDE.md,
 *   git init, config registration), optionally launching it
 * - hide_project / unhide_project: hide noise (or restore) from every view
 * - read_tasks: read the control plane's persistent task list
 * - upsert_task: create/update a control plane task
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { VERSION } from './constants.js';
import { loadConfig, saveConfig } from './config.js';
import { installErrorHandlers } from './core/error-report.js';
import { buildProjectListFast, buildProjectList, projectGroup, autoCategorizeProject } from './core/projects.js';
import { getRecentSessions } from './core/sessions.js';
import { getGitStatus, getRecentCommits } from './core/git.js';
import { getIssues, isGhAvailable } from './core/github.js';
import { getActiveClaudeProcesses } from './core/processes.js';
import { launchAndTrack } from './core/launcher.js';
import {
  createProject,
  rescanProjects,
  hideProjectPath,
  unhideProjectPath,
  listHiddenProjects,
} from './core/create-project.js';
import { ensureControlWorkspace, readTaskStore, upsertTask } from './core/control.js';
import { searchConversations } from './core/conversation-search.js';
import fs from 'node:fs';
import path from 'node:path';
import { readDashboardContext, writeAgentSearch, openScratchpad, scratchPath, writeCockpitLaunch, writeCockpitInject } from './core/dashboard-bridge.js';
import { noteHistory, restoreNoteRevision } from './core/notes-git.js';
import { consultAgent, listAgents, setAgentPath } from './core/agents.js';
import { getThread, saveThread } from './core/consult-threads.js';
import { randomUUID } from 'node:crypto';
import { readDaemonCache } from './core/background.js';
import { extractTranscript } from './core/summaries.js';
import { normalizePathForCompare, getClaudeProjectsDir } from './core/platform.js';
import { log, initLogger } from './core/logger.js';
import type { Config, Project } from './types.js';

// ── Project resolution ─────────────────────────────────────

/**
 * Resolve a project by name, alias, or path.
 * Returns the matched project or null.
 */
function resolveProject(
  config: Config,
  projects: Project[],
  identifier: string,
): Project | null {
  const lower = identifier.toLowerCase();

  // Check aliases first
  for (const cp of config.projects) {
    if (cp.alias && cp.alias.toLowerCase() === lower) {
      const found = projects.find(
        (p) => normalizePathForCompare(p.path) === normalizePathForCompare(cp.path),
      );
      if (found) return found;
    }
  }

  // Exact name match
  for (const p of projects) {
    if (p.name.toLowerCase() === lower) return p;
  }

  // Path match
  for (const p of projects) {
    if (normalizePathForCompare(p.path) === normalizePathForCompare(identifier)) {
      return p;
    }
  }

  // Unambiguous prefix
  const prefixMatches = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}

// ── Tool implementations ───────────────────────────────────

async function handleListProjects(): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);

  // Build alias lookup
  const aliasMap = new Map<string, string>();
  for (const cp of config.projects) {
    if (cp.alias) aliasMap.set(normalizePathForCompare(cp.path), cp.alias);
  }

  return projects.map((p) => ({
    name: p.name,
    path: p.path,
    alias: aliasMap.get(normalizePathForCompare(p.path)) || undefined,
    pinned: p.pinned || undefined,
    group: projectGroup(config, p.name, p.path),
  }));
}

async function handleSetProjectGroup(args: { project: string; group: string }): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const resolved = resolveProject(config, projects, args.project);
  if (!resolved) {
    return { error: `Project not found: "${args.project}". Use list_projects to see available projects.` };
  }
  const key = normalizePathForCompare(resolved.path);
  const groups = { ...(config.project_groups ?? {}) };
  const group = (args.group ?? '').trim();
  if (!group || group.toLowerCase() === 'auto') {
    // Clear the override → fall back to auto-categorization.
    delete groups[key];
    config.project_groups = groups;
    saveConfig(config);
    return { ok: true, project: resolved.name, group: autoCategorizeProject(resolved.name, resolved.path), reverted: true };
  }
  groups[key] = group;
  config.project_groups = groups;
  saveConfig(config);
  return { ok: true, project: resolved.name, group };
}

async function handleGetProjectContext(args: { project: string }): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectList(config);
  const project = resolveProject(config, projects, args.project);
  if (!project) {
    return { error: `Project not found: "${args.project}". Use list_projects to see available projects.` };
  }

  const projectPath = project.path;
  const cache = readDaemonCache();

  // Fetch data — use daemon cache when available, fall back to live
  const [sessions, gitStatus, commits, issues] = await Promise.all([
    getRecentSessions(projectPath, 5),
    cache?.gitStatuses[projectPath]
      ? Promise.resolve(cache.gitStatuses[projectPath])
      : getGitStatus(projectPath),
    cache?.recentCommits?.[projectPath]
      ? Promise.resolve(cache.recentCommits[projectPath].slice(0, 10))
      : getRecentCommits(projectPath, 10),
    cache?.issues?.[projectPath]
      ? Promise.resolve(cache.issues[projectPath].slice(0, 5))
      : (isGhAvailable() ? getIssues(projectPath).then((i) => i.slice(0, 5)) : Promise.resolve([])),
  ]);

  return {
    project: { name: project.name, path: project.path },
    recentSessions: sessions.map((s) => ({
      id: s.id,
      summary: (s.richSummary || s.summary || '').slice(0, 100),
      date: s.dateLabel,
      messages: s.stats?.messages ?? 0,
      gitBranch: s.gitBranch || undefined,
    })),
    git: gitStatus
      ? {
          branch: gitStatus.branch,
          dirty: gitStatus.dirty,
          ahead: gitStatus.ahead,
          behind: gitStatus.behind,
        }
      : null,
    recentCommits: (commits || []).map((c) => ({
      hash: c.hash.slice(0, 8),
      subject: c.subject.slice(0, 80),
      date: c.date,
    })),
    openIssues: (issues || []).map((i) => ({
      number: i.number,
      title: i.title.slice(0, 100),
      labels: i.labels,
    })),
  };
}

async function handleGetActiveSessions(): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const knownPaths = projects.map((p) => p.path);

  // Build name lookup
  const nameMap = new Map<string, string>();
  for (const p of projects) {
    nameMap.set(normalizePathForCompare(p.path), p.name);
  }

  const sessions = await getActiveClaudeProcesses(knownPaths);

  return sessions.map((s) => ({
    project: nameMap.get(normalizePathForCompare(s.projectPath)) || s.projectPath,
    path: s.projectPath,
    sessionId: s.sessionId || undefined,
    status: s.idle ? 'idle' : 'active',
    lastActivity: s.lastActivity.toISOString(),
  }));
}

async function handleLaunchSession(args: {
  project: string;
  prompt?: string;
  resume?: string;
}): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectList(config);
  const project = resolveProject(config, projects, args.project);
  if (!project) {
    return { error: `Project not found: "${args.project}". Use list_projects to see available projects.` };
  }

  // Web-first routing: open sessions as cockpit TILES whenever a dashboard is
  // available — either this MCP server runs inside a cockpit PTY (the PTYs set
  // CLDCTRL_DASHBOARD_PORT) or a dashboard is simply RUNNING on this machine
  // (probed on the default port; requires our 200+JSON signature). Resumes route
  // to the cockpit too (a resume tile attaches/spawns `claude --resume`). Only
  // when no dashboard is up does this fall back to a separate terminal window.
  const envPort = Number(process.env.CLDCTRL_DASHBOARD_PORT) || 0;
  let dashboardUp = envPort > 0;
  if (!dashboardUp) {
    try {
      const { probeServer } = await import('./core/app-launch.js');
      dashboardUp = await probeServer(2533);
    } catch { /* probe unavailable → terminal fallback */ }
  }
  if (dashboardUp) {
    writeCockpitLaunch({ projectPath: project.path, project: project.name, prompt: args.prompt, sessionId: args.resume, ts: Date.now() });
    return {
      success: true,
      surface: 'cockpit',
      message: (args.resume
        ? `Resuming that conversation as a cockpit tile in the dashboard.`
        : `Opening a new session for "${project.name}" in the dashboard cockpit.`)
        + (envPort ? '' : ' If no dashboard window is visible, `cc` opens one.'),
      project: project.name,
      path: project.path,
    };
  }

  const result = launchAndTrack({
    projectPath: project.path,
    isNew: !args.resume,
    sessionId: args.resume,
    prompt: args.prompt,
  });

  return {
    success: result.success,
    message: result.message,
    project: project.name,
    path: project.path,
  };
}

async function handleConvertToLatex(args: { path: string }): Promise<unknown> {
  const { convertMarkdownToLatex } = await import('./core/latex.js');
  const r = convertMarkdownToLatex(typeof args.path === 'string' ? args.path : '');
  if (r.pandocMissing) {
    return {
      ok: false,
      pandocMissing: true,
      guidance:
        'pandoc is not installed on this machine — write the .tex yourself: read the markdown file and write a COMPLETE compilable LaTeX document beside it (same basename, .tex extension) with \\documentclass{article} and a proper preamble, preserving headings, emphasis, lists, citations and math. If the user has an existing LaTeX project, match its conventions instead of a generic preamble.',
    };
  }
  return r;
}

async function handleHandoffSession(args: { session: string; toAgent: string }): Promise<unknown> {
  const session = (args.session ?? '').trim();
  const toAgent = (args.toAgent ?? '').trim().toLowerCase();
  if (!session) return { ok: false, error: 'Provide a sessionId (from search_conversations or get_active_sessions).' };
  const target = listAgents().find((a) => a.id === toAgent);
  if (!target) return { ok: false, error: `Unknown agent "${toAgent}". Available: ${listAgents().map((a) => a.id).join(', ')}.` };
  if (!target.available) return { ok: false, error: `Agent "${toAgent}" isn't installed/available on this machine.` };
  const { buildHandoffBrief } = await import('./core/handoff.js');
  const brief = await buildHandoffBrief(session);
  if (!brief.ok || !brief.brief || !brief.projectPath) {
    return { ok: false, error: brief.error || 'Could not build a handoff brief for that session.' };
  }
  writeCockpitLaunch({
    projectPath: brief.projectPath,
    project: brief.project,
    agent: toAgent,
    handoffBrief: brief.brief,
    handoffFrom: { sessionId: session, vendor: brief.vendor || 'claude' },
    ts: Date.now(),
  });
  return {
    ok: true,
    agent: toAgent,
    project: brief.project,
    fromVendor: brief.vendor,
    message: `Queued a handoff of session ${session.slice(0, 8)}… to ${target.label} in "${brief.project}". If the dashboard is open, a new ${target.label} tile appears prefilled with the brief for the operator to review and send. The original conversation is untouched.`,
  };
}

async function handleRescanProjects(): Promise<unknown> {
  const result = rescanProjects();
  return {
    scanned: result.scanned,
    total: result.total,
    newProjects: result.newProjects,
    hidden: listHiddenProjects(),
  };
}

async function handleHideProject(args: { project: string }): Promise<unknown> {
  // Resolve to a concrete path when the project is currently visible; otherwise
  // treat the identifier as a literal path.
  const { config } = loadConfig();
  const projects = buildProjectList(config);
  const resolved = resolveProject(config, projects, args.project);
  return hideProjectPath(resolved?.path ?? args.project);
}

async function handleUnhideProject(args: { project: string }): Promise<unknown> {
  return unhideProjectPath(args.project);
}

async function handleCreateProject(args: {
  path: string;
  name?: string;
  context?: string;
  launch?: boolean;
  prompt?: string;
}): Promise<unknown> {
  const result = createProject({ path: args.path, name: args.name, context: args.context });
  if (!result.success || !result.project) {
    return result;
  }

  let launch: { success: boolean; message: string; surface?: string } | undefined;
  if (args.launch) {
    // Route through the same web-first logic as launch_session: if a dashboard
    // is up, the fresh project opens as a cockpit TILE (it's already registered
    // in config + the index by createProject above, so it resolves), otherwise
    // it falls back to a terminal window. Previously this called launchAndTrack
    // directly and always spawned a terminal, even with the cockpit running.
    const routed = (await handleLaunchSession({
      project: result.project.path,
      prompt: args.prompt,
    })) as { success?: boolean; message?: string; surface?: string; error?: string };
    launch = {
      success: !!routed.success,
      message: routed.message ?? routed.error ?? 'Launch attempted.',
      surface: routed.surface,
    };
  }

  return { ...result, launch };
}

async function handleReadTasks(): Promise<unknown> {
  ensureControlWorkspace();
  const store = readTaskStore();
  return { tasks: store.tasks };
}

async function handleSearchConversations(args: { query: string; limit?: number; project?: string }): Promise<unknown> {
  const query = (args.query ?? '').trim();
  if (!query) return { query: '', count: 0, results: [], note: 'Provide a non-empty query.' };
  const limit = Math.min(Math.max(1, args.limit ?? 20), 50);
  // Optional semantic re-rank (config search.semantic, default off) — identical
  // recall set, meaning-aware ordering; silently keyword-only when unavailable.
  const { searchConversationsSmart } = await import('./core/semantic-rerank.js');
  const smart = await searchConversationsSmart(query, limit, args.project);
  const results = smart.results.map((r) => ({
    project: r.project,
    sessionId: r.sessionId,
    vendor: r.vendor,
    date: r.date,
    matches: r.count,
    snippet: r.snippet,
    // 'vector' = semantic-only recall (keyword missed it); 'both'/'keyword' otherwise. Absent in keyword-only mode.
    matched: r.matched,
  }));
  return {
    query,
    count: results.length,
    ranking: smart.semantic ? 'keyword+semantic' : 'keyword',
    results,
    hint: 'Claude results resume with launch_session({ project, resume: sessionId }). Codex results (vendor:"codex") resume from the Codex CLI, e.g. `codex resume <sessionId>`.',
  };
}

async function handleConsultAgent(args: { agent: string; prompt: string; project?: string; thread_id?: string }): Promise<unknown> {
  const agent = (args.agent ?? '').trim();
  const prompt = (args.prompt ?? '').trim();
  if (!agent || !prompt) return { ok: false, error: 'Both `agent` and `prompt` are required.', agents: listAgents() };

  let cwd: string | undefined;
  if (args.project) {
    const { config } = loadConfig();
    const projects = buildProjectListFast(config);
    cwd = resolveProject(config, projects, args.project)?.path;
  }

  // Continue an existing consult conversation if the caller passed a known handle
  // for THIS agent — resume the agent's own session so it remembers prior turns.
  const handle = args.thread_id?.trim();
  const prior = handle ? getThread(handle) : null;
  const resumeId = prior && prior.agent === agent ? prior.vendorSessionId : undefined;

  const r = await consultAgent(agent, prompt, { cwd: prior?.cwd ?? cwd, resumeId });
  if (!r.ok) return { ok: false, agent, error: r.error, agents: listAgents() };

  // Record/extend the thread when the agent threaded (returned a session id).
  let threadId: string | undefined;
  let note: string | undefined;
  if (r.threaded && r.sessionId) {
    const now = Date.now();
    if (prior && resumeId) {
      threadId = prior.id;
      saveThread({ ...prior, vendorSessionId: r.sessionId, cwd: prior.cwd ?? cwd, turns: prior.turns + 1, lastTs: now });
    } else {
      threadId = randomUUID();
      saveThread({ id: threadId, agent, vendorSessionId: r.sessionId, cwd, turns: 1, createdTs: now, lastTs: now });
      if (handle) note = 'The thread_id you passed was not found (or was for a different agent); started a new thread.';
    }
  } else if (handle) {
    note = `${r.agent} does not support threaded consult — this reply has no memory of earlier turns.`;
  }

  return {
    ok: true,
    agent: r.agent,
    reply: r.output,
    ...(threadId ? { thread_id: threadId, hint: `To continue this conversation with ${r.agent} (it keeps the prior turns), call consult_agent again with thread_id="${threadId}".` } : {}),
    ...(note ? { note } : {}),
  };
}

function handleSaveScratchpad(args: { project: string; path: string; title?: string }): unknown {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const proj = resolveProject(config, projects, args.project);
  if (!proj) return { ok: false, error: 'Unknown project: ' + args.project };
  const rel = (args.path ?? '').replace(/^[\\/]+/, '');
  if (!rel) return { ok: false, error: '`path` is required.' };
  const root = path.resolve(proj.path);
  const dest = path.resolve(root, rel);
  if (dest !== root && !dest.startsWith(root + path.sep)) return { ok: false, error: 'Destination escapes the project.' };

  let content: string;
  try { content = fs.readFileSync(scratchPath(args.title), 'utf-8'); }
  catch { return { ok: false, error: 'No scratchpad found — open_scratchpad first.' }; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  } catch (e) { return { ok: false, error: String(e) }; }
  return { ok: true, savedTo: dest, project: proj.name, bytes: content.length };
}

function handleGetDashboardContext(): unknown {
  const ctx = readDashboardContext();
  if (!ctx) return { active: false, note: 'The operator has no active dashboard search/selection (or the dashboard is not open).' };
  return {
    active: true,
    query: ctx.query,
    selectedProject: ctx.selectedProject,
    resultCount: ctx.results.length,
    results: ctx.results.slice(0, 20),
    asOf: new Date(ctx.ts).toISOString(),
  };
}

function handleShowSearchInDashboard(args: { query: string; sessionIds?: string[]; note?: string }): unknown {
  const query = (args.query ?? '').trim();
  if (!query) return { ok: false, error: 'Provide a non-empty query.' };
  let results = searchConversations(query, 50);
  if (Array.isArray(args.sessionIds) && args.sessionIds.length) {
    const wanted = new Set(args.sessionIds);
    results = results.filter((r) => wanted.has(r.sessionId));
  }
  writeAgentSearch({ query, results, note: args.note, ts: Date.now() });
  return {
    ok: true,
    shown: results.length,
    note: 'Pushed to the dashboard search area; it will appear within a few seconds if the dashboard is open.',
  };
}

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{6,}$/;

/** Resolve a sessionId to its JSONL transcript path (the filename IS the id). */
function findSessionFile(sessionId: string): string | null {
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  const root = getClaudeProjectsDir();
  let slugs: string[];
  try { slugs = fs.readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const direct = path.join(root, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

function handleSendToSession(args: { session: string; message: string; autoSend?: boolean; note?: string }): unknown {
  const session = (args.session ?? '').trim();
  const message = (args.message ?? '').toString();
  if (!SAFE_SESSION_ID.test(session)) return { ok: false, error: 'Provide a valid sessionId (from get_active_sessions or search_conversations).' };
  if (!message.trim()) return { ok: false, error: 'Provide a non-empty message.' };
  writeCockpitInject({ sessionId: session, text: message, autoSend: !!args.autoSend, note: args.note, ts: Date.now() });
  return {
    ok: true,
    autoSend: !!args.autoSend,
    note: args.autoSend
      ? 'Queued for the dashboard; if that session is open as a cockpit tile, the message will be sent into it within a few seconds.'
      : 'Queued for the dashboard; if that session is open as a cockpit tile, its compose-box will be prefilled for the operator to review and send.',
  };
}

function handleReadSession(args: { session: string; turns?: number }): unknown {
  const session = (args.session ?? '').trim();
  if (!SAFE_SESSION_ID.test(session)) return { error: 'Provide a valid sessionId.' };
  const file = findSessionFile(session);
  if (!file) return { error: `Session not found: ${session}. Use get_active_sessions or search_conversations to find a valid sessionId.` };
  const turns = Math.max(1, Math.min(40, args.turns ?? 12));
  try {
    const transcript = extractTranscript(file, turns);
    return { sessionId: session, transcript: transcript || '(no readable turns yet — the session may not have produced output)' };
  } catch (err) {
    return { error: 'Failed to read session: ' + String(err) };
  }
}

async function handleUpsertTask(args: {
  id?: string;
  title?: string;
  project?: string;
  status?: 'pending' | 'in_progress' | 'done';
  notes?: string;
  due?: string;
}): Promise<unknown> {
  ensureControlWorkspace();
  const task = upsertTask(args);
  if (!task) {
    return {
      error: args.id
        ? `Task not found: "${args.id}". Use read_tasks to see existing task ids.`
        : 'A title is required to create a new task.',
    };
  }
  return { task };
}

// ── Server setup ───────────────────────────────────────────

async function main(): Promise<void> {
  initLogger();
  // Scrubbed crash telemetry (default ON, opt-out). MCP surface. Must never
  // write to stdout (that's the MCP transport) — the beacon only uses the net.
  try {
    const { config } = loadConfig();
    installErrorHandlers('mcp', config.error_reporting?.enabled !== false);
  } catch { installErrorHandlers('mcp'); }

  const server = new Server(
    { name: 'cldctrl', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Register tool list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_projects',
        description:
          'List all projects known to cldctrl with their names, filesystem paths, aliases, and group (Apps/Research/Professional/Exploring/Ungrouped, or a custom name).',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'set_project_group',
        description:
          "Set which sidebar group a project belongs to in the dashboard (e.g. Apps, Research, Professional, Exploring, or any custom group name). Use when the operator asks to organize/recategorize projects (e.g. \"put adsb-dashboard in Exploring\"). Pass group:'auto' (or empty) to clear the override and fall back to auto-categorization. Persists in config; takes effect on the dashboard's next refresh.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: { type: 'string', description: 'Project name, alias, or filesystem path' },
            group: { type: 'string', description: "Group name to assign, or 'auto' to revert to auto-categorization" },
          },
          required: ['project', 'group'],
        },
      },
      {
        name: 'get_project_context',
        description:
          'Get context for a project: recent sessions (with summaries), git status, recent commits, and open GitHub issues. Returns compact data (~1-2KB).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Project name, alias, or filesystem path',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_active_sessions',
        description:
          'List all active Claude Code sessions across all projects, with their status (active/idle) and last activity time.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'launch_session',
        description:
          'Launch (or resume) a Claude Code session for a project. When the cldctrl web dashboard is running, the session opens as a conversation tile IN the dashboard cockpit (web-first); otherwise it opens a separate terminal window. Optionally pass a prompt to start the session with context (e.g., an implementation plan from this conversation).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Project name, alias, or filesystem path',
            },
            prompt: {
              type: 'string',
              description: 'Initial prompt/context to pass to the new session',
            },
            resume: {
              type: 'string',
              description: 'Session ID to resume instead of starting a new session',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'handoff_session',
        description:
          "Hand off a conversation's work to a DIFFERENT agent (claude/codex/antigravity) — e.g. when a provider is low on tokens. Builds a brief from the session's ON-DISK state (transcript tail + git status/commits + touched files + docked notepad, plus a backlink) — so it works even if the original agent is dead — then opens a NEW cockpit tile with the chosen agent in the same project, prefilled with the brief for the operator to review and send. The original conversation is untouched. Needs the cldctrl dashboard running.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            session: {
              type: 'string',
              description: 'sessionId to hand off (from search_conversations or get_active_sessions). Claude or Codex sessions supported.',
            },
            toAgent: {
              type: 'string',
              description: 'Target agent id to continue in: claude | codex | antigravity',
            },
          },
          required: ['session', 'toAgent'],
        },
      },
      {
        name: 'convert_to_latex',
        description:
          "Convert a markdown note/draft (.md/.markdown/.txt) into a compilable LaTeX document written BESIDE it (same basename, .tex). Uses pandoc when installed. If the result has pandocMissing:true, write the .tex yourself following the returned guidance instead. Typical use: the user's docked notepad draft (its path was announced to this conversation) or any project markdown they want in LaTeX for an Overleaf project.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to the markdown file to convert',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'rescan_projects',
        description:
          'Re-run filesystem discovery (the same scan as the TUI "S" key) and merge results into the project index, so folders created or registered outside cldctrl become known. Returns counts and any newly-discovered projects. Use after creating a project folder by hand, or when list_projects is missing something.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'create_project',
        description:
          'Create and register a new project end-to-end so it is immediately usable by launch_session: creates the folder if missing, seeds a CLAUDE.md from the provided context, runs git init, and registers it in cldctrl config. Idempotent — safe to re-run on an existing project (will not overwrite CLAUDE.md or re-init git). Optionally launches a Claude Code session in it.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Absolute filesystem path for the project. Created (recursively) if it does not exist.',
            },
            name: {
              type: 'string',
              description: 'Display name. Defaults to a metadata-derived name or the folder basename.',
            },
            context: {
              type: 'string',
              description: 'Seed content for the project CLAUDE.md — background and starter instructions for the new project.',
            },
            launch: {
              type: 'boolean',
              description: 'If true, launch a new Claude Code session in the project after creating it.',
            },
            prompt: {
              type: 'string',
              description: 'Initial prompt to pass to the launched session (only used when launch is true).',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'hide_project',
        description:
          'Hide a project from every cldctrl view (list_projects, TUI, scans). Use to clean up noise — stray folders, library directories, or anything that should not appear as a project. Durable: the project stays hidden across rescans. Reversible with unhide_project.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Project name, alias, or filesystem path to hide.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'unhide_project',
        description:
          'Restore a previously hidden project so it appears again. Pass the full path, or just the folder name to match by basename. Returns the remaining hidden list.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Full filesystem path (matched exactly) or folder basename (matches any hidden entry with that name).',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'read_tasks',
        description:
          "Read the control plane's persistent task list: cross-project tasks the operator is tracking, each with a status (pending/in_progress/done), optional project, and notes.",
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'upsert_task',
        description:
          "Create or update a control plane task. Omit 'id' to create a new task (title required); pass an existing 'id' to update that task's fields. Use to record to-dos, decisions, progress, and handoffs into projects.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: {
              type: 'string',
              description: 'Existing task id to update. Omit to create a new task.',
            },
            title: {
              type: 'string',
              description: 'Short task title. Required when creating.',
            },
            project: {
              type: 'string',
              description: 'Project name/alias this task relates to, if any.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done'],
              description: 'Task status.',
            },
            notes: {
              type: 'string',
              description: 'Free-form context, progress notes, or links.',
            },
            due: {
              type: 'string',
              description: "Deadline as ISO date 'YYYY-MM-DD' (or datetime). Drives background deadline nudges. Pass an empty string to clear.",
            },
          },
        },
      },
      {
        name: 'search_conversations',
        description:
          'Search across ALL of your past coding-agent conversations (every project) to answer "where did we talk about / work on / build X?". VENDOR-NEUTRAL: spans Claude Code AND OpenAI Codex CLI sessions in one index (each result tagged with `vendor`), so it finds work done in either agent. Searches the full conversation CONTENT — your prompts, the assistant\'s replies, tool names, and touched file paths — so it matches what was *done*, not just what was *asked*. Ranked by relevance (sessions matching more of your terms rank first), then recency. Terms are OR\'d, so adding words refines instead of zeroing out. Returns matching sessions with project, vendor, date, match count, a snippet, and a sessionId. Resume Claude results via launch_session({ resume }); Codex results via the Codex CLI.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'What to look for, e.g. "diff renderer flicker" or "dark light theme conversion".',
            },
            project: {
              type: 'string',
              description: 'Optional: restrict results to a project (name or path substring).',
            },
            limit: {
              type: 'number',
              description: 'Max sessions to return (default 20, max 50).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_agents',
        description:
          "List the CLI coding agents cldctrl can drive (claude/codex/gemini), whether each is currently connected, the resolved executable path, and how it was found (config override / env var / PATH / app-bundle). Use to check whether Codex/Gemini are wired up before consult_agent, or to diagnose why one isn't found.",
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'set_agent_path',
        description:
          "Connect a CLI agent by saving the full path to its executable in cldctrl config (highest-priority override). Use when an agent isn't auto-detected: find its binary (e.g. search the filesystem for codex/codex.exe — the OpenAI Codex app keeps it under %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<hash>\\codex.exe), then call this with that path. After this, consult_agent and cockpit sessions can use it.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent: { type: 'string', description: "Agent id: 'codex', 'gemini', or 'claude'." },
            path: { type: 'string', description: 'Absolute path to the agent executable.' },
          },
          required: ['agent', 'path'],
        },
      },
      {
        name: 'consult_agent',
        description:
          "Get a second opinion from another installed CLI coding agent (e.g. OpenAI Codex or Gemini) on an idea, plan, or piece of writing. Runs your prompt through that agent's FULL CLI non-interactively (it brings its own config, memories, MCP tools, and — read-only — any repo files if a project is given), and returns its complete reply. The other agent does NOT see this conversation, so include the relevant context in `prompt`. Use when the operator says things like \"check in with Codex on this plan\" or \"what would Codex think of this draft\". This is advisory only — the consult runs read-only and cannot modify files.\n\nTHREADED CONSULT (Codex & Claude): the result includes a `thread_id`. To keep an ONGOING back-and-forth — e.g. across successive rounds of edits on a draft — pass that `thread_id` back on the next consult. The agent then RESUMES its own session and remembers the earlier turns, so you only send what's NEW (the latest revision / question) instead of re-pasting the whole history each time. Omit `thread_id` (or leave it out) to start a fresh, stateless consult. (Gemini is one-shot only.)",
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent: { type: 'string', description: "Which agent to consult: 'codex', 'gemini', or 'claude'." },
            prompt: { type: 'string', description: 'The full question/plan/draft to send. For a NEW consult include all needed context (the agent cannot see this conversation); when continuing a thread_id, send only what is new since the last turn.' },
            project: { type: 'string', description: 'Optional project name/alias/path to run the consult in, giving the agent read-only access to that repo for context. (On a resumed thread the original project is reused.)' },
            thread_id: { type: 'string', description: 'Optional. The `thread_id` returned by a previous consult_agent call — pass it to CONTINUE that conversation (the agent resumes its session and remembers prior turns). Omit to start fresh.' },
          },
          required: ['agent', 'prompt'],
        },
      },
      {
        name: 'open_scratchpad',
        description:
          "Pop open a shared markdown scratchpad next to the chat in the operator's cockpit, for collaboratively drafting text (an email, abstract, notes, etc.). Seed it with `content` (markdown). The operator sees it live, can edit it, and you can keep editing the SAME file with Write/Edit at the returned path — it live-reloads both ways. Use when the operator says \"let's draft X\" / \"open a scratchpad\". When the draft is worth keeping, use save_scratchpad to put it in a project.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: { type: 'string', description: 'Initial markdown content for the draft (optional).' },
            title: { type: 'string', description: "Short title (becomes the file name, e.g. 'cold-email'). Defaults to 'Scratchpad'." },
          },
        },
      },
      {
        name: 'save_scratchpad',
        description:
          "Save the CURRENT scratchpad (including the operator's own edits) into a project — use when the draft is a keeper. Reads the live scratchpad file and writes it to <project>/<path>.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: { type: 'string', description: 'Project name/alias/path to save into.' },
            path: { type: 'string', description: "Relative destination path within the project, e.g. 'drafts/cold-email.md'." },
            title: { type: 'string', description: "The scratchpad title used in open_scratchpad (defaults to 'Scratchpad')." },
          },
          required: ['project', 'path'],
        },
      },
      {
        name: 'list_note_revisions',
        description:
          "List the git version history of a cldctrl notepad file (the docked scratchpad you were told the path of). Returns revisions newest-first with a short hash, ISO timestamp, and subject. Notes are auto-snapshotted to git, so this is how you (or the operator) recover an earlier draft. Pair with restore_note. `path` is the absolute notepad file path.",
        inputSchema: {
          type: 'object' as const,
          properties: { path: { type: 'string', description: 'Absolute path to the notepad file.' } },
          required: ['path'],
        },
      },
      {
        name: 'restore_note',
        description:
          "Restore a cldctrl notepad to an earlier version from its git history. Pass the notepad `path` and a revision hash from list_note_revisions (or omit `rev` to roll back to the immediately previous version). Writes the old content back to the file (which the operator's cockpit live-reloads) and snapshots the restore. Use when the operator says 'undo'/'go back to the earlier draft'.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Absolute path to the notepad file.' },
            rev: { type: 'string', description: 'Commit hash to restore (from list_note_revisions). Omit for the previous version.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'get_dashboard_context',
        description:
          "See what the operator is currently looking at in the cldctrl browser dashboard: their active conversation search query, the matching sessions they're seeing, and any selected project. Use this when they say things like \"narrow down what I'm looking at\" or \"help me with this search\" so you act on their actual screen instead of guessing.",
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'show_search_in_dashboard',
        description:
          "Surface a conversation search in the operator's browser dashboard search area (the reverse of get_dashboard_context). Runs the search and pushes the results to their screen, optionally narrowed to a curated subset of sessionIds, with a short note explaining what you're showing. Use when you've found relevant past conversations and want the operator to see them.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'The search query to run and display.',
            },
            sessionIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: narrow the displayed results to just these sessionIds (a curated subset).',
            },
            note: {
              type: 'string',
              description: 'Optional short note shown above the results, e.g. "The 3 sessions where we built the diff renderer".',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'send_to_session',
        description:
          "Inject a message into a RUNNING conversation open in the operator's cockpit (the coordination primitive). Unlike consult_agent/launch_session — which spawn a fresh, ephemeral, headless agent — this talks to a persistent session the operator is watching: it drops your text into that tile's compose-box. By default it PREFILLS for the operator to review and send (confirm-before-act); pass autoSend:true to submit immediately. Target by sessionId (from get_active_sessions or search_conversations). The session must currently be open as a cockpit tile in the browser dashboard; if it isn't, the operator is told. Use to hand a follow-up, a finding, or a coordinated instruction to another live conversation.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            session: { type: 'string', description: 'The sessionId of the running cockpit conversation to message.' },
            message: { type: 'string', description: 'The text to inject into that session.' },
            autoSend: { type: 'boolean', description: 'Submit immediately instead of prefilling for operator confirmation. Default false (prefill + confirm).' },
            note: { type: 'string', description: 'Optional short note for context (shown to the operator).' },
          },
          required: ['session', 'message'],
        },
      },
      {
        name: 'read_session',
        description:
          "Read back the recent turns of a specific session by sessionId — to VERIFY a session you launched actually received its kickoff prompt and is working, or to catch up on what a running conversation has done. Returns the latest user/assistant exchanges (most recent last). For finding WHICH past conversation discussed something, use search_conversations instead; this is for reading one known session.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            session: { type: 'string', description: 'The sessionId to read.' },
            turns: { type: 'number', description: 'How many recent messages to return (default 12, max 40).' },
          },
          required: ['session'],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'list_projects':
          result = await handleListProjects();
          break;
        case 'set_project_group':
          result = await handleSetProjectGroup(args as { project: string; group: string });
          break;
        case 'get_project_context':
          result = await handleGetProjectContext(args as { project: string });
          break;
        case 'get_active_sessions':
          result = await handleGetActiveSessions();
          break;
        case 'launch_session':
          result = await handleLaunchSession(
            args as { project: string; prompt?: string; resume?: string },
          );
          break;
        case 'rescan_projects':
          result = await handleRescanProjects();
          break;
        case 'create_project':
          result = await handleCreateProject(
            args as {
              path: string;
              name?: string;
              context?: string;
              launch?: boolean;
              prompt?: string;
            },
          );
          break;
        case 'hide_project':
          result = await handleHideProject(args as { project: string });
          break;
        case 'unhide_project':
          result = await handleUnhideProject(args as { project: string });
          break;
        case 'search_conversations':
          result = await handleSearchConversations(args as { query: string; limit?: number; project?: string });
          break;
        case 'list_agents':
          result = { agents: listAgents() };
          break;
        case 'set_agent_path': {
          const a = args as { agent: string; path: string };
          const r = setAgentPath(a.agent, a.path);
          result = r.ok ? { ok: true, agents: listAgents() } : { ok: false, error: r.error, agents: listAgents() };
          break;
        }
        case 'consult_agent':
          result = await handleConsultAgent(args as { agent: string; prompt: string; project?: string; thread_id?: string });
          break;
        case 'open_scratchpad': {
          const a = args as { content?: string; title?: string };
          const p = openScratchpad(a.content, a.title);
          result = { ok: true, path: p, note: 'Opened in the dashboard cockpit. Edit this file (Write/Edit) to update the draft — it live-reloads. Call save_scratchpad to keep it in a project.' };
          break;
        }
        case 'save_scratchpad':
          result = handleSaveScratchpad(args as { project: string; path: string; title?: string });
          break;
        case 'list_note_revisions': {
          const a = args as { path: string };
          const revs = await noteHistory(a.path);
          result = revs.length
            ? { ok: true, path: a.path, revisions: revs }
            : { ok: true, path: a.path, revisions: [], note: 'No history (file not git-versioned yet, or git unavailable).' };
          break;
        }
        case 'restore_note': {
          const a = args as { path: string; rev?: string };
          let rev = a.rev;
          if (!rev) { // no rev → the immediately previous version
            const revs = await noteHistory(a.path, 2);
            if (revs.length < 2) { result = { ok: false, error: 'No previous version to roll back to.' }; break; }
            rev = revs[1].hash;
          }
          result = await restoreNoteRevision(a.path, rev);
          break;
        }
        case 'get_dashboard_context':
          result = handleGetDashboardContext();
          break;
        case 'show_search_in_dashboard':
          result = handleShowSearchInDashboard(args as { query: string; sessionIds?: string[]; note?: string });
          break;
        case 'send_to_session':
          result = handleSendToSession(args as { session: string; message: string; autoSend?: boolean; note?: string });
          break;
        case 'read_session':
          result = handleReadSession(args as { session: string; turns?: number });
          break;
        case 'read_tasks':
          result = await handleReadTasks();
          break;
        case 'handoff_session':
          result = await handleHandoffSession(args as { session: string; toAgent: string });
          break;
        case 'convert_to_latex':
          result = await handleConvertToLatex(args as { path: string });
          break;
        case 'upsert_task':
          result = await handleUpsertTask(
            args as {
              id?: string;
              title?: string;
              project?: string;
              status?: 'pending' | 'in_progress' | 'done';
              notes?: string;
              due?: string;
            },
          );
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      log('error', { function: 'mcp-tool', tool: name, message: String(err) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', { message: 'cldctrl MCP server started' });
}

main().catch((err) => {
  process.stderr.write(`cldctrl MCP server fatal error: ${err}\n`);
  process.exit(1);
});
