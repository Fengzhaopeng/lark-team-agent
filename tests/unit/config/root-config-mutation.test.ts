import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema';
import {
  isRootConfig,
  loadRootConfig,
  saveRootConfig,
  updateProfileInRootConfig,
} from '../../../src/config/profile-store';

/**
 * Regression tests for the config.wipe bug (2026-09-17).
 *
 * `/@bot on|off|reset` used to persist via the legacy flat `saveConfig()`,
 * which serializes whatever object it is handed. It was handed the *profile*
 * config, so `config.json` was rewritten as a bare ProfileConfig — no
 * `{activeProfile, profiles}` wrapper. `isRootConfig()` then rejected the file,
 * `loadRootConfig()` returned `undefined`, and the next start bootstrapped an
 * empty default profile: the whitelist, admins and every other setting were
 * silently cleared until an admin rebuilt them by hand.
 */

const roots: string[] = [];

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpConfigPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-root-config-'));
  roots.push(root);
  return join(root, 'config.json');
}

function claudeProfile(): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    mode: 'team',
    accounts: { app },
    access: {
      allowedUsers: ['ou_user'],
      allowedChats: ['oc_chat'],
      admins: ['ou_admin'],
      requireMentionInGroup: true,
    },
  });
}

describe('root config mutation', () => {
  it('creates a valid root config when none exists yet', async () => {
    const configPath = await tmpConfigPath();

    await updateProfileInRootConfig(
      { configPath, profile: 'claude', fallback: claudeProfile() },
      (profile) => ({
        ...profile,
        preferences: { ...profile.preferences, model: 'claude-sonnet-5' },
      }),
    );

    const loaded = await loadRootConfig(configPath);
    expect(loaded).toBeDefined();
    expect(loaded?.activeProfile).toBe('claude');
    expect(loaded?.profiles.claude?.preferences.model).toBe('claude-sonnet-5');
    expect(loaded?.profiles.claude?.access.allowedChats).toEqual(['oc_chat']);
  });

  it('heals a config.json that was clobbered with a bare ProfileConfig', async () => {
    const configPath = await tmpConfigPath();
    const fallback = claudeProfile();
    // Exactly what the legacy flat `saveConfig()` leaves behind: the profile
    // config with no root wrapper. It parses as JSON but is not a root config.
    await writeFile(configPath, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');

    expect(isRootConfig(JSON.parse(await readFile(configPath, 'utf8')))).toBe(false);
    expect(await loadRootConfig(configPath)).toBeUndefined();

    await updateProfileInRootConfig({ configPath, profile: 'claude', fallback }, (profile) => ({
      ...profile,
      access: { ...profile.access, allowedUsers: [...profile.access.allowedUsers, 'ou_second'] },
    }));

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.access.allowedUsers).toEqual(['ou_user', 'ou_second']);
    expect(loaded?.profiles.claude?.access.allowedChats).toEqual(['oc_chat']);
    expect(loaded?.profiles.claude?.access.admins).toEqual(['ou_admin']);
    // The config that was just healed must not be re-broken by another write.
    expect(isRootConfig(JSON.parse(await readFile(configPath, 'utf8')))).toBe(true);
  });

  it('writes the supplied root-level secrets and keeps other profiles', async () => {
    const configPath = await tmpConfigPath();
    await saveRootConfig(
      {
        schemaVersion: 2,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: claudeProfile(), 'codex-dev': claudeProfile() },
      },
      configPath,
    );

    const secrets = {
      providers: {
        bridge: { source: 'exec' as const, command: '/tmp/secrets-getter', args: [] },
      },
    };
    await updateProfileInRootConfig(
      { configPath, profile: 'claude', fallback: claudeProfile(), secrets },
      (profile) => ({ ...profile, accounts: { app: { ...app, id: 'cli_new' } } }),
    );

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.secrets?.providers?.bridge?.command).toBe('/tmp/secrets-getter');
    expect(loaded?.profiles.claude?.accounts.app.id).toBe('cli_new');
    expect(loaded?.profiles['codex-dev']).toBeDefined();
  });

  it('does not write a config when the mutation throws', async () => {
    const configPath = await tmpConfigPath();

    await expect(
      updateProfileInRootConfig({ configPath, profile: 'claude', fallback: claudeProfile() }, () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');

    expect(await loadRootConfig(configPath)).toBeUndefined();
  });
});

describe('root config serialization', () => {
  it('persists the deployment mode so team mode survives a restart', async () => {
    const configPath = await tmpConfigPath();

    await saveRootConfig(
      {
        schemaVersion: 2,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: claudeProfile() },
      },
      configPath,
    );

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.mode).toBe('team');
  });
});

describe('settings write contract', () => {
  it('never routes command settings writes through the legacy flat saveConfig()', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../../src/commands/index.ts', import.meta.url)),
      'utf8',
    );

    // A bare ProfileConfig written to config.json is rejected by isRootConfig(),
    // which resets every setting on the next start — so the settings commands
    // must go through updateProfileInRootConfig() instead.
    expect(source).not.toMatch(/await\s+saveConfig\s*\(/);
    expect(source).toContain('updateProfileInRootConfig');
  });
});
