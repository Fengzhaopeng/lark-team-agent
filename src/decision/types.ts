/**
 * Decision Gateway — the contract for a *decision layer* around the agent.
 *
 * A gateway call takes unstructured state in and returns a **typed decision
 * carrying a calibrated confidence** — never prose. That shape is the whole
 * point:
 *
 *   - a **closed answer set** makes the response structurally checkable, so a
 *     malformed or out-of-set answer is a parse failure rather than a silent
 *     wrong answer;
 *   - the **confidence** lets every caller pick its own abstain threshold,
 *     instead of the gateway guessing how cautious the caller wants to be.
 *
 * The gateway is a *complement* to the agent, not a replacement. It cannot
 * generate text, so it can only ever sit on the classify / route / score
 * steps that surround a run — never on the answer itself.
 *
 * Design constraints every implementation must honour:
 *   1. **Never throw into the caller's hot path.** A failure returns `null`,
 *      and the caller falls back to its original behaviour.
 *   2. **Never widen permissions.** A decision may tighten a gate, never
 *      loosen one; deterministic rules stay the floor.
 *   3. **Never read or write user-visible state.** Pure function of its input.
 */

/** Outcome of one gateway call. */
export interface GatewayDecision<T> {
  /** The decision. Always one of the caller-supplied options. */
  value: T;
  /**
   * Calibrated confidence in `[0,1]`. Callers MUST threshold on this — a
   * low-confidence answer is treated as "no decision" rather than a weak yes.
   */
  confidence: number;
  /** Wall-clock cost, so callers can watch their latency budget. */
  latencyMs: number;
  /** Provider that produced it, for logging / attribution. */
  provider: string;
}

/**
 * A closed-set choice request — the only shape a provider accepts.
 *
 * There is deliberately no "free-form question" variant: an open answer set is
 * what makes LLM output unreliable, and the gateway exists to avoid that.
 */
export interface ChoiceRequest {
  /**
   * What the decision is about. Kept byte-stable across calls so the prompt
   * prefix is cacheable and the answers stay comparable over time.
   */
  instruction: string;
  /** Unstructured state to classify. The caller truncates before passing it. */
  input: string;
  /** Every allowed answer. The provider must return one of these verbatim. */
  options: readonly string[];
  /** Optional per-option context the model may use to disambiguate. */
  optionHints?: Readonly<Record<string, string>>;
}

/**
 * One rung of the model ladder the router may pick from.
 *
 * `label` is what the provider answers (the closed-set option), `model` is the
 * id forwarded to the agent's `--model`. Keeping them separate means the label
 * stays human-readable in logs while the id stays machine-exact.
 */
export interface ModelTier {
  label: string;
  model: string;
  /** One-line "use this when…" hint that steers the provider. */
  hint?: string;
}

/**
 * What the outbound guard looks for in a reply before it reaches Feishu.
 *
 * These are the leak shapes that actually exist in this deployment: the agent
 * runs beside real credentials (provider keys, the internal Mongo password,
 * OSS keys) and inside a workspace whose paths name internal hosts.
 */
export type GuardCategory =
  /** Provider / cloud credentials: `sk-…`, `AKIA…`, bearer tokens. */
  | 'api-key'
  /** Passwords, connection strings, credentials embedded in a URL. */
  | 'password'
  /** Internal hostnames / private IPs that shouldn't leave the LAN. */
  | 'internal-host'
  /** Absolute paths that expose the operator's local layout. */
  | 'private-path';

/** Raw provider answer, before the gateway bounds-checks it. */
export interface RawChoice {
  /** Must match one of `ChoiceRequest.options`; anything else is dropped. */
  choice: string;
  /** Provider-reported confidence; the gateway clamps it to `[0,1]`. */
  confidence: number;
}

export interface DecisionProvider {
  /** Stable identifier, surfaced in logs and decisions. */
  readonly name: string;
  /** Returns `null` when unavailable, timed out, or not confident enough. */
  choose(req: ChoiceRequest): Promise<RawChoice | null>;
}

/**
 * A provider that never decides. Used when the gateway is configured but no
 * usable provider exists (no model id, no API key) so callers can keep a
 * single code path instead of branching on "gateway present?" everywhere.
 */
export const NULL_PROVIDER: DecisionProvider = {
  name: 'null',
  async choose(): Promise<RawChoice | null> {
    return null;
  },
};
