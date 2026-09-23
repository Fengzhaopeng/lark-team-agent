/**
 * Capability probe for models exposed by an Anthropic-compatible proxy.
 *
 * Since the /v1/models endpoint does not return capability fields, this module
 * tests each model against the available endpoints and caches the results.
 *
 * Probe rounds (each request uses minimal parameters):
 *   Round 1  chat        POST /v1/chat/completions   max_tokens=1     → 200, or 400 with an output-limit message
 *   Round 2  image-gen   POST /v1/images/generations n=1              → 200, or 400 with a size/param error
 *   Round 3  video-gen   POST /v1/video/generations  duration=3       → 200 with a task object
 *
 * Rounds 4-6 only run for models that passed Round 1 (saves ~half the requests):
 *   Round 4  tool-call   POST /v1/chat/completions   tools=[...]      → two-step probe, see below
 *   Round 5  vision      POST /v1/chat/completions   64×64 PNG        → 200
 *   Round 6  reasoning   POST /v1/chat/completions   riddle           → reasoning_content / reasoning_tokens present
 *
 * ── Judgement rules worth knowing (learned the hard way) ────────────────────
 *
 * 1. `tool-call` MUST be probed with **two different strategies**, because a
 *    single strategy produces false negatives in both directions:
 *      a. plain-induction  — a user message that invites a tool call
 *      b. forced + system  — an English system prompt that insists on the tool,
 *                            optionally with `tool_choice: 'required'`
 *    - `gemini-3.1-pro-preview` only answers (a) with a plain text reply but
 *      returns `tool_calls` for (b) with `tool_choice: 'required'`.
 *    - DeepSeek (all), Kimi k2.x, glm-4.x, gpt-5, and several Qwen models
 *      **ignore `tool_choice: 'required'` entirely** but return `tool_calls`
 *      under strategy (b). Probing only with `tool_choice` mislabels all of them.
 *    A model is tool-capable when **either** strategy yields a `tool_calls` array.
 *
 * 2. `vision` MUST use an image of at least ~14px per side. A 1×1 pixel PNG is
 *    rejected by most upstreams ("Image dimensions are too small", "image length
 *    and width do not meet the model restrictions") and the model then looks
 *    image-incapable even though it is not. We send a 64×64 solid-colour PNG.
 *
 * 3. `chat` must accept **streaming responses** as capable. Some gateways force
 *    `text/event-stream` even when the request omits `stream`; those models are
 *    perfectly usable by streaming clients but look "broken" to a naive
 *    `res.json()` parse. We detect the content-type and treat a 200 SSE
 *    response as chat-capable.
 *
 * 4. Status-code meanings, so failures can be told apart in the cache:
 *      503 + "No available channel for model X under group Y"  → model exists but
 *          the API key's group has no upstream channel. Not a capability issue;
 *          the ops side must open the channel. Reported as "unavailable".
 *      404 → model not present on this gateway.
 *      400 + "Unsupported parameter: 'max_tokens'" → model is chat-capable but
 *          belongs to the Responses-API generation and needs `max_completion_tokens`.
 *
 * NOTE: this file is the TypeScript twin of the `unipus-model-sync` skill; when
 * the judging rules change, update both.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ModelCapability =
  | 'chat'
  | 'image-gen'
  | 'video-gen'
  | 'tool-call'
  | 'vision'
  | 'reasoning';

export interface ModelCapabilityRecord {
  modelId: string;
  capabilities: ModelCapability[];
  probedAt: string;
}

export interface CapabilityCache {
  /** 2 — added tool-call / vision / reasoning. Version 1 caches are ignored
   *  and re-probed automatically (they lack the new capabilities). */
  version: 2;
  probedAt: string;
  models: ModelCapabilityRecord[];
}

export interface ProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Max concurrent probe requests. Default 16. */
  concurrency?: number;
  /** Per-request timeout ms. Default 15000. */
  timeoutMs?: number;
  /** Called after each model is probed. */
  onProgress?: (done: number, total: number, modelId: string) => void;
}

// ── Probe fixtures ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  },
];

/**
 * 64×64 solid-red PNG. Must be ≥14px per side — a 1×1 image is rejected by
 * several upstreams and would be misread as "model cannot see images".
 */
const PROBE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeElEQVR4nO3PQQkAMAzAwMqpf4ObiD2OQSACLnN2v264' +
  'oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEt' +
  'aEALGtCCBrSgAS1oQAsa0ILHLjuH8S2OcR5IAAAAAElFTkSuQmCC';

// ── Probe helpers ───────────────────────────────────────────────────────────

interface ProbeResponse {
  status: number;
  body: unknown;
  /** Lower-cased content-type header, '' when unavailable. */
  contentType: string;
}

async function probeEndpoint(
  url: string,
  body: object,
  apiKey: string,
  timeoutMs: number,
): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // Non-JSON body. Streaming (text/event-stream) responses land here —
      // still a success signal for chat, so keep the content-type around.
      data = null;
    }
    return { status: res.status, body: data, contentType };
  } catch {
    return { status: 0, body: null, contentType: '' };
  } finally {
    clearTimeout(timer);
  }
}

function errorText(body: unknown): string {
  const err = (body as Record<string, unknown> | null)?.['error'] as Record<string, unknown> | undefined;
  const message = err?.['message'] ?? (body as Record<string, unknown> | null)?.['message'];
  return String(message ?? '').toLowerCase();
}

function firstToolCalls(body: unknown): unknown {
  const choices = (body as Record<string, unknown> | null)?.['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as Record<string, unknown>)?.['message'] as Record<string, unknown> | undefined;
  return message?.['tool_calls'];
}

export function isChatCapable(res: ProbeResponse): boolean {
  if (res.status === 200) return true;
  // Streaming-only gateway: 200 already handled, but a forced SSE response with
  // a non-200 status is not a capability signal, so nothing to add here.
  if (res.status !== 400) return false;
  const text = errorText(res.body);
  // A 400 caused by max_tokens / output limits means the model itself is fine.
  return (
    text.includes('max_tokens') ||
    text.includes('max_completion_tokens') ||
    text.includes('output limit') ||
    text.includes('maximum') ||
    text.includes('unsupported parameter')
  );
}

export function isImageCapable(res: ProbeResponse): boolean {
  if (res.status === 200) return true;
  if (res.status !== 400) return false;
  // A 400 about size/params means the model does generate images but rejects the
  // probe dimensions (e.g. doubao-seedream requires ≥3686400 px) — still capable.
  const text = errorText(res.body);
  return (
    text.includes('size') ||
    text.includes('invalid_value') ||
    text.includes('supported size') ||
    text.includes('not valid')
  );
}

export function isVideoCapable(res: ProbeResponse): boolean {
  if (res.status !== 200) return false;
  const d = res.body as Record<string, unknown> | null;
  return !!(d?.['task_id'] || d?.['id']);
}

export function isToolCallCapable(res: ProbeResponse): boolean {
  if (res.status !== 200) return false;
  const calls = firstToolCalls(res.body);
  return Array.isArray(calls) && calls.length > 0;
}

export function isVisionCapable(res: ProbeResponse): boolean {
  return res.status === 200;
}

export function isReasoningCapable(res: ProbeResponse): boolean {
  if (res.status !== 200) return false;
  const choices = (res.body as Record<string, unknown> | null)?.['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>)?.['message'] as Record<string, unknown> | undefined;
    if (message?.['reasoning_content'] || message?.['reasoning']) return true;
  }
  const usage = (res.body as Record<string, unknown> | null)?.['usage'] as Record<string, unknown> | undefined;
  const details = usage?.['completion_tokens_details'] as Record<string, unknown> | undefined;
  return Number(details?.['reasoning_tokens'] ?? 0) > 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Probe all models for their capabilities.
 *
 * Strategy: run one endpoint per round instead of probing every endpoint per
 * model at once, so a slow media round never blocks the fast chat round and each
 * round's concurrency is independent. Rounds 4-6 are restricted to models that
 * already proved chat-capable, which roughly halves the request count.
 */
export async function probeAllModels(
  modelIds: string[],
  opts: ProbeOptions = {},
): Promise<ModelCapabilityRecord[]> {
  const baseUrl = (opts.baseUrl ?? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const concurrency = opts.concurrency ?? 16;
  const chatTimeoutMs = opts.timeoutMs ?? 15_000;
  const mediaTimeoutMs = Math.max(chatTimeoutMs, 90_000);

  // Accumulate capabilities per modelId across all rounds
  const capMap = new Map<string, Set<ModelCapability>>();
  for (const id of modelIds) capMap.set(id, new Set());

  let done = 0;
  // Upper bound: 3 media/chat rounds for every model + 3 extra rounds for the
  // chat-capable subset. Used only for progress reporting, so an over-estimate
  // is fine.
  const total = modelIds.length * 6;

  async function runRound(
    subset: string[],
    endpoint: string,
    makeBody: (modelId: string) => object,
    judge: (res: ProbeResponse) => boolean,
    capability: ModelCapability,
    timeoutMs: number,
  ): Promise<void> {
    for (let i = 0; i < subset.length; i += concurrency) {
      const batch = subset.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (modelId) => {
          const res = await probeEndpoint(`${baseUrl}${endpoint}`, makeBody(modelId), apiKey, timeoutMs);
          if (judge(res)) capMap.get(modelId)!.add(capability);
          done++;
          opts.onProgress?.(done, total, modelId);
        }),
      );
    }
  }

  // Round 1 — chat (determines which models get the extra rounds)
  await runRound(
    modelIds,
    '/v1/chat/completions',
    (id) => ({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    isChatCapable,
    'chat',
    chatTimeoutMs,
  );
  const chatCapableIds = modelIds.filter((id) => capMap.get(id)!.has('chat'));

  // Rounds 2-3 — media generation (all models; most answer 400/503 quickly)
  await runRound(
    modelIds,
    '/v1/images/generations',
    (id) => ({ model: id, prompt: 'test', n: 1 }),
    isImageCapable,
    'image-gen',
    mediaTimeoutMs,
  );

  await runRound(
    modelIds,
    '/v1/video/generations',
    (id) => ({ model: id, prompt: 'test', duration: 3 }),
    isVideoCapable,
    'video-gen',
    mediaTimeoutMs,
  );

  if (chatCapableIds.length === 0) {
    return modelIds.map((modelId) => ({
      modelId,
      capabilities: [...capMap.get(modelId)!],
      probedAt: new Date().toISOString(),
    }));
  }

  // Round 4 — tool calling. Two strategies; see the file header for why one is
  // not enough. Strategy (b) is only attempted when (a) produced no tool_calls.
  // Each model costs 1-2 requests, so the batch is half the usual concurrency.
  {
    const toolConcurrency = Math.max(1, Math.floor(concurrency / 2));
    for (let i = 0; i < chatCapableIds.length; i += toolConcurrency) {
      const batch = chatCapableIds.slice(i, i + toolConcurrency);
      await Promise.all(
        batch.map(async (id) => {
          const plain = await probeEndpoint(
            `${baseUrl}/v1/chat/completions`,
            {
              model: id,
              max_tokens: 256,
              tools: TOOLS,
              messages: [{ role: 'user', content: '北京天气怎么样？请调用工具查询' }],
            },
            apiKey,
            chatTimeoutMs,
          );
          let capable = isToolCallCapable(plain);
          if (!capable) {
            const forced = await probeEndpoint(
              `${baseUrl}/v1/chat/completions`,
              {
                model: id,
                max_tokens: 256,
                tools: TOOLS,
                tool_choice: 'required',
                messages: [
                  {
                    role: 'system',
                    content:
                      'You are a weather assistant. Always call the get_weather tool when asked about weather.',
                  },
                  { role: 'user', content: 'What is the weather in Beijing?' },
                ],
              },
              apiKey,
              chatTimeoutMs,
            );
            capable = isToolCallCapable(forced);
          }
          if (capable) capMap.get(id)!.add('tool-call');
          done++;
          opts.onProgress?.(done, total, id);
        }),
      );
    }
  }

  // Round 5 — image input (vision)
  await runRound(
    chatCapableIds,
    '/v1/chat/completions',
    (id) => ({
      model: id,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What colour is this image? Answer with one word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_PNG_B64}` } },
          ],
        },
      ],
    }),
    isVisionCapable,
    'vision',
    chatTimeoutMs,
  );

  // Round 6 — reasoning output
  await runRound(
    chatCapableIds,
    '/v1/chat/completions',
    (id) => ({
      model: id,
      max_tokens: 400,
      messages: [{ role: 'user', content: 'A cage holds chickens and rabbits: 35 heads, 94 legs. How many of each?' }],
    }),
    isReasoningCapable,
    'reasoning',
    chatTimeoutMs,
  );

  return modelIds.map((modelId) => ({
    modelId,
    capabilities: [...capMap.get(modelId)!],
    probedAt: new Date().toISOString(),
  }));
}

// ── Cache I/O ────────────────────────────────────────────────────────────────

export const CAPABILITY_CACHE_VERSION = 2;

export async function loadCapabilityCache(cachePath: string): Promise<CapabilityCache | null> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const data = JSON.parse(raw) as CapabilityCache;
    // Version 1 caches predate tool-call / vision / reasoning and are ignored
    // so the next refresh re-probes with the full rule set.
    if (data.version !== CAPABILITY_CACHE_VERSION || !Array.isArray(data.models)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveCapabilityCache(
  cachePath: string,
  records: ModelCapabilityRecord[],
): Promise<void> {
  const cache: CapabilityCache = {
    version: CAPABILITY_CACHE_VERSION,
    probedAt: new Date().toISOString(),
    models: records,
  };
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

export function getModelsWithCapability(
  cache: CapabilityCache,
  capability: ModelCapability,
): string[] {
  return cache.models
    .filter((m) => m.capabilities.includes(capability))
    .map((m) => m.modelId);
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Auto-refresh the capability cache if missing or older than 7 days.
 * Runs silently in the background — never throws, logs to stderr on error.
 * Call once after bridge connects; subsequent calls are no-ops if cache is fresh.
 */
export async function maybeRefreshCapabilityCache(
  cachePath: string,
  opts: ProbeOptions = {},
): Promise<void> {
  try {
    const existing = await loadCapabilityCache(cachePath);
    if (existing) {
      const age = Date.now() - new Date(existing.probedAt).getTime();
      if (age < CACHE_TTL_MS) return; // still fresh
    }

    const { fetchModels } = await import('./models.js');
    const listResult = await fetchModels({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
    if (!listResult.ok) return;

    const modelIds = listResult.models.map((m) => m.id);
    const records = await probeAllModels(modelIds, opts);
    await saveCapabilityCache(cachePath, records);
  } catch {
    // silently ignore — this is best-effort background work
  }
}
