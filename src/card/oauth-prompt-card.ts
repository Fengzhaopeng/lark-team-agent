/**
 * OAuth authorization prompt.
 *
 * Primary form is a schema-2.0 interactive card: header + explanation + a
 * primary button that opens the verification URL (`behaviors: open_url`).
 * Note: the legacy `tag: action` container is rejected by schema 2.0
 * (ErrCode 200861) -- a bare `button` with `behaviors` is the supported shape.
 *
 * The plain-markdown variant is kept as a fallback for when the card send
 * fails (e.g. card schema drift), so the user always gets a usable link.
 */

export interface OAuthPromptCardOptions {
  verificationUrl: string;
  reason?: string;
  buttonText?: string;
  expiresInMinutes?: number;
}

const DEFAULT_REASON = '需要授权才能以你的身份操作飞书文档和其他资源。';
const DEFAULT_BUTTON_TEXT = '点此打开授权链接';

/** Returns a schema-2.0 card suitable for channel.send(to, { card }). */
export function buildOAuthPromptCardJson(opts: OAuthPromptCardOptions): object {
  const {
    verificationUrl,
    reason = DEFAULT_REASON,
    buttonText = '去授权',
    expiresInMinutes,
  } = opts;

  const steps = [
    '1. 点击下方按钮，在浏览器中确认授权',
    '2. 授权完成后，回到原对话重新发送消息',
  ].join('\n');
  const expireNote = expiresInMinutes
    ? `\n链接将在 **${String(expiresInMinutes)}** 分钟后失效。`
    : '';

  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: '需要飞书授权' } },
    header: {
      title: { tag: 'plain_text', content: '🔐 需要飞书授权' },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: reason },
        { tag: 'markdown', content: steps },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: buttonText },
          type: 'primary',
          behaviors: [{ type: 'open_url', default_url: verificationUrl }],
        },
        {
          tag: 'markdown',
          content: `<font color='grey'>仅用于让助手以你本人身份操作，不会共享给其他人。${expireNote}</font>`,
          text_size: 'notation',
        },
      ],
    },
  };
}

/** Returns a markdown string suitable for channel.send(to, { markdown: ... }). */
export function buildOAuthPromptMarkdown(opts: OAuthPromptCardOptions): string {
  const {
    verificationUrl,
    reason = DEFAULT_REASON,
    buttonText = DEFAULT_BUTTON_TEXT,
    expiresInMinutes,
  } = opts;

  const expireNote = expiresInMinutes
    ? '\n链接将在 **' + String(expiresInMinutes) + '** 分钟后失效。'
    : '';

  return [
    '🔐 **需要飞书授权**',
    '',
    reason,
    '',
    '[' + buttonText + '](' + verificationUrl + ')',
    '',
    '授权完成后，请返回原对话重新发送消息，即可继续。' + expireNote,
  ].join('\n');
}

/** @deprecated Use buildOAuthPromptCardJson (card) or buildOAuthPromptMarkdown (fallback). */
export const buildOAuthPromptCard = buildOAuthPromptMarkdown;
