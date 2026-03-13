/**
 * Config loading, Zod validation, migration v1→v4, atomic save, first-run.
 * Compatible with the PowerShell config.json schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { CONFIG_VERSION } from './constants.js';
import { checkConfigDirPermissions } from './core/platform.js';
import type { Config } from './types.js';

// ── Zod schema ──────────────────────────────────────────────

const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  hotkey: z.string().optional(),
  alias: z.string().optional(),
});

const ConfigSchema = z.object({
  config_version: z.number().int().min(1).max(CONFIG_VERSION),
  projects: z.array(ProjectConfigSchema).default([]),
  hidden_projects: z.array(z.string()).default([]),
  launch: z.object({
    explorer: z.boolean().default(true),
    vscode: z.boolean().default(true),
    claude: z.boolean().default(true),
  }).default({}),
  icon_color: z.string().default('#DA8F4E'),
  global_hotkey: z.object({
    modifiers: z.string().default('Ctrl'),
    key: z.string().default('Up'),
  }).default({}),
  project_manager: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  daily_budget_tokens: z.number().optional(),
  features: z.object({
    rate_limit_bars: z.boolean().default(true),
    cost_estimates: z.boolean().default(true),
    code_stats: z.boolean().default(true),
    calendar_heatmap: z.boolean().default(true),
    live_session_tailing: z.boolean().default(true),
    auto_discovery: z.boolean().default(true),
    commands_section: z.boolean().default(true),
    animations: z.boolean().default(true),
  }).default({}).optional(),
  notifications: z.object({
    github_issues: z.object({
      enabled: z.boolean().default(true),
      poll_interval_minutes: z.number().default(5),
    }).default({}),
    usage_stats: z.object({
      enabled: z.boolean().default(true),
      show_tooltip: z.boolean().default(true),
    }).default({}),
  }).default({}),
});

// ── Feature flag helper ────────────────────────────────────

const FEATURE_DEFAULTS: Record<string, boolean> = {
  rate_limit_bars: true,
  cost_estimates: true,
  code_stats: true,
  calendar_heatmap: true,
  live_session_tailing: true,
  auto_discovery: true,
  commands_section: true,
  animations: true,
};

/** Check if a feature is enabled (defaults to true if not configured). */
export function isFeatureEnabled(config: Config, feature: string): boolean {
  const val = config.features?.[feature as keyof typeof config.features];
  if (val !== undefined) return val as boolean;
  return FEATURE_DEFAULTS[feature] ?? true;
}

// ── Config directory resolution ─────────────────────────────

let configDirOverride: string | null = null;
let configDirCached: string | null = null;

export function setConfigDir(dir: string): void {
  configDirOverride = dir;
  configDirCached = null; // bust cache on override
}

export function getConfigDir(): string {
  if (configDirCached) return configDirCached;

  // Environment variable override
  // Support both new and legacy env var names
  const envDir = process.env.CLDCTRL_CONFIG_DIR ?? process.env.CLAUDEDOCK_CONFIG_DIR;
  if (envDir) {
    // Security: reject path traversal BEFORE resolve (resolve removes ..)
    if (envDir.includes('..')) {
      throw new Error('CLDCTRL_CONFIG_DIR must not contain ".." segments');
    }
    configDirCached = path.resolve(envDir);
    return configDirCached;
  }

  if (configDirOverride) {
    configDirCached = configDirOverride;
    return configDirCached;
  }

  // Platform-appropriate config location
  // Check for legacy 'claudedock' dir first, then use 'cldctrl'
  let result: string;
  const platform = os.platform();
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const legacy = path.join(appData, 'claudedock');
    result = fs.existsSync(legacy) ? legacy : path.join(appData, 'cldctrl');
  } else if (platform === 'darwin') {
    const legacy = path.join(os.homedir(), '.config', 'claudedock');
    result = fs.existsSync(legacy) ? legacy : path.join(os.homedir(), '.config', 'cldctrl');
  } else {
    // Linux/other: XDG_CONFIG_HOME or ~/.config
    const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    const legacy = path.join(xdgConfig, 'claudedock');
    result = fs.existsSync(legacy) ? legacy : path.join(xdgConfig, 'cldctrl');
  }

  configDirCached = result;
  return result;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

// ── Migration ───────────────────────────────────────────────

function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const version = (raw.config_version as number) ?? 1;

  if (version < 2) {
    // v1→v2: add hidden_projects
    raw.hidden_projects = raw.hidden_projects ?? [];
    raw.config_version = 2;
  }

  if ((raw.config_version as number) < 3) {
    // v2→v3: add global_hotkey, project_manager
    raw.global_hotkey = raw.global_hotkey ?? { modifiers: 'Ctrl', key: 'Up' };
    raw.project_manager = raw.project_manager ?? { enabled: true };
    raw.config_version = 3;
  }

  if ((raw.config_version as number) < 4) {
    // v3→v4: add notifications
    raw.notifications = raw.notifications ?? {
      github_issues: { enabled: true, poll_interval_minutes: 5 },
      usage_stats: { enabled: true, show_tooltip: true },
    };
    raw.config_version = 4;
  }

  return raw;
}

// ── Default config ──────────────────────────────────────────

export function createDefaultConfig(): Config {
  return {
    config_version: CONFIG_VERSION,
    projects: [],
    hidden_projects: [],
    launch: { explorer: true, vscode: true, claude: true },
    icon_color: '#DA8F4E',
    global_hotkey: { modifiers: 'Ctrl', key: 'Up' },
    project_manager: { enabled: true },
    notifications: {
      github_issues: { enabled: true, poll_interval_minutes: 5 },
      usage_stats: { enabled: true, show_tooltip: true },
    },
  };
}

// ── Load ────────────────────────────────────────────────────

export function loadConfig(): { config: Config; isNew: boolean; migrated: boolean } {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const config = createDefaultConfig();
    return { config, isNew: true, migrated: false };
  }

  // Check config dir permissions on Unix
  const permCheck = checkConfigDirPermissions(getConfigDir());
  if (!permCheck.safe && permCheck.warning) {
    process.stderr.write(`Warning: ${permCheck.warning}\n`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`Warning: config file is corrupt, using defaults. Error: ${err}\n`);
    return { config: createDefaultConfig(), isNew: false, migrated: false };
  }

  const originalVersion = raw.config_version ?? 1;
  const migrated = migrateConfig(raw);

  let parsed: z.infer<typeof ConfigSchema>;
  try {
    parsed = ConfigSchema.parse(migrated);
  } catch (err) {
    process.stderr.write(`Warning: config validation failed, using defaults.\n`);
    return { config: createDefaultConfig(), isNew: false, migrated: false };
  }

  return {
    config: parsed as Config,
    isNew: false,
    migrated: (originalVersion !== parsed.config_version),
  };
}

// ── Save (atomic: write tmp → fsync → rename) ──────────────

export function saveConfig(config: Config): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // Ensure directory exists
  fs.mkdirSync(configDir, { recursive: true });

  const json = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = configPath + '.tmp';

  // Write to temp, fsync, rename (atomic on same filesystem)
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

// ── Validation helper ───────────────────────────────────────

export function validateConfig(data: unknown): { success: boolean; errors?: string[] } {
  const result = ConfigSchema.safeParse(data);
  if (result.success) return { success: true };
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
