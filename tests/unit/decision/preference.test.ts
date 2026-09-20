import { describe, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';
import { readDecisionGatewayConfig } from '../../../src/decision/config';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

function profile(preferences: Record<string, unknown>) {
  return normalizeProfileConfig({
    schemaVersion: 2,
    agentKind: 'claude',
    accounts: { app },
    preferences,
  });
}

/**
 * The gateway is configured through `preferences`, which is written by one
 * code path (`normalizePreferences`) and read by another. If the writer drops
 * unknown keys the feature would look configured in the file and be absent at
 * runtime — a failure that is invisible until someone wonders why nothing
 * routes. These tests pin the round trip.
 */
describe('decisionGateway preference round-trip', () => {
  it('stays absent when not configured, leaving existing profiles untouched', () => {
    const cfg = profile({ model: 'claude-sonnet-5' });

    expect('decisionGateway' in cfg.preferences).toBe(false);
    expect(readDecisionGatewayConfig(cfg.preferences.decisionGateway)).toBeUndefined();
  });

  it('survives config normalisation intact', () => {
    const cfg = profile({
      decisionGateway: {
        mode: 'dry-run',
        model: 'fast-model',
        modelRoute: {
          tiers: [
            { label: 'light', model: 'claude-haiku-4-5' },
            { label: 'heavy', model: 'claude-opus-4-8' },
          ],
        },
        outboundGuard: { action: 'log', categories: ['api-key'] },
      },
    });

    // Read it back through the same parser the bridge uses at runtime.
    const parsed = readDecisionGatewayConfig(cfg.preferences.decisionGateway);
    expect(parsed).toMatchObject({
      mode: 'dry-run',
      model: 'fast-model',
      outboundGuard: { action: 'log', categories: ['api-key'] },
    });
    expect(parsed?.modelRoute?.tiers).toHaveLength(2);
  });

  it('does not disturb sibling preferences', () => {
    const cfg = profile({
      model: 'claude-sonnet-5',
      showToolCalls: false,
      decisionGateway: { mode: 'active', model: 'fast-model' },
    });

    expect(cfg.preferences.model).toBe('claude-sonnet-5');
    expect(cfg.preferences.showToolCalls).toBe(false);
    expect(readDecisionGatewayConfig(cfg.preferences.decisionGateway)?.mode).toBe('active');
  });

  it('survives a full profile JSON round-trip', () => {
    const cfg = profile({
      decisionGateway: { mode: 'active', model: 'fast-model', threshold: 0.6 },
    });

    const reparsed = normalizeProfileConfig(JSON.parse(JSON.stringify(cfg)));
    expect(readDecisionGatewayConfig(reparsed.preferences.decisionGateway)).toMatchObject({
      mode: 'active',
      model: 'fast-model',
      threshold: 0.6,
    });
  });
});
