/**
 * A two-way bridge between the browser dashboard and the cldctrl control-plane
 * agent, via two small JSON files in the control workspace:
 *
 *   dashboard-context.json  (dashboard → agent)  what the user is searching /
 *                           viewing right now, so the agent can "see your screen".
 *   agent-search.json       (agent → dashboard)  a search the agent wants to
 *                           surface in the dashboard's search area.
 *
 * Separate files so neither side clobbers the other. Both carry a `ts` so the
 * reader can tell when something is new.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getControlDir, ensureControlWorkspace } from './control.js';
import type { SearchResult } from './conversation-search.js';

const CONTEXT_FILE = 'dashboard-context.json';
const AGENT_SEARCH_FILE = 'agent-search.json';

export interface DashboardContext {
  query: string;
  results: SearchResult[];
  selectedProject: string | null;
  ts: number;
}

export interface AgentSearch {
  query: string;
  results: SearchResult[];
  note?: string;
  ts: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(getControlDir(), file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureControlWorkspace();
  fs.writeFileSync(path.join(getControlDir(), file), JSON.stringify(data), 'utf-8');
}

export function writeDashboardContext(ctx: DashboardContext): void { writeJson(CONTEXT_FILE, ctx); }
export function readDashboardContext(): DashboardContext | null { return readJson<DashboardContext>(CONTEXT_FILE); }

export function writeAgentSearch(s: AgentSearch): void { writeJson(AGENT_SEARCH_FILE, s); }
export function readAgentSearch(): AgentSearch | null { return readJson<AgentSearch>(AGENT_SEARCH_FILE); }
