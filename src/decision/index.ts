/**
 * Decision Gateway — an optional decision layer around an agent run.
 *
 * The agent generates; the gateway decides. Splitting those apart keeps the
 * expensive, non-deterministic part (writing an answer) away from the cheap,
 * checkable parts (which model, is this safe to publish), so the checkable
 * parts can be verified, thresholded, and rolled back independently.
 *
 * Everything here is inert unless a profile carries a `decisionGateway` block
 * under `preferences`. See `docs`-style commentary in `integrate.ts` for the
 * two call sites, and `config.ts` for the operator-facing shape.
 */

export type {
  ChoiceRequest,
  DecisionProvider,
  GatewayDecision,
  GuardCategory,
  ModelTier,
  RawChoice,
} from './types.js';
export { NULL_PROVIDER } from './types.js';

export type {
  DecisionGatewayConfig,
  DecisionGatewayPreference,
  GatewayMode,
  GuardAction,
  ModelRouteConfig,
  OutboundGuardConfig,
} from './config.js';
export {
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  providerAvailability,
  readDecisionGatewayConfig,
  resolveProviderEndpoint,
} from './config.js';

export { DecisionGateway } from './gateway.js';
export type { OutboundVerdict } from './gateway.js';

export { ChatDecisionProvider, parseChoice } from './provider.js';

export {
  buildGatewayFromPreferences,
  resolveRoutedModel,
  scanOutboundReply,
} from './integrate.js';
export type {
  ResolveRoutedModelInput,
  ScanOutboundInput,
  ScanOutboundResult,
} from './integrate.js';
