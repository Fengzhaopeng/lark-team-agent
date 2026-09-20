/**
 * Wiring layer: turns the gateway into the two calls the bridge actually makes.
 *
 * The integration is deliberately one-directional — `run-flow` and
 * `send-final` call in here, and this file never reaches back into them. All
 * failure handling lives in this file so the two call sites stay readable:
 *
 *   - **model routing** runs *before* the agent starts, so its cost is pure
 *     dead time for the user. It is capped by `timeoutMs` and every failure
 *     (timeout, bad answer, unknown model id) falls through to the model the
 *     profile would have used anyway.
 *   - **outbound guard** runs *after* the agent finishes and is the last thing
 *     before a message leaves for Feishu. It can only ever add a warning or
 *     swap the payload for a notice — it never edits the agent's text.
 *
 * Both are no-ops when the gateway block is absent from the profile, which is
 * the default. Nothing here is required for the bridge to function.
 */

import { resolveModelArg, supportedModels } from '../agent/models';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { ChatDecisionProvider } from './provider';
import type { GuardCategory } from './config';
import {
  readDecisionGatewayConfig,
  resolveProviderEndpoint,
} from './config';
import { DecisionGateway } from './gateway';

type Preferences = ProfileConfig['preferences'];
type Env = Record<string, string | undefined>;

/**
 * Profiles we have already complained about, so a misconfigured gateway warns
 * once per (mode, model) pair instead of once per run. `run-flow` builds a
 * gateway on every run, and a warn-per-run would bury the log stream.
 */
const warnedUnavailable = new Set<string>();

/**
 * Build a gateway from a profile's preferences.
 *
 * Returns `undefined` when the feature is off (the common case) **or** when it
 * is on but the provider is unusable. Both are "gateway absent" from the
 * caller's point of view: it keeps the original code path with no extra
 * branch, and an operator who enabled the feature without credentials gets a
 * single warning rather than a silent half-active gateway.
 */
export function buildGatewayFromPreferences(
  preferences: Preferences,
  env: Env = process.env,
): DecisionGateway | undefined {
  const raw = (preferences as Record<string, unknown>)['decisionGateway'];
  const config = readDecisionGatewayConfig(raw);
  if (!config) return undefined;

  const endpoint = resolveProviderEndpoint(config, env);
  if (!endpoint) {
    const key = `${config.mode}:${config.model}`;
    if (!warnedUnavailable.has(key)) {
      warnedUnavailable.add(key);
      log.warn('decision', 'provider-unavailable', {
        mode: config.mode,
        model: config.model || '(unset)',
        hint: 'set decisionGateway.model + ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY',
      });
    }
    return undefined;
  }

  return new DecisionGateway(
    config,
    new ChatDecisionProvider({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
    }),
  );
}

export interface ResolveRoutedModelInput {
  agentKind: AgentKind;
  preferences: Preferences;
  /** The user's prompt — the only signal routing gets. */
  prompt: string;
  /** For logs only. */
  scopeId?: string;
  env?: Env;
  /** Test seam / injection point. Built from preferences when omitted. */
  gateway?: DecisionGateway;
}

/**
 * Decide which model this run should use.
 *
 * Returns the agent's `--model` argument, or `undefined` to leave the flag off
 * (the CLI/account default). Precedence, highest first:
 *
 *   1. a model the operator pinned in the profile (`preferences.model`) —
 *      an explicit human choice is never second-guessed by a router;
 *   2. the gateway's tier choice, when it is enabled, confident enough, and
 *      names a model that actually exists for this agent kind;
 *   3. `undefined` — the original behaviour.
 */
export async function resolveRoutedModel(
  input: ResolveRoutedModelInput,
): Promise<string | undefined> {
  const profileModel = resolveModelArg(input.agentKind, input.preferences.model);

  const gateway = input.gateway ?? buildGatewayFromPreferences(input.preferences, input.env);
  if (!gateway || !gateway.modelRouteEnabled) return profileModel;

  // Rule 1: an explicitly pinned model wins outright. Operators set this to
  // control cost or to force a specific model for compliance; a router must
  // not silently override either.
  if (profileModel !== undefined) {
    log.info('decision', 'route-skipped', {
      reason: 'model-pinned-by-profile',
      model: profileModel,
    });
    return profileModel;
  }

  const decision = await gateway.routeModel(input.prompt);

  if (!decision) {
    if (gateway.dryRun) {
      log.info('decision', 'route-dry-run', { scope: input.scopeId, outcome: 'abstain' });
    }
    return profileModel;
  }

  // Rule 2: the tier must name a model this agent kind can actually run.
  // A typo in the tier table would otherwise reach the CLI as an unknown
  // `--model` and surface as a failed run.
  const allowed = new Set(supportedModels(input.agentKind).map((option) => option.value));
  if (!allowed.has(decision.value)) {
    log.warn('decision', 'route-rejected', {
      reason: 'unknown-model-for-agent',
      agentKind: input.agentKind,
      model: decision.value,
    });
    return profileModel;
  }

  if (gateway.dryRun) {
    log.info('decision', 'route-dry-run', {
      scope: input.scopeId,
      wouldUse: decision.value,
      insteadOf: profileModel ?? 'agent-default',
      confidence: decision.confidence,
      latencyMs: decision.latencyMs,
    });
    return profileModel;
  }

  log.info('decision', 'route-applied', {
    scope: input.scopeId,
    model: decision.value,
    confidence: decision.confidence,
    latencyMs: decision.latencyMs,
    provider: decision.provider,
  });
  return decision.value;
}

export interface ScanOutboundInput {
  /** The exact text about to be published. */
  text: string;
  preferences: Preferences;
  /** For logs only. */
  scopeId?: string;
  replyMode?: string;
  env?: Env;
  /** Test seam / injection point. */
  gateway?: DecisionGateway;
}

export interface ScanOutboundResult {
  /** True when the guard fired, in either action mode. */
  flagged: boolean;
  /** Set only when `flagged`. */
  category?: GuardCategory;
  /**
   * True when the reply must not be published as-is. The caller decides how
   * to render that — this layer never rewrites the agent's text itself, so a
   * guard bug can't mangle a reply.
   */
  blocked: boolean;
  /** One-line notice to surface when `flagged`. */
  notice?: string;
}

/**
 * Check a finished reply before it reaches Feishu.
 *
 * Anything unexpected — gateway off, provider timeout, unparseable answer —
 * returns the text untouched. This is the one place in the bridge where
 * failing *open* is correct: a guard bug must not be able to blackhole
 * everyone's answers. It is a leak detector, not an access control.
 */
export async function scanOutboundReply(
  input: ScanOutboundInput,
): Promise<ScanOutboundResult> {
  const pass: ScanOutboundResult = { flagged: false, blocked: false };

  const gateway = input.gateway ?? buildGatewayFromPreferences(input.preferences, input.env);
  if (!gateway || !gateway.outboundGuardEnabled) return pass;

  const decision = await gateway.guardOutbound(input.text);
  if (!decision || decision.value.clean) {
    if (gateway.dryRun) {
      log.info('decision', 'guard-dry-run', { scope: input.scopeId, outcome: 'clean' });
    }
    return pass;
  }

  const category = decision.value.category ?? 'api-key';
  const action = gateway.config.outboundGuard?.action ?? 'log';

  log.warn('decision', 'guard-hit', {
    scope: input.scopeId,
    category,
    confidence: decision.confidence,
    latencyMs: decision.latencyMs,
    provider: decision.provider,
    action: gateway.dryRun ? 'dry-run' : action,
    chars: input.text.length,
  });

  // dry-run always behaves like `log`: observe, never alter delivery.
  const blocking = !gateway.dryRun && action === 'block';

  return {
    flagged: true,
    category,
    blocked: blocking,
    notice: blocking
      ? `⚠️ 本条回复因命中出站检查「${category}」已被拦截，未发送。请检查内容后重试。`
      : `🔎 决策网关：本条回复命中「${category}」检查（仅记录，未拦截）`,
  };
}
