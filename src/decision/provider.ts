/**
 * Provider that answers closed-set choices via an OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * Why a chat endpoint and not a dedicated "decision" API: this deployment
 * already routes every model call through one internal gateway
 * (`ANTHROPIC_BASE_URL`), which is the only egress that is cleared for this
 * environment. Reusing it means the decision layer adds **no new vendor, no
 * new credential, and no new data-egress path** — the compliance surface is
 * exactly the one that already exists.
 *
 * The structured-output guarantee is enforced on our side, not trusted from
 * the model: the prompt states a closed option set, and anything that isn't
 * one of those options verbatim is discarded as a failed call. A wrong answer
 * therefore degrades to "no decision", which is the safe direction.
 */

import { log } from '../core/logger';
import type { ChoiceRequest, DecisionProvider, RawChoice } from './types.js';

export interface ChatProviderOptions {
  /** Endpoint root, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Model id to send. */
  model: string;
  /** Per-call timeout; a timeout is a silent abstain. */
  timeoutMs: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Output budget for the decision reply.
 *
 * Measured, not guessed: at 64 tokens a reasoning-style model can burn the
 * whole budget before emitting the JSON, and the truncated reply parses as
 * "no answer" — which on the outbound guard means a *missed leak*, the one
 * failure direction that silently looks like success. 256 leaves room for a
 * short preamble plus the object while still capping the cost.
 */
const MAX_TOKENS = 256;

export class ChatDecisionProvider implements DecisionProvider {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ChatProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `chat:${opts.model}`;
  }

  async choose(req: ChoiceRequest): Promise<RawChoice | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          // Determinism matters more than variety here: the same state must
          // route the same way twice, or the ladder looks random to users.
          temperature: 0,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: 'system', content: buildSystemPrompt(req) },
            { role: 'user', content: req.input },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        log.warn('decision', 'provider-http-error', {
          provider: this.name,
          status: res.status,
        });
        return null;
      }

      const payload = (await res.json().catch(() => null)) as ChatCompletion | null;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        log.warn('decision', 'provider-empty-content', { provider: this.name });
        return null;
      }

      return parseChoice(content, req.options);
    } catch (err) {
      // Abort = timeout. Either way: abstain, never propagate.
      log.warn('decision', 'provider-call-failed', {
        provider: this.name,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * The instruction is byte-stable per decision kind so the prompt prefix is
 * cacheable and answers stay comparable across runs.
 */
function buildSystemPrompt(req: ChoiceRequest): string {
  const lines = [
    req.instruction,
    '',
    'Allowed answers (pick exactly one, copied verbatim):',
    ...req.options.map((option) => {
      const hint = req.optionHints?.[option];
      return hint ? `- ${option} — ${hint}` : `- ${option}`;
    }),
    '',
    'Reply with JSON only, no prose, no code fences:',
    '{"choice": "<one allowed answer>", "confidence": <number between 0 and 1>}',
    'If you cannot tell, use a confidence below 0.5 rather than guessing.',
  ];
  return lines.join('\n');
}

/**
 * Parse the model's reply, tolerating the two failure modes seen in practice:
 * a code fence around the JSON, and leading/trailing chatter.
 *
 * Anything that doesn't resolve to one of `options` returns `null` — an
 * out-of-set answer means the model didn't follow the contract, and inventing
 * a default from it would be worse than abstaining.
 */
export function parseChoice(content: string, options: readonly string[]): RawChoice | null {
  const json = extractJsonObject(content);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const rawChoice = record['choice'];
  if (typeof rawChoice !== 'string') return null;

  const choice = matchOption(rawChoice, options);
  if (!choice) return null;

  const rawConfidence = record['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0;

  return { choice, confidence };
}

/** Characters a model may append after echoing the option. */
const OPTION_TRAILERS = ['—', '–', '-', ':', '：', '(', '（', ' ', '\t', '\n'];

/**
 * Resolve the model's answer to one of `options`, exact match first.
 *
 * Tolerates a trailing hint on purpose. When options are listed as
 * `- light — small edits`, several models copy the whole line back as the
 * answer (`light — small edits`). Rejecting that outright would make routing
 * abstain on almost every call — the model got the decision right and we'd
 * throw it away — so a leading match is accepted.
 *
 * The guard against ambiguity: if more than one option matches the prefix, no
 * decision is returned. Guessing between `light` and `light-plus` is exactly
 * the kind of silent wrong answer this layer exists to prevent.
 */
function matchOption(value: string, options: readonly string[]): string | undefined {
  if (options.includes(value)) return value;

  const trimmed = value.trim();
  const needle = trimmed.toLowerCase();
  const exact = options.find((option) => option.trim().toLowerCase() === needle);
  if (exact) return exact;

  // Longest first: when the options nest as prefixes (`light` / `light-plus`)
  // only the most specific one can be the intended answer, so it wins.
  const byLengthDesc = [...options].sort((a, b) => b.length - a.length);
  for (const option of byLengthDesc) {
    const optionTrimmed = option.trim();
    if (!needle.startsWith(optionTrimmed.toLowerCase())) continue;
    const rest = trimmed.slice(optionTrimmed.length);
    if (rest === '' || OPTION_TRAILERS.some((trailer) => rest.startsWith(trailer))) {
      return option;
    }
  }

  return undefined;
}

function extractJsonObject(content: string): string | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}
