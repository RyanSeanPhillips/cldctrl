/**
 * Token-to-dollar cost estimation for Claude models.
 * Prices are per million tokens. These are approximations —
 * actual billing may differ based on caching, batching, etc.
 *
 * On Pro/Max/Team/Enterprise plans, Claude Code usage is included
 * in the subscription — costs shown are API-equivalent only.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Model pricing (per million tokens) ───────────────────────

interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Anthropic published pricing as of early 2025
const MODEL_PRICES: Record<string, ModelPricing> = {
  opus:   { input: 15,   output: 75,   cacheRead: 1.50,  cacheWrite: 18.75 },
  sonnet: { input: 3,    output: 15,   cacheRead: 0.30,  cacheWrite: 3.75 },
  haiku:  { input: 0.25, output: 1.25, cacheRead: 0.03,  cacheWrite: 0.30 },
};

/**
 * Match a model ID string to a pricing tier.
 * Model IDs look like: claude-sonnet-4-20250514, claude-opus-4-6, claude-haiku-4-5-20251001
 */
function getModelTier(modelId: string): ModelPricing {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return MODEL_PRICES.opus;
  if (lower.includes('haiku')) return MODEL_PRICES.haiku;
  // Default to sonnet (most common in Claude Code)
  return MODEL_PRICES.sonnet;
}

// ── Cost calculation ────────────────────────────────────────

export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Estimate dollar cost from a token breakdown and model name.
 * Returns cost in dollars (e.g., 0.42 = $0.42).
 */
export function estimateCost(tokens: TokenBreakdown, modelId?: string): number {
  const pricing = modelId ? getModelTier(modelId) : MODEL_PRICES.sonnet;
  const perM = 1_000_000;

  const inputCost = (tokens.inputTokens / perM) * pricing.input;
  const outputCost = (tokens.outputTokens / perM) * pricing.output;
  const cacheReadCost = (tokens.cacheReadTokens / perM) * (pricing.cacheRead ?? pricing.input * 0.1);
  const cacheWriteCost = (tokens.cacheWriteTokens / perM) * (pricing.cacheWrite ?? pricing.input * 1.25);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Rough cost estimate from just a total token count (no input/output split).
 * Uses a blended rate: assumes ~80% input, ~20% output for Claude Code sessions.
 * This is less accurate but works when we only have the total.
 */
export function estimateCostBlended(totalTokens: number, modelId?: string): number {
  const pricing = modelId ? getModelTier(modelId) : MODEL_PRICES.sonnet;
  const perM = 1_000_000;
  // Blended: 80% input + 20% output — typical for Claude Code (lots of context, shorter responses)
  const blendedRate = (pricing.input * 0.8) + (pricing.output * 0.2);
  return (totalTokens / perM) * blendedRate;
}

/**
 * Format a dollar amount for display.
 * <$0.01 → "<$0.01", <$1 → "$0.42", <$100 → "$12.50", else → "$123"
 */
export function formatCost(dollars: number): string {
  if (dollars < 0.01) return '<$0.01';
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  if (dollars < 100) return `$${dollars.toFixed(2)}`;
  return `$${Math.round(dollars)}`;
}

/**
 * Check if cost estimates are meaningful for the user's plan.
 * Pro/Max/Team/Enterprise include Claude Code usage — showing
 * API-equivalent dollar amounts is misleading.
 * Reads ~/.claude/.credentials.json directly (avoids circular imports).
 * Cached for process lifetime.
 */
let _costRelevant: boolean | undefined;
export function isCostRelevant(): boolean {
  if (_costRelevant !== undefined) return _costRelevant;
  try {
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    const credPath = path.join(homedir, '.claude', '.credentials.json');
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const sub = (raw?.claudeAiOauth?.subscriptionType ?? '').toLowerCase();
    // Only show costs for free tier or unknown — paid plans include usage
    _costRelevant = !sub || sub === 'free';
  } catch {
    _costRelevant = true; // if we can't read, show costs as safe default
  }
  return _costRelevant;
}
