/**
 * Alternate model providers via Anthropic-compatible endpoints. Several
 * providers (Moonshot/Kimi, Zhipu/GLM, plus gateways like OpenRouter) expose an
 * Anthropic-compatible API specifically so you can run them through the `claude`
 * CLI by overriding ANTHROPIC_BASE_URL + auth (+ model). So a "provider profile"
 * is just: the claude binary, launched with those env vars. This makes cldctrl
 * work with Chinese models (and any Anthropic-compat gateway) with no new deps.
 *
 * A profile is AVAILABLE once a key resolves (its apiKey in config, or apiKeyEnv
 * env var). Built-in presets (Kimi, GLM) merge with user config_profiles; user
 * entries with the same id override the preset (e.g. to add the key or tweak the
 * model/URL). Launching a profile sends your prompts to that provider.
 */

import { loadConfig } from '../config.js';

export interface ProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  model?: string;
  /** Explicit key (config), else read from apiKeyEnv. */
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface ResolvedProvider {
  id: string;
  label: string;
  baseUrl: string;
  model?: string;
  available: boolean;   // a key resolved
  keyHint: string;      // where a missing key should go (env var name)
}

// Built-in presets. URLs are the providers' documented Anthropic-compatible
// endpoints; models are sensible coding defaults (override in config as they
// evolve). Keys come from the env vars below (or config apiKey).
const PRESETS: ProviderProfile[] = [
  { id: 'kimi', label: 'Kimi K2 (Moonshot)', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2-0711-preview', apiKeyEnv: 'MOONSHOT_API_KEY' },
  { id: 'glm', label: 'GLM-4.6 (Zhipu)', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', apiKeyEnv: 'ZHIPU_API_KEY' },
];

function keyFor(p: ProviderProfile): string {
  if (p.apiKey && p.apiKey.trim()) return p.apiKey.trim();
  const envName = p.apiKeyEnv || defaultEnvName(p.id);
  const v = process.env[envName];
  return v && v.trim() ? v.trim() : '';
}

function defaultEnvName(id: string): string {
  return 'CLDCTRL_' + id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
}

/** Merge presets with user config_profiles (user id wins). */
function allProfiles(): ProviderProfile[] {
  let user: ProviderProfile[] = [];
  try { user = (loadConfig().config.provider_profiles ?? []) as ProviderProfile[]; } catch { /* ignore */ }
  const byId = new Map<string, ProviderProfile>();
  for (const p of PRESETS) byId.set(p.id, { ...p });
  for (const p of user) byId.set(p.id, { ...byId.get(p.id), ...p, id: p.id, baseUrl: p.baseUrl || byId.get(p.id)?.baseUrl || '' });
  return [...byId.values()];
}

/** All profiles with availability, for the dashboard picker. */
export function listProviderProfiles(): ResolvedProvider[] {
  return allProfiles().map((p) => ({
    id: p.id,
    label: p.label || p.id,
    baseUrl: p.baseUrl,
    model: p.model,
    available: !!keyFor(p),
    keyHint: p.apiKeyEnv || defaultEnvName(p.id),
  }));
}

export function getProviderProfile(id?: string): ProviderProfile | null {
  if (!id) return null;
  return allProfiles().find((p) => p.id === id) ?? null;
}

/** Env overrides to launch the claude CLI against a provider profile. Returns
 *  null when the id isn't a provider (so callers can no-op for real agents). */
export function getProviderEnv(id?: string): Record<string, string> | null {
  const p = getProviderProfile(id);
  if (!p) return null;
  const key = keyFor(p);
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: p.baseUrl };
  if (key) { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = key; }
  if (p.model) { env.ANTHROPIC_MODEL = p.model; }
  return env;
}
