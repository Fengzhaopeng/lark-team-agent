import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../../src/config/profile-schema';
import { readDecisionGatewayConfig } from '../../../src/decision/config';
import { DecisionGateway } from '../../../src/decision/gateway';
import {
  buildGatewayFromPreferences,
  resolveRoutedModel,
  scanOutboundReply,
} from '../../../src/decision/integrate';
import type { ChoiceRequest, DecisionProvider, RawChoice } from '../../../src/decision/types';

type Preferences = ProfileConfig['preferences'];

function stub(answer: RawChoice | null): DecisionProvider & { calls: ChoiceRequest[] } {
  const calls: ChoiceRequest[] = [];
  return {
    name: 'stub',
    calls,
    async choose(req: ChoiceRequest): Promise<RawChoice | null> {
      calls.push(req);
      return answer;
    },
  };
}

function gatewayWith(overrides: Record<string, unknown>, provider: DecisionProvider) {
  const config = readDecisionGatewayConfig({
    mode: 'active',
    model: 'fast-model',
    modelRoute: {
      tiers: [
        { label: 'light', model: 'claude-haiku-4-5' },
        { label: 'heavy', model: 'claude-opus-4-8' },
      ],
    },
    ...overrides,
  });
  return new DecisionGateway(config!, provider);
}

describe('buildGatewayFromPreferences', () => {
  const enabled = {
    decisionGateway: { mode: 'active', model: 'fast-model' },
  } as Preferences;

  it('returns nothing when the feature is off', () => {
    expect(buildGatewayFromPreferences({} as Preferences, {})).toBeUndefined();
  });

  it('returns nothing when the feature is on but the provider is unusable', () => {
    // Half-active is worse than off: an operator who forgot the credentials
    // should get the plain code path plus one warning, not a gateway that
    // abstains on every call forever.
    expect(buildGatewayFromPreferences(enabled, {})).toBeUndefined();
  });

  it('builds a gateway once the environment can satisfy it', () => {
    const gateway = buildGatewayFromPreferences(enabled, {
      ANTHROPIC_BASE_URL: 'https://gw.example',
      ANTHROPIC_API_KEY: 'sk-test',
    });
    expect(gateway).toBeInstanceOf(DecisionGateway);
    expect(gateway?.providerName).toBe('chat:fast-model');
  });
});

describe('resolveRoutedModel', () => {
  it('keeps the profile model when no gateway block exists', async () => {
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'do a thing',
      env: {},
    });
    expect(model).toBeUndefined();
  });

  it('applies the routed tier when the profile left the model unset', async () => {
    const provider = stub({ choice: 'heavy', confidence: 0.95 });
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'redesign the whole sync layer',
      gateway: gatewayWith({}, provider),
    });

    expect(model).toBe('claude-opus-4-8');
    expect(provider.calls).toHaveLength(1);
  });

  it('never overrides a model the operator pinned', async () => {
    const provider = stub({ choice: 'heavy', confidence: 1 });
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: { model: 'claude-sonnet-5' } as Preferences,
      prompt: 'redesign the whole sync layer',
      gateway: gatewayWith({}, provider),
    });

    expect(model).toBe('claude-sonnet-5');
    // A human pin is a decision, not an input to the router.
    expect(provider.calls).toHaveLength(0);
  });

  it('decides but changes nothing in dry-run', async () => {
    const provider = stub({ choice: 'heavy', confidence: 0.99 });
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'redesign the whole sync layer',
      gateway: gatewayWith({ mode: 'dry-run' }, provider),
    });

    expect(model).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });

  it('falls back when a tier names a model this agent kind cannot run', async () => {
    const provider = stub({ choice: 'bogus', confidence: 1 });
    const gateway = gatewayWith(
      {
        modelRoute: {
          tiers: [
            { label: 'light', model: 'claude-haiku-4-5' },
            { label: 'bogus', model: 'gpt-9-imaginary' },
          ],
        },
      },
      provider,
    );

    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'anything',
      gateway,
    });

    // A typo in the tier table must degrade to the default, never reach the
    // CLI as an unknown `--model`.
    expect(model).toBeUndefined();
  });

  it('falls back when the router abstains', async () => {
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'anything',
      gateway: gatewayWith({ threshold: 0.95 }, stub({ choice: 'light', confidence: 0.4 })),
    });
    expect(model).toBeUndefined();
  });

  it('falls back when the provider is unreachable', async () => {
    const model = await resolveRoutedModel({
      agentKind: 'claude',
      preferences: {} as Preferences,
      prompt: 'anything',
      gateway: gatewayWith({}, stub(null)),
    });
    expect(model).toBeUndefined();
  });
});

describe('scanOutboundReply', () => {
  const guard = (overrides: Record<string, unknown> = {}) => ({
    outboundGuard: { action: 'log', categories: ['api-key', 'password'], minChars: 10 },
    ...overrides,
  });

  const reply = 'Here is the connection string you asked about, in full.';

  it('passes everything through when no gateway block exists', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      env: {},
    });
    expect(result).toEqual({ flagged: false, blocked: false });
  });

  it('passes a clean reply', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(guard(), stub({ choice: 'clean', confidence: 0.9 })),
    });
    expect(result).toEqual({ flagged: false, blocked: false });
  });

  it('flags without blocking in log mode', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(guard(), stub({ choice: 'password', confidence: 0.9 })),
    });

    expect(result.flagged).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.category).toBe('password');
    expect(result.notice).toContain('password');
    expect(result.notice).toContain('未拦截');
  });

  it('blocks in block mode', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(guard({ outboundGuard: { action: 'block' } }), stub({
        choice: 'api-key',
        confidence: 0.9,
      })),
    });

    expect(result.flagged).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('api-key');
    expect(result.notice).toContain('已被拦截');
  });

  it('never blocks in dry-run, even with action=block', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(
        { mode: 'dry-run', outboundGuard: { action: 'block' } },
        stub({ choice: 'api-key', confidence: 0.99 }),
      ),
    });

    expect(result.flagged).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it('fails open when the provider cannot answer', async () => {
    // A guard bug must not be able to blackhole everyone's replies.
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(guard(), stub(null)),
    });
    expect(result).toEqual({ flagged: false, blocked: false });
  });

  it('fails open below the confidence threshold', async () => {
    const result = await scanOutboundReply({
      text: reply,
      preferences: {} as Preferences,
      gateway: gatewayWith(guard({ threshold: 0.95 }), stub({ choice: 'password', confidence: 0.3 })),
    });
    expect(result).toEqual({ flagged: false, blocked: false });
  });
});
