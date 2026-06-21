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
import { loadConfig } from './config.js';
import { buildProjectListFast, buildProjectList } from './core/projects.js';
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
import { readDashboardContext, writeAgentSearch } from './core/dashboard-bridge.js';
import { readDaemonCache } from './core/background.js';
import { normalizePathForCompare } from './core/platform.js';
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
  }));
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

  let launch: { success: boolean; message: string } | undefined;
  if (args.launch) {
    const launched = launchAndTrack({
      projectPath: result.project.path,
      isNew: true,
      prompt: args.prompt,
    });
    launch = { success: launched.success, message: launched.message };
  }

  return { ...result, launch };
}

async function handleReadTasks(): Promise<unknown> {
  ensureControlWorkspace();
  const store = readTaskStore();
  return { tasks: store.tasks };
}

function handleSearchConversations(args: { query: string; limit?: number; project?: string }): unknown {
  const query = (args.query ?? '').trim();
  if (!query) return { query: '', count: 0, results: [], note: 'Provide a non-empty query.' };
  const limit = Math.min(Math.max(1, args.limit ?? 20), 50);
  const results = searchConversations(query, limit, args.project).map((r) => ({
    project: r.project,
    sessionId: r.sessionId,
    date: r.date,
    matches: r.count,
    snippet: r.snippet,
  }));
  return {
    query,
    count: results.length,
    results,
    hint: 'Resume any result with launch_session({ project, resume: sessionId }).',
  };
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
          'List all projects known to cldctrl with their names, filesystem paths, and aliases.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
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
          'Launch a new Claude Code session in a separate terminal window for a project. Optionally pass a prompt to start the session with context (e.g., an implementation plan from this conversation).',
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
          'Search across ALL of your past Claude Code conversations (every project) to answer "where did we talk about / work on / build X?". Searches the full conversation CONTENT — your prompts, the assistant\'s replies, tool names, and touched file paths — so it matches what was *done*, not just what was *asked*. Ranked by relevance (sessions matching more of your terms rank first), then recency. Terms are OR\'d, so adding words refines instead of zeroing out. Returns matching sessions with project, date, match count, a snippet, and a sessionId you can pass to launch_session({ resume }) to pick the conversation back up.',
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
          result = handleSearchConversations(args as { query: string; limit?: number; project?: string });
          break;
        case 'get_dashboard_context':
          result = handleGetDashboardContext();
          break;
        case 'show_search_in_dashboard':
          result = handleShowSearchInDashboard(args as { query: string; sessionIds?: string[]; note?: string });
          break;
        case 'read_tasks':
          result = await handleReadTasks();
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
