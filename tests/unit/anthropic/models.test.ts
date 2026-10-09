import { describe, expect, it } from 'vitest';
import { filterByCapability, filterChatModels, groupModels, keepLatestVersions, type ModelInfo } from '../../../src/anthropic/models.js';
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

describe('keepLatestVersions', () => {
  const kept = (all: ModelInfo[], opts?: Parameters<typeof keepLatestVersions>[1]) =>
    keepLatestVersions(all, opts).models.map((m) => m.id);

  it('collapses a product line to its highest generation', () => {
    // Rule 3: gpt-5 … gpt-5.5 are one line; only the newest survives.
    const all = models('gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.5');
    expect(kept(all)).toEqual(['gpt-5.5']);
    expect(keepLatestVersions(all).dropped.map((m) => m.id)).toEqual([
      'gpt-5',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.4',
    ]);
  });

  it('keeps same-generation tiers as separate lines (rule 2)', () => {
    // Tier words are part of the line, so these are three lines, not versions.
    const all = models('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna');
    expect(kept(all)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  });

  it('keeps a tiered line alive next to the collapsing base line', () => {
    const all = models('glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash');
    expect(kept(all)).toEqual(['glm-5.3', 'glm-5.3-flash']);
  });

  it('drops a bare vendor handle once a tiered line moves ahead (rule 4)', () => {
    const all = models('gpt-5.5', 'gpt-5.6-sol', 'gpt-6-astra');
    expect(kept(all)).toEqual(['gpt-5.6-sol', 'gpt-6-astra']);
  });

  it('drops pre-numbering names once the vendor ships numbered lines (rule 5)', () => {
    const all = models('qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3.8-max');
    // qwen-max collapses into the qwen3.8-max line; plus/turbo have no digits.
    expect(kept(all)).toEqual(['qwen3.8-max']);
  });

  it('prefers the undated alias over a dated snapshot (rule 3)', () => {
    expect(kept(models('qwen3.8-max-0902', 'qwen3.8-max'))).toEqual(['qwen3.8-max']);
  });

  it('prefers the newest date stamp within one generation (rule 3)', () => {
    const all = models('doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-pro-260628');
    expect(kept(all)).toEqual(['doubao-seed-2-1-pro-260915']);
  });

  it('prefers the stable name over its preview twin (rule 3)', () => {
    expect(kept(models('gemini-3.1-pro-preview', 'gemini-3.1-pro'))).toEqual(['gemini-3.1-pro']);
  });

  it('exempts evergreen aliases from the unnumbered-legacy rule', () => {
    // deepseek-flash tracks the newest backend despite looking version-less.
    const alias = models('deepseek-flash', 'deepseek-v4-flash');
    expect(kept(alias)).toEqual(['deepseek-flash', 'deepseek-v4-flash']);
    // doubao-seed-evolving is the same shape on the Doubao side.
    expect(kept(models('doubao-seed-evolving', 'doubao-seed-2-0-lite-260428'))).toEqual([
      'doubao-seed-evolving',
      'doubao-seed-2-0-lite-260428',
    ]);
    // Control: the same shape without an alias entry does get dropped.
    const control = models('acme-legacy', 'acme-v4-legacy');
    expect(kept(control)).toEqual(['acme-v4-legacy']);
  });

  it('normalizes the -4o marketing suffix into generation 4', () => {
    // Without the alias gpt-4o would parse as its own bogus "gpt-o" line.
    expect(kept(models('gpt-4o', 'gpt-4.1'))).toEqual(['gpt-4.1']);
  });

  it('does not read size and parameter suffixes as versions', () => {
    const all = models('Qwen3.8-27B', 'qwen3.8-max');
    expect(kept(all)).toEqual(['Qwen3.8-27B', 'qwen3.8-max']);
  });

  it('drops a tiered line two or more major generations behind (rule 6)', () => {
    // gpt-4-turbo has no newer turbo sibling, so rule 3 never touches it; the
    // vendor-wide floor is what exposes it.
    expect(kept(models('gpt-4-turbo', 'gpt-6-astra'))).toEqual(['gpt-6-astra']);
    expect(kept(models('glm-3-turbo', 'glm-5.3'))).toEqual(['glm-5.3']);
  });

  it('allows one generation of slack so the previous major survives', () => {
    // Operators run the previous major alongside the new one on purpose.
    expect(kept(models('gpt-5-turbo', 'gpt-6-astra'))).toEqual(['gpt-5-turbo', 'gpt-6-astra']);
    expect(kept(models('gpt-5.6-sol', 'gpt-6-astra'))).toEqual(['gpt-5.6-sol', 'gpt-6-astra']);
  });

  it('keeps the active model even when a newer generation exists', () => {
    const all = models('claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5');
    expect(kept(all)).toEqual(['claude-opus-5']);
    expect(kept(all, { alwaysKeep: ['claude-opus-4-8'] })).toEqual([
      'claude-opus-4-8',
      'claude-opus-5',
    ]);
  });
});
