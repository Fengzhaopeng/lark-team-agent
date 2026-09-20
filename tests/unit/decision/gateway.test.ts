import { describe, expect, it } from 'vitest';
import { readDecisionGatewayConfig } from '../../../src/decision/config';
import { DecisionGateway } from '../../../src/decision/gateway';
import type { ChoiceRequest, DecisionProvider, RawChoice } from '../../../src/decision/types';

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

function makeConfig(overrides: Record<string, unknown> = {}) {
  return readDecisionGatewayConfig({
    mode: 'active',
    model: 'fast-model',
    modelRoute: {
      tiers: [
        { label: 'light', model: 'claude-haiku-4-5', hint: 'small edits' },
        { label: 'heavy', model: 'claude-opus-4-8' },
      ],
    },
    ...overrides,
  })!;
}

function makeGateway(config = makeConfig(), provider = stub(null)) {
  return { gateway: new DecisionGateway(config, provider), provider };
}

describe('DecisionGateway — model routing', () => {
  it('is inert when no ladder is configured', async () => {
    const provider = stub({ choice: 'light', confidence: 1 });
    const gateway = new DecisionGateway(
      readDecisionGatewayConfig({ mode: 'active', model: 'm' })!,
      provider,
    );

    expect(gateway.modelRouteEnabled).toBe(false);
    await expect(gateway.routeModel('do something')).resolves.toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('maps the answered label back to a real model id', async () => {
    const { gateway } = makeGateway(makeConfig(), stub({ choice: 'heavy', confidence: 0.9 }));

    const decision = await gateway.routeModel('redesign the sync layer');

    expect(decision?.value).toBe('claude-opus-4-8');
    expect(decision?.confidence).toBe(0.9);
    expect(decision?.provider).toBe('stub');
    expect(typeof decision?.latencyMs).toBe('number');
  });

  it('sends the ladder as a closed set, with hints', async () => {
    const { gateway, provider } = makeGateway(
      makeConfig(),
      stub({ choice: 'light', confidence: 1 }),
    );

    await gateway.routeModel('rename a variable');

    expect(provider.calls[0]?.options).toEqual(['light', 'heavy']);
    expect(provider.calls[0]?.optionHints).toEqual({ light: 'small edits' });
    expect(provider.calls[0]?.input).toBe('rename a variable');
  });

  it('abstains below the threshold', async () => {
    const config = makeConfig({ threshold: 0.8 });
    const { gateway } = makeGateway(config, stub({ choice: 'heavy', confidence: 0.79 }));

    await expect(gateway.routeModel('something')).resolves.toBeNull();
  });

  it('accepts a confidence exactly at the threshold', async () => {
    const config = makeConfig({ threshold: 0.8 });
    const { gateway } = makeGateway(config, stub({ choice: 'heavy', confidence: 0.8 }));

    await expect(gateway.routeModel('something')).resolves.toMatchObject({
      value: 'claude-opus-4-8',
    });
  });

  it('abstains when the provider answers outside the ladder', async () => {
    const { gateway } = makeGateway(makeConfig(), stub({ choice: 'medium', confidence: 1 }));
    await expect(gateway.routeModel('something')).resolves.toBeNull();
  });

  it('abstains when the provider has no answer', async () => {
    const { gateway } = makeGateway(makeConfig(), stub(null));
    await expect(gateway.routeModel('something')).resolves.toBeNull();
  });

  it('truncates a long prompt to the input budget', async () => {
    const config = makeConfig({ maxInputChars: 20 });
    const { gateway, provider } = makeGateway(config, stub({ choice: 'light', confidence: 1 }));

    await gateway.routeModel('x'.repeat(500));

    expect(provider.calls[0]?.input).toHaveLength(20);
  });

  it('does not spend a provider call on an empty prompt', async () => {
    const { gateway, provider } = makeGateway();
    await expect(gateway.routeModel('   ')).resolves.toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('DecisionGateway — outbound guard', () => {
  const guardConfig = () =>
    makeConfig({ outboundGuard: { action: 'log', categories: ['api-key', 'password'], minChars: 10 } });

  it('is inert when the guard is not configured', async () => {
    const provider = stub({ choice: 'clean', confidence: 1 });
    const gateway = new DecisionGateway(makeConfig(), provider);

    expect(gateway.outboundGuardEnabled).toBe(false);
    await expect(gateway.guardOutbound('a long enough reply body')).resolves.toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('skips the call for a reply too short to matter', async () => {
    const { gateway, provider } = makeGateway(guardConfig(), stub(null));
    await expect(gateway.guardOutbound('short')).resolves.toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('reports a clean reply', async () => {
    const { gateway, provider } = makeGateway(guardConfig(), stub({ choice: 'clean', confidence: 0.95 }));

    const decision = await gateway.guardOutbound('here is the refactored module you asked for');

    expect(decision?.value).toEqual({ clean: true, category: undefined });
    expect(provider.calls[0]?.options).toEqual(['clean', 'api-key', 'password']);
  });

  it('reports the category when something is found', async () => {
    const { gateway } = makeGateway(guardConfig(), stub({ choice: 'password', confidence: 0.88 }));

    const decision = await gateway.guardOutbound('connect with mongodb://user:hunter2@10.0.0.1/db');

    expect(decision?.value).toEqual({ clean: false, category: 'password' });
    expect(decision?.confidence).toBe(0.88);
  });

  it('abstains below the threshold instead of flagging weakly', async () => {
    const config = makeConfig({
      threshold: 0.9,
      outboundGuard: { action: 'log', categories: ['api-key'], minChars: 10 },
    });
    const { gateway } = makeGateway(config, stub({ choice: 'api-key', confidence: 0.5 }));

    await expect(gateway.guardOutbound('sk-proj-abcdefghijklmnop maybe?')).resolves.toBeNull();
  });
});
