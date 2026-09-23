import { describe, expect, it } from 'vitest';
import { filterByCapability, filterChatModels, groupModels, type ModelInfo } from '../../../src/anthropic/models.js';
import type { CapabilityCache } from '../../../src/anthropic/model-probe.js';

const models = (...ids: string[]): ModelInfo[] => ids.map((id) => ({ id }));

describe('filterChatModels without a probe cache', () => {
  it('drops non-conversational names by convention', () => {
    const all = models(
      'claude-opus-5',
      'gpt-5.6-sol',
      'deepseek-v4-pro',
      'text-embedding-3-large',
      'gpt-image-2',
      'gpt-image-1',
      'imagen-3.0-generate-002',
      'doubao-seedream-5-0-pro-260628',
      'doubao-seedance-2-0-260128',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image-preview',
      'gpt-4o-mini-tts',
      'gpt-4o-transcribe',
      'gpt-realtime-2.1',
      'gpt-4o-audio-preview',
      'text-moderation-latest',
      'whisper-1',
    );
    expect(filterChatModels(all).map((m) => m.id)).toEqual([
      'claude-opus-5',
      'gpt-5.6-sol',
      'deepseek-v4-pro',
    ]);
  });

  it('keeps models whose names merely mention a similar word', () => {
    // Guards against an over-eager pattern: these are real chat models.
    const all = models('qwen3-coder-plus', 'glm-4v-plus', 'hy4-preview', 'kimi-k2.7-code', 'mimo-v2.5-pro');
    expect(filterChatModels(all)).toHaveLength(all.length);
  });
});

describe('filterChatModels with a probe cache', () => {
  const cache = (ids: string[]): CapabilityCache => ({
    version: 2,
    probedAt: '2026-09-23T00:00:00.000Z',
    models: ids.map((id) => ({ modelId: id, capabilities: ['chat'], probedAt: '2026-09-23T00:00:00.000Z' })),
  });

  it('treats the cache as authoritative, overriding name heuristics', () => {
    const all = models('gpt-image-2', 'claude-opus-5');
    // The cache says gpt-image-2 is chat-capable → it survives even though the
    // name-based filter would have dropped it.
    expect(filterChatModels(all, cache(['gpt-image-2'])).map((m) => m.id)).toEqual(['gpt-image-2']);
  });

  it('drops a chat-looking model the cache does not list', () => {
    const all = models('claude-opus-5', 'ghost-model');
    expect(filterChatModels(all, cache(['claude-opus-5'])).map((m) => m.id)).toEqual(['claude-opus-5']);
  });
});

describe('filterByCapability', () => {
  const cache: CapabilityCache = {
    version: 2,
    probedAt: '2026-09-23T00:00:00.000Z',
    models: [
      { modelId: 'gemini-3.1-flash-image', capabilities: ['chat', 'image-gen'], probedAt: 'x' },
      { modelId: 'claude-opus-5', capabilities: ['chat', 'tool-call', 'vision', 'reasoning'], probedAt: 'x' },
      { modelId: 'glm-5.3', capabilities: ['chat', 'tool-call', 'reasoning'], probedAt: 'x' },
    ],
  };

  it('selects by the new capability kinds', () => {
    const all = models('gemini-3.1-flash-image', 'claude-opus-5', 'glm-5.3');
    expect(filterByCapability(all, 'image-gen', cache).map((m) => m.id)).toEqual(['gemini-3.1-flash-image']);
    expect(filterByCapability(all, 'vision', cache).map((m) => m.id)).toEqual(['claude-opus-5']);
    expect(filterByCapability(all, 'tool-call', cache).map((m) => m.id)).toEqual(['claude-opus-5', 'glm-5.3']);
    expect(filterByCapability(all, 'video-gen', cache)).toEqual([]);
  });
});

describe('groupModels', () => {
  it('groups by family and parks the rest in Other', () => {
    const all = models('claude-opus-5', 'gpt-5.6-sol', 'deepseek-v4-pro', 'weird-model');
    const labels = groupModels(all).map((g) => g.label);
    expect(labels).toContain('Claude');
    expect(labels).toContain('GPT');
    expect(labels).toContain('DeepSeek');
    expect(labels[labels.length - 1]).toBe('Other');
  });
});
