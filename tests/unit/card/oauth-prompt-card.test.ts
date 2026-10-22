import { describe, expect, it } from 'vitest';
import {
  buildOAuthPromptCardJson,
  buildOAuthPromptMarkdown,
} from '../../../src/card/oauth-prompt-card';

const URL = 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234';

describe('oauth prompt card', () => {
  it('builds a schema 2.0 card with an open_url primary button', () => {
    const card = buildOAuthPromptCardJson({ verificationUrl: URL, expiresInMinutes: 10 }) as {
      schema: string;
      header: { title: { content: string }; template: string };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toContain('飞书授权');

    const button = card.body.elements.find((e) => e.tag === 'button') as {
      type: string;
      behaviors: Array<{ type: string; default_url: string }>;
    };
    expect(button).toBeTruthy();
    expect(button.type).toBe('primary');
    expect(button.behaviors).toEqual([{ type: 'open_url', default_url: URL }]);
  });

  it('never uses the legacy `action` container (rejected by schema 2.0)', () => {
    const json = JSON.stringify(buildOAuthPromptCardJson({ verificationUrl: URL }));
    expect(json).not.toContain('"tag":"action"');
  });

  it('shows the expiry note only when expiresInMinutes is given', () => {
    expect(JSON.stringify(buildOAuthPromptCardJson({ verificationUrl: URL, expiresInMinutes: 10 }))).toContain('10');
    expect(JSON.stringify(buildOAuthPromptCardJson({ verificationUrl: URL }))).not.toContain('分钟后失效');
  });

  it('keeps the markdown fallback with a clickable link', () => {
    expect(buildOAuthPromptMarkdown({ verificationUrl: URL })).toContain(`](${URL})`);
  });
});
