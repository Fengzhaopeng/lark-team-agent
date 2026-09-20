/**
 * Decision Gateway configuration.
 *
 * Lives under `preferences.decisionGateway` so it travels with the profile and
 * survives the config round-trip. Every field is normalised defensively: a
 * malformed block degrades to "gateway off" rather than throwing, because a
 * bad preference must never be able to stop the bridge from starting.
 *
 * The gateway ships **off by default**. Turning it on is an explicit operator
 * decision — it costs an extra provider call per run and changes which model
 * the agent runs with.
 */

import type { GuardCategory, ModelTier } from './types.js';

export type { GuardCategory, ModelTier };

/**
 * `off`     — gateway never runs (default).
 * `dry-run` — gateway runs and logs its decision, but the caller keeps its
 *             original behaviour. Use this to measure accuracy and cost on
 *             real traffic before letting it change anything.
 * `active`  — decisions are applied.
 */
export type GatewayMode = 'off' | 'dry-run' | 'active';

/** What the outbound guard does when it fires. */
export type GuardAction = 'log' | 'block';

export interface ModelRouteConfig {
  /**
   * The ladder the router picks from. At least two rungs are required for
   * routing to mean anything; a single rung is normalised to "disabled".
   */
  tiers: ModelTier[];
}

export interface OutboundGuardConfig {
  action: GuardAction;
  categories: GuardCategory[];
  /** Skip the provider call for replies shorter than this. Default 40. */
  minChars: number;
}

export interface DecisionGatewayConfig {
  mode: GatewayMode;
  /**
   * Provider model id (e.g. a fast model on the same internal gateway the
   * agent uses). Empty means "no usable provider" — see
   * {@link providerAvailability}.
   */
  model: string;
  /** Overrides `ANTHROPIC_BASE_URL` when set. */
  baseUrl?: string;
  /** Overrides `ANTHROPIC_API_KEY` when set. */
  apiKey?: string;
  /** Minimum confidence to act on. Below this the gateway abstains. */
  threshold: number;
  /** Per-call timeout. A timeout is a silent abstain, never an error. */
  timeoutMs: number;
  /** Input is truncated to this many characters before being sent. */
  maxInputChars: number;
  modelRoute?: ModelRouteConfig;
  outboundGuard?: OutboundGuardConfig;
}

/** Below this, a "decision" is noise. Overridden per-profile if needed. */
export const DEFAULT_THRESHOLD = 0.7;/**
 * Per-call timeout. Deliberately tight: this call sits *before* the agent
 * starts, so it is dead time the user waits through. A slow provider must
 * lose the race and let the run proceed on the default model.
 *
 * 5s is headroom, not an expectation. Measured against this deployment's
 * internal gateway: a fast model answers in ~1.5s, a reasoning model can take
 * 4s when it deliberates. Anything slower than 5s is treated as an abstain.
 */
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_INPUT_CHARS = 4_000;

/**
 * Operator-facing shape of `preferences.decisionGateway`.
 *
 * Every field is optional and every field is re-validated at read time — this
 * type describes what a human is *allowed to write* in the config, not what
 * the gateway is guaranteed to receive. A profile written by hand (or by an
 * older build) can therefore be partial without breaking startup.
 */
export interface DecisionGatewayPreference {
  /** `off` (default) / `dry-run` / `active`. */
  mode?: GatewayMode;
  /** Provider model id on the shared internal gateway. */
  model?: string;
  /** Defaults to `ANTHROPIC_BASE_URL`. */
  baseUrl?: string;
  /** Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  threshold?: number;
  timeoutMs?: number;
  maxInputChars?: number;
  modelRoute?: { tiers?: Array<Partial<ModelTier>> };
  outboundGuard?: {
    action?: GuardAction;
    categories?: string[];
    minChars?: number;
  };
}

const GUARD_CATEGORIES: readonly GuardCategory[] = [
  'api-key',
  'password',
  'internal-host',
  'private-path',
];

/**
 * Parse `preferences.decisionGateway`. Returns `undefined` when the gateway is
 * off or the block is unusable — callers treat `undefined` as "feature absent"
 * and take the original code path.
 */
export function readDecisionGatewayConfig(raw: unknown): DecisionGatewayConfig | undefined {
  if (!isRecord(raw)) return undefined;

  const mode = raw['mode'];
  if (mode !== 'active' && mode !== 'dry-run') return undefined;

  const config: DecisionGatewayConfig = {
    mode,
    model: nonEmptyString(raw['model']) ?? '',
    threshold: clamp01(numberOr(raw['threshold'], DEFAULT_THRESHOLD)),
    timeoutMs: positiveIntOr(raw['timeoutMs'], DEFAULT_TIMEOUT_MS),
    maxInputChars: positiveIntOr(raw['maxInputChars'], DEFAULT_MAX_INPUT_CHARS),
  };

  const baseUrl = nonEmptyString(raw['baseUrl']);
  if (baseUrl) config.baseUrl = baseUrl;
  const apiKey = nonEmptyString(raw['apiKey']);
  if (apiKey) config.apiKey = apiKey;

  const modelRoute = readModelRoute(raw['modelRoute']);
  if (modelRoute) config.modelRoute = modelRoute;
  const outboundGuard = readOutboundGuard(raw['outboundGuard']);
  if (outboundGuard) config.outboundGuard = outboundGuard;

  return config;
}

/** Whether the gateway has everything it needs to actually call a provider. */
export function providerAvailability(
  config: DecisionGatewayConfig,
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; reason: string } {
  if (!config.model) return { ok: false, reason: 'no-model-configured' };
  const baseUrl = config.baseUrl ?? env['ANTHROPIC_BASE_URL'];
  if (!baseUrl) return { ok: false, reason: 'no-base-url' };
  const apiKey = config.apiKey ?? env['ANTHROPIC_API_KEY'];
  if (!apiKey) return { ok: false, reason: 'no-api-key' };
  return { ok: true };
}

/** Resolved provider endpoint + credentials, or `undefined` when unusable. */
export function resolveProviderEndpoint(
  config: DecisionGatewayConfig,
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; apiKey: string } | undefined {
  const availability = providerAvailability(config, env);
  if (!availability.ok) return undefined;
  const baseUrl = (config.baseUrl ?? env['ANTHROPIC_BASE_URL'] ?? '').replace(/\/+$/, '');
  const apiKey = config.apiKey ?? env['ANTHROPIC_API_KEY'] ?? '';
  return { baseUrl, apiKey };
}

function readModelRoute(raw: unknown): ModelRouteConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const tiers = Array.isArray(raw['tiers']) ? raw['tiers'] : [];
  const parsed: ModelTier[] = [];
  for (const tier of tiers) {
    if (!isRecord(tier)) continue;
    const label = nonEmptyString(tier['label']);
    const model = nonEmptyString(tier['model']);
    if (!label || !model) continue;
    const hint = nonEmptyString(tier['hint']);
    parsed.push(hint ? { label, model, hint } : { label, model });
  }
  // One rung is not a ladder — routing would be a no-op with provider cost.
  if (parsed.length < 2) return undefined;
  return { tiers: parsed };
}

function readOutboundGuard(raw: unknown): OutboundGuardConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const action: GuardAction = raw['action'] === 'block' ? 'block' : 'log';
  const rawCategories = Array.isArray(raw['categories']) ? raw['categories'] : [];
  const categories = rawCategories.filter(
    (c): c is GuardCategory => typeof c === 'string' && (GUARD_CATEGORIES as readonly string[]).includes(c),
  );
  return {
    action,
    categories: categories.length > 0 ? categories : [...GUARD_CATEGORIES],
    minChars: positiveIntOr(raw['minChars'], 40),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
