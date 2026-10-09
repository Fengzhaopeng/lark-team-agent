import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_CACHE_VERSION,
  getModelsWithCapability,
  isChatCapable,
  isImageCapable,
  isReasoningCapable,
  isToolCallCapable,
  isVideoCapable,
  isVisionCapable,
  loadCapabilityCache,
  saveCapabilityCache,
  type CapabilityCache,
  type ModelCapabilityRecord,
} from '../../../src/anthropic/model-probe.js';

/** Build a probe response the way probeEndpoint() would. */
const res = (status: number, body: unknown = null, contentType = 'application/json') => ({
  status,
  body,
  contentType,
});

const chatReply = (message: Record<string, unknown>) => ({
  choices: [{ index: 0, message, finish_reason: 'stop' }],
});

const NO_CHANNEL = {
  error: { message: 'No available channel for model foo under group mid (distributor)' },
};

describe('chat capability', () => {
  it('accepts a plain 200', () => {
    expect(isChatCapable(res(200, chatReply({ content: 'hi' })))).toBe(true);
  });

  it('accepts a 200 delivered as SSE (gateway-forced streaming)', () => {
    // Some gateways return text/event-stream even when `stream` was not asked
    // for. The body cannot be parsed as JSON — still chat-capable.
    expect(isChatCapable(res(200, null, 'text/event-stream'))).toBe(true);
  });

  it('treats a max_tokens rejection as capable (Responses-API generation)', () => {
    expect(
      isChatCapable(
        res(400, {
          error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a model with no upstream channel', () => {
    expect(isChatCapable(res(503, NO_CHANNEL))).toBe(false);
  });

  it('rejects an unknown model', () => {
    expect(isChatCapable(res(404, { error: { message: 'The model `foo` does not exist' } }))).toBe(false);
  });

  it('rejects an unrelated 400', () => {
    expect(isChatCapable(res(400, { error: { message: 'bad request shape' } }))).toBe(false);
  });
});

describe('image generation capability', () => {
  it('accepts a 200 carrying an image result', () => {
    expect(isImageCapable(res(200, { data: [{ url: 'https://x/y.png' }] }))).toBe(true);
    expect(isImageCapable(res(200, { data: [{ b64_json: 'AAAA' }] }))).toBe(true);
  });

  it('accepts a provider-specific data.image_urls response', () => {
    expect(isImageCapable(res(200, { data: { image_urls: ['https://x/y.png'] } }))).toBe(true);
  });

  it('rejects HTTP 200 carrying an upstream error object', () => {
    expect(
      isImageCapable(
        res(200, {
          error: { message: 'invalid params, unsupported model: MiniMax-M2.7', code: '2013' },
        }),
      ),
    ).toBe(false);
  });

  it('rejects HTTP 200 without an image payload', () => {
    expect(isImageCapable(res(200, { ok: true }))).toBe(false);
  });

  it('accepts a size rejection as capable', () => {
    // doubao-seedream-4-5 rejects `size: 1024x1024` ("must be at least 3686400
    // pixels") but generates fine without the parameter — still image-capable.
    expect(
      isImageCapable(
        res(400, { error: { message: 'The parameter `size` specified in the request is not valid' } }),
      ),
    ).toBe(true);
  });

  it('rejects generic invalid-value errors unrelated to dimensions', () => {
    expect(
      isImageCapable(res(400, { error: { message: 'invalid_value: unsupported model' } })),
    ).toBe(false);
    expect(
      isImageCapable(res(400, { error: { message: 'The model is not valid for this endpoint' } })),
    ).toBe(false);
  });

  it('rejects a model with no upstream channel', () => {
    expect(isImageCapable(res(503, NO_CHANNEL))).toBe(false);
  });
});

describe('video generation capability', () => {
  it('accepts a 200 carrying a task id', () => {
    expect(isVideoCapable(res(200, { task_id: 't-1' }))).toBe(true);
  });

  it('rejects a 200 without a task object', () => {
    expect(isVideoCapable(res(200, { ok: true }))).toBe(false);
  });
});

describe('tool-call capability', () => {
  it('accepts a reply that actually contains tool_calls', () => {
    expect(
      isToolCallCapable(
        res(200, chatReply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'get_weather' } }] })),
      ),
    ).toBe(true);
  });

  it('rejects a 200 with an empty tool_calls array', () => {
    expect(isToolCallCapable(res(200, chatReply({ content: 'sorry', tool_calls: [] })))).toBe(false);
  });

  it('rejects a 200 with plain text (model ignored the tools)', () => {
    expect(isToolCallCapable(res(200, chatReply({ content: 'Beijing is sunny.' })))).toBe(false);
  });

  it('rejects the hard error raised by gpt-6-astra on chat/completions', () => {
    expect(
      isToolCallCapable(
        res(400, {
          error: {
            message:
              'Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions.',
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('vision capability', () => {
  it('accepts a 200', () => {
    expect(isVisionCapable(res(200, chatReply({ content: 'red' })))).toBe(true);
  });

  it('rejects an upstream that cannot take images', () => {
    expect(isVisionCapable(res(400, { error: { message: 'No endpoints found that support image input' } }))).toBe(
      false,
    );
  });
});

describe('reasoning capability', () => {
  it('accepts a reasoning_content field', () => {
    expect(isReasoningCapable(res(200, chatReply({ content: 'x', reasoning_content: 'thinking…' })))).toBe(true);
  });

  it('accepts a reasoning token count', () => {
    expect(
      isReasoningCapable(
        res(200, { choices: [{ message: { content: '16' } }], usage: { completion_tokens_details: { reasoning_tokens: 42 } } }),
      ),
    ).toBe(true);
  });

  it('rejects a plain answer with no reasoning signal', () => {
    expect(
      isReasoningCapable(res(200, { choices: [{ message: { content: '16' } }], usage: { completion_tokens: 3 } })),
    ).toBe(false);
  });
});

describe('capability cache', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('round-trips records at the current version', async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-cache-'));
    const path = join(dir, 'nested', 'cache.json');
    const records: ModelCapabilityRecord[] = [
      { modelId: 'a', capabilities: ['chat', 'tool-call', 'vision'], probedAt: '2026-09-23T00:00:00.000Z' },
      { modelId: 'b', capabilities: [], probedAt: '2026-09-23T00:00:00.000Z' },
    ];
    await saveCapabilityCache(path, records);

    const loaded = await loadCapabilityCache(path);
    expect(loaded?.version).toBe(CAPABILITY_CACHE_VERSION);
    expect(getModelsWithCapability(loaded!, 'chat')).toEqual(['a']);
    expect(getModelsWithCapability(loaded!, 'tool-call')).toEqual(['a']);
    expect(getModelsWithCapability(loaded!, 'video-gen')).toEqual([]);
  });

  it('ignores a version-1 cache so the next refresh re-probes', async () => {
    // v1 has no tool-call / vision / reasoning — treating it as valid would
    // silently hide those capabilities until the 7-day TTL expires.
    dir = await mkdtemp(join(tmpdir(), 'probe-cache-'));
    const path = join(dir, 'cache.json');
    const v1: CapabilityCache = {
      version: 1 as unknown as 2,
      probedAt: '2026-09-01T00:00:00.000Z',
      models: [{ modelId: 'a', capabilities: ['chat'], probedAt: '2026-09-01T00:00:00.000Z' }],
    };
    await writeFile(path, JSON.stringify(v1), 'utf8');
    expect(await loadCapabilityCache(path)).toBeNull();
  });

  it('returns null for a missing or corrupt cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-cache-'));
    expect(await loadCapabilityCache(join(dir, 'absent.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json', 'utf8');
    expect(await loadCapabilityCache(bad)).toBeNull();
    // Sanity: the file itself is really there.
    expect((await readFile(bad, 'utf8')).length).toBeGreaterThan(0);
  });
});
