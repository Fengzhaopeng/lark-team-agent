import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  providerAvailability,
  readDecisionGatewayConfig,
  resolveProviderEndpoint,
} from '../../../src/decision/config';

describe('decision gateway config', () => {
  it('is absent unless the block exists and mode is dry-run or active', () => {
    expect(readDecisionGatewayConfig(undefined)).toBeUndefined();
    expect(readDecisionGatewayConfig(null)).toBeUndefined();
    expect(readDecisionGatewayConfig('active')).toBeUndefined();
    expect(readDecisionGatewayConfig({})).toBeUndefined();
    expect(readDecisionGatewayConfig({ mode: 'off' })).toBeUndefined();
    expect(readDecisionGatewayConfig({ mode: 'ACTIVE' })).toBeUndefined();

    expect(readDecisionGatewayConfig({ mode: 'dry-run' })).toBeDefined();
    expect(readDecisionGatewayConfig({ mode: 'active' })).toBeDefined();
  });

  it('fills defaults so a minimal block is usable', () => {
    const config = readDecisionGatewayConfig({ mode: 'active' });
    expect(config).toMatchObject({
      mode: 'active',
      model: '',
      threshold: DEFAULT_THRESHOLD,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxInputChars: DEFAULT_MAX_INPUT_CHARS,
    });
  });

  it('clamps the threshold into [0,1] and ignores non-finite values', () => {
    expect(readDecisionGatewayConfig({ mode: 'active', threshold: 5 })?.threshold).toBe(1);
    expect(readDecisionGatewayConfig({ mode: 'active', threshold: -2 })?.threshold).toBe(0);
    expect(readDecisionGatewayConfig({ mode: 'active', threshold: 0.42 })?.threshold).toBe(0.42);
    expect(readDecisionGatewayConfig({ mode: 'active', threshold: NaN })?.threshold).toBe(
      DEFAULT_THRESHOLD,
    );
  });

  it('falls back on non-positive budgets instead of accepting them', () => {
    const config = readDecisionGatewayConfig({
      mode: 'active',
      timeoutMs: 0,
      maxInputChars: -10,
    });
    expect(config?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config?.maxInputChars).toBe(DEFAULT_MAX_INPUT_CHARS);
  });

  it('treats a single-rung ladder as no routing at all', () => {
    const one = readDecisionGatewayConfig({
      mode: 'active',
      modelRoute: { tiers: [{ label: 'only', model: 'claude-haiku-4-5' }] },
    });
    expect(one?.modelRoute).toBeUndefined();

    const two = readDecisionGatewayConfig({
      mode: 'active',
      modelRoute: {
        tiers: [
          { label: 'light', model: 'claude-haiku-4-5' },
          { label: 'heavy', model: 'claude-opus-4-8', hint: 'hard stuff' },
        ],
      },
    });
    expect(two?.modelRoute?.tiers).toEqual([
      { label: 'light', model: 'claude-haiku-4-5' },
      { label: 'heavy', model: 'claude-opus-4-8', hint: 'hard stuff' },
    ]);
  });

  it('drops malformed rungs rather than failing the whole block', () => {
    const config = readDecisionGatewayConfig({
      mode: 'active',
      modelRoute: {
        tiers: [
          { label: 'ok', model: 'claude-haiku-4-5' },
          { label: '   ', model: 'claude-sonnet-5' },
          { label: 'no-model' },
          'not-an-object',
          { label: 'second', model: 'claude-opus-4-8' },
        ],
      },
    });
    expect(config?.modelRoute?.tiers.map((tier) => tier.label)).toEqual(['ok', 'second']);
  });

  it('normalises the outbound guard: unknown categories dropped, action defaults to log', () => {
    const defaults = readDecisionGatewayConfig({
      mode: 'active',
      outboundGuard: {},
    });
    expect(defaults?.outboundGuard).toEqual({
      action: 'log',
      categories: ['api-key', 'password', 'internal-host', 'private-path'],
      minChars: 40,
    });

    const explicit = readDecisionGatewayConfig({
      mode: 'active',
      outboundGuard: { action: 'block', categories: ['api-key', 'nonsense'], minChars: 200 },
    });
    expect(explicit?.outboundGuard).toEqual({
      action: 'block',
      categories: ['api-key'],
      minChars: 200,
    });
  });

  it('treats a guard with only unknown categories as guarding everything', () => {
    // An empty allowlist would silently disable the guard, which is the one
    // failure mode an operator would never notice until it mattered.
    const config = readDecisionGatewayConfig({
      mode: 'active',
      outboundGuard: { categories: ['typo'] },
    });
    expect(config?.outboundGuard?.categories).toHaveLength(4);
  });

  it('reports what the provider is still missing', () => {
    const noModel = readDecisionGatewayConfig({ mode: 'active' })!;
    expect(providerAvailability(noModel, {})).toEqual({ ok: false, reason: 'no-model-configured' });

    const noBase = readDecisionGatewayConfig({ mode: 'active', model: 'm' })!;
    expect(providerAvailability(noBase, {})).toEqual({ ok: false, reason: 'no-base-url' });

    const noKey = readDecisionGatewayConfig({ mode: 'active', model: 'm' })!;
    expect(providerAvailability(noKey, { ANTHROPIC_BASE_URL: 'https://gw.example' })).toEqual({
      ok: false,
      reason: 'no-api-key',
    });

    expect(
      providerAvailability(noKey, {
        ANTHROPIC_BASE_URL: 'https://gw.example',
        ANTHROPIC_API_KEY: 'sk-test',
      }),
    ).toEqual({ ok: true });
  });

  it('prefers explicit credentials over the environment and trims trailing slashes', () => {
    const config = readDecisionGatewayConfig({
      mode: 'active',
      model: 'm',
      baseUrl: 'https://explicit.example///',
      apiKey: 'sk-explicit',
    })!;
    expect(
      resolveProviderEndpoint(config, {
        ANTHROPIC_BASE_URL: 'https://env.example',
        ANTHROPIC_API_KEY: 'sk-env',
      }),
    ).toEqual({ baseUrl: 'https://explicit.example', apiKey: 'sk-explicit' });
  });

  it('returns no endpoint when the environment cannot satisfy it', () => {
    const config = readDecisionGatewayConfig({ mode: 'active', model: 'm' })!;
    expect(resolveProviderEndpoint(config, {})).toBeUndefined();
  });
});
