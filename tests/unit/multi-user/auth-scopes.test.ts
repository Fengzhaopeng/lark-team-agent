import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_DOMAINS,
  authDomainArgs,
  defaultAuthDomainArgs,
  detectAuthNeed,
  domainsForMissingScopes,
} from '../../../src/multi-user/auth-scopes';

// Real lark-cli outputs captured from the production agent transcripts.
const TOKEN_MISSING_USER = `Exit code 3
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authentication",
    "subtype": "token_missing",
    "message": "need_user_authorization (user: )",
    "hint": "run: lark-cli auth login to re-authorize\\ncurrent command requires scope(s): spark:app:read"
  }
}`;

const MINUTES_BATCH = `[minutes +detail] done: 1 total, 0 succeeded, 1 failed
{
  "ok": false,
  "identity": "user",
  "data": { "minutes": [ { "error": "failed to query minute: need_user_authorization (user: )" } ] }
}`;

const BOT_APP_SCOPE = `{
  "ok": false,
  "identity": "bot",
  "error": {
    "type": "authorization",
    "subtype": "app_scope_not_applied",
    "code": 99991672,
    "message": "access denied: app cli_x has not applied for the required scope(s): search:message",
    "hint": "the app developer must apply ... scopes=search%3Amessage"
  }
}`;

const USER_MISSING_SCOPE = `{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authorization",
    "subtype": "missing_scope",
    "message": "missing required scope(s): calendar:calendar.event:create",
    "hint": "run: lark-cli auth login --scope \\"calendar:calendar.event:create\\""
  }
}`;

describe('default auth domains', () => {
  it('stays small and excludes the high-risk / unused domains', () => {
    expect(DEFAULT_AUTH_DOMAINS).toEqual(['docs', 'drive', 'sheets', 'wiki', 'im']);
    for (const d of ['mail', 'calendar', 'approval', 'okr', 'vc', 'attendance']) {
      expect(DEFAULT_AUTH_DOMAINS).not.toContain(d);
    }
  });

  it('renders --domain args, never --recommend', () => {
    expect(defaultAuthDomainArgs()).toEqual(['--domain', 'docs,drive,sheets,wiki,im']);
    expect(authDomainArgs()).toEqual(['--domain', 'docs,drive,sheets,wiki,im']);
    expect(authDomainArgs()).not.toContain('--recommend');
  });

  it('widens with on-demand domains and dedupes', () => {
    expect(authDomainArgs(['calendar', 'docs', 'calendar'])).toEqual([
      '--domain',
      'docs,drive,sheets,wiki,im,calendar',
    ]);
  });
});

describe('detectAuthNeed', () => {
  it('flags a user token_missing error and extracts the needed scope', () => {
    const need = detectAuthNeed(TOKEN_MISSING_USER, true);
    expect(need?.kind).toBe('token_missing');
    expect(need?.missingScopes).toContain('spark:app:read');
    expect(need?.domains).toEqual(['apps']);
  });

  it('flags need_user_authorization buried in a batch result', () => {
    expect(detectAuthNeed(MINUTES_BATCH, false)?.kind).toBe('token_missing');
  });

  it('flags a user missing_scope and maps it to its domain', () => {
    const need = detectAuthNeed(USER_MISSING_SCOPE, true);
    expect(need?.kind).toBe('scope_missing');
    expect(need?.domains).toEqual(['calendar']);
  });

  it('IGNORES bot-identity failures: user OAuth cannot fix an app-console scope', () => {
    expect(detectAuthNeed(BOT_APP_SCOPE, true)).toBeUndefined();
  });

  it('ignores unrelated errors and empty output', () => {
    expect(detectAuthNeed('', true)).toBeUndefined();
    expect(detectAuthNeed('{"ok": false, "error": {"type": "validation"}}', true)).toBeUndefined();
    expect(detectAuthNeed('permission denied: /workspace/x', true)).toBeUndefined();
  });

  it('ignores skill/reference text that merely documents these errors', () => {
    const doc = '#### missing_scope\n`missing_scopes`：列出缺失的 scope\nneed_user_authorization 说明';
    expect(detectAuthNeed(doc, false)).toBeUndefined();
  });
});

describe('domainsForMissingScopes', () => {
  it('maps scope prefixes to lark-cli domains', () => {
    expect(domainsForMissingScopes(['mail:user_mailbox:readonly'])).toEqual(['mail']);
    expect(domainsForMissingScopes(['base:record:read', 'task:task:read'])).toEqual(['base', 'task']);
    expect(domainsForMissingScopes(['docx:document:create'])).toEqual(['docs']);
    expect(domainsForMissingScopes(['unknown:thing:read'])).toEqual([]);
  });
});

describe('UserTokenRegistry.markNeedsAuth', () => {
  it('resets a ready user to none so the next message re-triggers authorization', async () => {
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { UserTokenRegistry } = await import('../../../src/multi-user/user-token-registry');

    const dir = await mkdtemp(join(tmpdir(), 'utr-'));
    const file = join(dir, 'registry.json');
    await writeFile(
      file,
      JSON.stringify({
        ou_a: { openId: 'ou_a', larkCliConfigDir: '/x/a', status: 'ready', readyAt: '2026-10-01T00:00:00Z' },
        ou_b: { openId: 'ou_b', larkCliConfigDir: '/x/b', status: 'pending' },
      }),
    );
    const reg = new UserTokenRegistry({ baseDir: dir, larkEnv: {}, registryFile: file });
    await reg.load();

    expect(reg.needsAuth('ou_a')).toBe(false);
    reg.markNeedsAuth('ou_a');
    expect(reg.needsAuth('ou_a')).toBe(true);
    expect(reg.getLarkCliConfigDir('ou_a')).toBeUndefined();

    // pending / unknown users are left alone
    reg.markNeedsAuth('ou_b');
    expect(reg.isPending('ou_b')).toBe(true);
    expect(() => reg.markNeedsAuth('ou_nobody')).not.toThrow();

    // Persistence is async (atomic write); poll instead of guessing a delay.
    type Saved = Record<string, { status: string; readyAt?: string }>;
    let saved: Saved = {};
    for (let i = 0; i < 100; i++) {
      saved = JSON.parse(await readFile(file, 'utf8')) as Saved;
      if (saved.ou_a?.status === 'none') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(saved.ou_a?.status).toBe('none');
    expect(saved.ou_a?.readyAt).toBeUndefined();
  });
});
