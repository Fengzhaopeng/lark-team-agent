import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model.
 *
 * 🔴 Adding an id requires TWO checks (both done live, 2026-10-09, Claude Code
 * 2.1.278):
 *   1. the gateway serves it — listed in `/v1/models` is not enough, a
 *      channelless id 503s on every run;
 *   2. the CLI's own catalog knows it — an unknown id still runs, but the CLI
 *      warns `[claude-code:unrecognized_model]` and assumes a 200k context
 *      window for auto-compact.
 *
 * Removed 2026-10-09 (503 `No available channel`, both gateways, every pooled
 * key): `claude-haiku-4-5` (and `-20251001`), `opusplan`.
 * Deliberately not offered: `claude-opus-5-5` / `claude-sonnet-5-5` — the
 * gateway serves both, but 2.1.278's catalog does not know them (check 2).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
];

/**
 * Codex CLI models. Forwarded to `codex exec --model`.
 *
 * Same rule as {@link CLAUDE_MODELS}: only gateway-served ids. Removed
 * 2026-10-09 (503 `No available channel`): `gpt-5-codex`, `o3` (no o-series on
 * either gateway at all). `gpt-5.1-codex` / `gpt-5.3-codex` were verified
 * available the same day — note both currently resolve to `gpt-6-luna`.
 */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * True when `value` names a model that only the *other* agent kind can run
 * (e.g. a Codex id left on a Claude profile after switching `agentKind`).
 * These are the one class of value that must still be dropped: neither CLI can
 * execute the other's ids, so forwarding one guarantees a failed run.
 */
export function isForeignAgentModel(
  agentKind: AgentKind,
  value: string | undefined,
): boolean {
  const trimmed = (value ?? '').trim();
  if (isDefaultModel(trimmed)) return false;
  if (supportedModels(agentKind).some((m) => m.value === trimmed)) return false;
  const other: AgentKind = agentKind === 'codex' ? 'claude' : 'codex';
  return supportedModels(other).some((m) => m.value === trimmed);
}

/**
 * Resolve a stored model preference into the value the profile will actually
 * run.
 *
 * The picker catalogs below are a **shortlist, not an allow-list**. The gateway
 * is the authority (161 ids on the Unipus gateways) and `/model <id>` has always
 * let the session scope carry any of them — so the profile-level preference
 * honors any non-empty value too. Silently rewriting an unrecognised value to
 * "default" used to make `/model --global <id>` report success while the run
 * quietly used a different model.
 *
 * Only {@link isForeignAgentModel} values fall back to the default.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  const trimmed = (value ?? '').trim();
  if (isDefaultModel(trimmed)) return DEFAULT_MODEL;
  if (isForeignAgentModel(agentKind, trimmed)) return DEFAULT_MODEL;
  return trimmed;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag.
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  const known = supportedModels(agentKind).find((m) => m.value === normalized);
  return known?.label ?? normalized;
}

/**
 * Options for the `/config` model dropdown.
 *
 * Feishu's `select_static` requires `initial_option` to match one of the option
 * values exactly. A stored value outside the shortlist therefore gets a
 * synthetic entry rather than being shown as "跟随默认" while the profile
 * actually runs something else.
 */
export function pickerOptions(agentKind: AgentKind, current: string | undefined): ModelOption[] {
  const options = supportedModels(agentKind);
  const normalized = normalizeModelSelection(agentKind, current);
  if (options.some((m) => m.value === normalized)) return options;
  return [...options, { value: normalized, label: `当前设置：${normalized}` }];
}
