/**
 * Read Claude Code's local usage data: subscription tier, daily token counts.
 * Sources: ~/.claude/.credentials.json, ~/.claude/stats-cache.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './platform.js';
import { log } from './logger.js';

// ── Types ──────────────────────────────────────────────────

export type SubscriptionType = 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown';

export interface ClaudeTier {
  subscription: SubscriptionType;
  rateLimitTier: string;
  /** Estimated 5-hour rolling window token limit for this tier. */
  windowLimit: number;
  /** Reasonable daily budget estimate (used as default when user hasn't configured one). */
  dailyDefault: number;
}

export interface ClaudeStatsCache {
  lastComputedDate: string;
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
  }>;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>;
  totalSessions: number;
  totalMessages: number;
}

// ── Rate limit defaults per tier ─────────────────────────
// These are approximate. Actual limits are 5-hour rolling windows
// that vary by model. Users can override via daily_budget_tokens.
// Values here represent rough daily usage budgets (not exact API limits).

const TIER_DEFAULTS: Record<string, { windowLimit: number; dailyDefault: number }> = {
  // Free tier: very conservative
  'free':                         { windowLimit:    200_000, dailyDefault:    500_000 },
  // Pro plan
  'default_claude_pro':           { windowLimit:  1_000_000, dailyDefault:  2_500_000 },
  // Max plan (1x)
  'default_claude_max':           { windowLimit:  5_000_000, dailyDefault: 10_000_000 },
  // Max plan (5x multiplier)
  'default_claude_max_5x':        { windowLimit: 25_000_000, dailyDefault: 50_000_000 },
  // Team/Enterprise (conservative defaults)
  'default_claude_team':          { windowLimit:  5_000_000, dailyDefault: 10_000_000 },
  'default_claude_enterprise':    { windowLimit: 10_000_000, dailyDefault: 25_000_000 },
};

// ── Read credentials ────────────────────────────────────

let _cachedTier: ClaudeTier | null | undefined;

function getClaudeDir(): string {
  return path.join(getHomeDir(), '.claude');
}

function parseSubscriptionType(raw: string | undefined): SubscriptionType {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower === 'free') return 'free';
  if (lower === 'pro') return 'pro';
  if (lower === 'max') return 'max';
  if (lower === 'team') return 'team';
  if (lower === 'enterprise') return 'enterprise';
  return 'unknown';
}

/**
 * Read Claude Code's subscription tier from ~/.claude/.credentials.json.
 * Result is cached for the process lifetime.
 */
export function readClaudeTier(): ClaudeTier | null {
  if (_cachedTier !== undefined) return _cachedTier;

  try {
    const credPath = path.join(getClaudeDir(), '.credentials.json');
    if (!fs.existsSync(credPath)) {
      _cachedTier = null;
      return null;
    }

    const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const oauth = raw?.claudeAiOauth;
    if (!oauth) {
      _cachedTier = null;
      return null;
    }

    const subscription = parseSubscriptionType(oauth.subscriptionType);
    const rateLimitTier: string = oauth.rateLimitTier ?? '';

    // Look up limits: try exact tier name first, then fall back by subscription type
    const limits = TIER_DEFAULTS[rateLimitTier]
      ?? TIER_DEFAULTS[`default_claude_${subscription}`]
      ?? TIER_DEFAULTS['free'];

    _cachedTier = {
      subscription,
      rateLimitTier,
      windowLimit: limits.windowLimit,
      dailyDefault: limits.dailyDefault,
    };

    log('claude_tier_detected', {
      subscription,
      rateLimitTier,
      dailyDefault: limits.dailyDefault,
    });

    return _cachedTier;
  } catch (err) {
    log('claude_tier_error', { message: String(err) });
    _cachedTier = null;
    return null;
  }
}

// ── Read stats cache ─────────────────────────────────────

/**
 * Read Claude Code's stats-cache.json for daily model token data.
 * This file is computed by Claude Code on demand (may be stale).
 */
export function readClaudeStatsCache(): ClaudeStatsCache | null {
  try {
    const cachePath = path.join(getClaudeDir(), 'stats-cache.json');
    if (!fs.existsSync(cachePath)) return null;

    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!raw || raw.version !== 2) return null;

    return {
      lastComputedDate: raw.lastComputedDate ?? '',
      dailyModelTokens: raw.dailyModelTokens ?? [],
      modelUsage: raw.modelUsage ?? {},
      totalSessions: raw.totalSessions ?? 0,
      totalMessages: raw.totalMessages ?? 0,
    };
  } catch (err) {
    log('claude_stats_cache_error', { message: String(err) });
    return null;
  }
}

/**
 * Get the effective daily budget: user-configured > auto-detected tier > fallback.
 */
export function getEffectiveDailyBudget(configBudget?: number): number {
  if (configBudget && configBudget > 0) return configBudget;

  const tier = readClaudeTier();
  if (tier) return tier.dailyDefault;

  return 1_000_000; // 1M fallback
}

/**
 * Get a display label for the subscription tier.
 */
export function getTierLabel(tier: ClaudeTier | null): string {
  if (!tier) return '';

  const sub = tier.subscription;
  const multiplier = tier.rateLimitTier.includes('5x') ? ' 5x' : '';

  switch (sub) {
    case 'max': return `Max${multiplier}`;
    case 'pro': return 'Pro';
    case 'team': return 'Team';
    case 'enterprise': return 'Enterprise';
    case 'free': return 'Free';
    default: return '';
  }
}

/**
 * Get today's token total from Claude's stats-cache (if fresh enough).
 * Returns null if cache is stale (>1 day old).
 */
export function getTodayFromStatsCache(): { tokens: number; models: Record<string, number> } | null {
  const cache = readClaudeStatsCache();
  if (!cache) return null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Check freshness: only trust if lastComputedDate is today
  if (cache.lastComputedDate !== today) return null;

  const entry = cache.dailyModelTokens.find(d => d.date === today);
  if (!entry) return null;

  let total = 0;
  for (const count of Object.values(entry.tokensByModel)) {
    total += count;
  }

  return { tokens: total, models: entry.tokensByModel };
}

// ── Live rate limit probe ─────────────────────────────────
// Makes a minimal API call (Haiku, 1 token) to read rate-limit response headers.
// Anthropic uses unified rate limit headers with utilization percentages.

export interface RateLimitInfo {
  /** 5-hour rolling window utilization (0.0 - 1.0+) */
  fiveHourUtil: number;
  /** 5-hour window status: "allowed" | "throttled" etc */
  fiveHourStatus: string;
  /** When the 5-hour window resets (epoch seconds) */
  fiveHourReset: number;
  /** 7-day rolling window utilization (0.0 - 1.0+) */
  sevenDayUtil: number;
  /** 7-day window status */
  sevenDayStatus: string;
  /** When the 7-day window resets (epoch seconds) */
  sevenDayReset: number;
  /** Whether fallback model downgrade is available (feature flag, not "currently using") */
  fallbackAvailable: boolean;
  /** Utilization threshold at which model fallback kicks in (0.0-1.0) */
  fallbackPercentage: number;
  /** Overage (paid extra tokens) utilization (0.0 - 1.0+). 0 = not using extra. */
  overageUtil: number;
  /** Overage status: "allowed" | "not_available" etc */
  overageStatus: string;
  /** When the overage window resets (epoch seconds) */
  overageReset: number;
  /** Human-readable overage reset date (e.g. "23d (Apr 1)") */
  overageResetIn: string;
  /** Which window is the representative (binding) constraint */
  representativeClaim: string;
  /** Overall status */
  overallStatus: string;
  /** Human-readable time until 5h window resets */
  fiveHourResetIn: string;
  /** Human-readable time until 7d window resets */
  sevenDayResetIn: string;
  /** When this data was fetched */
  fetchedAt: number;
}

// Cache: avoid repeated probes
let _rateLimitCache: RateLimitInfo | null = null;
const RATE_LIMIT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function readAccessToken(): string | null {
  try {
    const credPath = path.join(getClaudeDir(), '.credentials.json');
    if (!fs.existsSync(credPath)) return null;
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    return raw?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export function formatResetEpoch(epochSeconds: number): string {
  const resetDate = new Date(epochSeconds * 1000);
  const diffMs = resetDate.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  // Format the clock time
  const h = resetDate.getHours();
  const m = resetDate.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const clockStr = m > 0 ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;

  const relStr = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
  return `${relStr} (${clockStr})`;
}

/** Format a reset epoch that may be days/weeks away (for overage monthly resets). */
function formatResetDate(epochSeconds: number): string {
  if (epochSeconds <= 0) return '';
  const resetDate = new Date(epochSeconds * 1000);
  const diffMs = resetDate.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const days = Math.floor(diffMs / 86_400_000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateStr = `${months[resetDate.getMonth()]} ${resetDate.getDate()}`;
  if (days === 0) return 'today';
  if (days === 1) return `tomorrow (${dateStr})`;
  return `${days}d (${dateStr})`;
}

/**
 * Probe the Anthropic API for live rate limit data.
 * Makes a minimal Haiku request (1 output token) to read unified rate limit headers.
 * Returns cached result if fresh enough.
 */
export async function probeRateLimits(): Promise<RateLimitInfo | null> {
  // Return cache if fresh
  if (_rateLimitCache && (Date.now() - _rateLimitCache.fetchedAt) < RATE_LIMIT_CACHE_TTL) {
    return _rateLimitCache;
  }

  const token = readAccessToken();
  if (!token) return _rateLimitCache;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    // Parse unified rate limit headers
    const fiveHourUtil = parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization') ?? '-1');
    const fiveHourStatus = response.headers.get('anthropic-ratelimit-unified-5h-status') ?? '';
    const fiveHourReset = parseInt(response.headers.get('anthropic-ratelimit-unified-5h-reset') ?? '0', 10);
    const sevenDayUtil = parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization') ?? '-1');
    const sevenDayStatus = response.headers.get('anthropic-ratelimit-unified-7d-status') ?? '';
    const sevenDayReset = parseInt(response.headers.get('anthropic-ratelimit-unified-7d-reset') ?? '0', 10);
    const fallback = response.headers.get('anthropic-ratelimit-unified-fallback') ?? '';
    const fallbackPct = parseFloat(response.headers.get('anthropic-ratelimit-unified-fallback-percentage') ?? '0');
    const overageUtil = parseFloat(response.headers.get('anthropic-ratelimit-unified-overage-utilization') ?? '0');
    const overageStatus = response.headers.get('anthropic-ratelimit-unified-overage-status') ?? '';
    const overageReset = parseInt(response.headers.get('anthropic-ratelimit-unified-overage-reset') ?? '0', 10);
    const representativeClaim = response.headers.get('anthropic-ratelimit-unified-representative-claim') ?? '';
    const overallStatus = response.headers.get('anthropic-ratelimit-unified-status') ?? '';

    if (fiveHourUtil < 0) {
      log('rate_limit_probe_no_headers', { status: response.status });
      return _rateLimitCache;
    }

    _rateLimitCache = {
      fiveHourUtil,
      fiveHourStatus,
      fiveHourReset,
      sevenDayUtil,
      sevenDayStatus,
      sevenDayReset,
      fallbackAvailable: fallback === 'available',
      fallbackPercentage: fallbackPct,
      overageUtil,
      overageStatus,
      overageReset,
      overageResetIn: formatResetDate(overageReset),
      representativeClaim,
      overallStatus,
      fiveHourResetIn: formatResetEpoch(fiveHourReset),
      sevenDayResetIn: formatResetEpoch(sevenDayReset),
      fetchedAt: Date.now(),
    };

    log('rate_limit_probe_success', {
      fiveHourUtil,
      sevenDayUtil,
      overageUtil,
      overallStatus,
      fiveHourResetIn: _rateLimitCache.fiveHourResetIn,
    });

    return _rateLimitCache;
  } catch (err) {
    log('rate_limit_probe_error', { message: String(err) });
    return _rateLimitCache;
  }
}

/** Get the cached rate limit info without making a new probe. */
export function getCachedRateLimits(): RateLimitInfo | null {
  return _rateLimitCache;
}

// ── Global state (~/.claude.json) — per-project cost data ─────

let _globalStateCache: Record<string, unknown> | null = null;
let _globalStateMtime = 0;

function readGlobalState(): Record<string, unknown> | null {
  const p = path.join(getHomeDir(), '.claude.json');
  try {
    const stat = fs.statSync(p);
    if (_globalStateCache && stat.mtimeMs === _globalStateMtime) return _globalStateCache;
    _globalStateCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    _globalStateMtime = stat.mtimeMs;
    return _globalStateCache;
  } catch {
    return null;
  }
}

export interface ProjectCostInfo {
  /** Actual USD cost for the most recent session on this project. */
  cost: number;
  /** Per-model token breakdown (model → { input, output, cacheRead, cacheWrite }). */
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/**
 * Get the last cost + model usage for a project from ~/.claude.json.
 * Returns null if data not available.
 */
export function getProjectLastCost(projectPath: string): ProjectCostInfo | null {
  const state = readGlobalState();
  if (!state || typeof state !== 'object') return null;

  const projects = state.projects as Record<string, Record<string, unknown>> | undefined;
  if (!projects || typeof projects !== 'object') return null;

  // Claude uses forward-slash normalized paths as keys, try multiple variants
  const normalized = projectPath.replace(/\\/g, '/');
  const entry = projects[normalized] || projects[projectPath];
  if (!entry || typeof entry !== 'object') return null;

  const lastCost = entry.lastCost;
  if (typeof lastCost !== 'number' || lastCost <= 0) return null;

  const modelUsage = (entry.lastModelUsage ?? {}) as ProjectCostInfo['modelUsage'];

  return { cost: lastCost, modelUsage };
}
