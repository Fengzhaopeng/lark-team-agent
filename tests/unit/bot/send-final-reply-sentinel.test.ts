import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../../src/card/run-state.js';
import * as channelModule from '../../../src/bot/channel.js';
import { NEED_USER_AUTH_SENTINEL } from '../../../src/agent/bridge-system-prompt.js';

/**
 * `sendFinalReply` is not part of the module's public API surface for normal
 * callers — it's exported solely so this test can drive it directly instead
 * of standing up a full `startChannel()` harness (which would either need a
 * real `lark-cli` subprocess or brand-new `child_process` mocking
 * infrastructure just for this one behavior).
 */
const sendFinalReply = (
  channelModule as unknown as {
    sendFinalReply: (input: {
      channel: {
        send: (chatId: string, content: unknown, options?: unknown) => Promise<{ messageId: string }>;
      };
      chatId: string;
      scope: string;
      state: RunState;
      replyMode: 'card' | 'markdown' | 'text';
      sendOpts: { replyTo: string; replyInThread?: boolean };
      cardRenderOptions: Record<string, unknown>;
      userAuthTrigger?: {
        userTokenRegistry: {
          isPending: (senderId: string) => boolean;
          startAuth: (
            senderId: string,
            opts: { appId: string; brand?: string; scope?: string; extraArgs?: string[] },
          ) => Promise<{ verificationUrl: string; expiresIn?: number }>;
        };
        senderId: string;
        appId: string;
        appBrand?: string;
      };
    }) => Promise<void>;
  }
).sendFinalReply;

function finalTextState(text: string): RunState {
  return {
    blocks: [{ kind: 'text', content: text, streaming: false }],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
  };
}

function makeChannel() {
  const sent: Array<{ chatId: string; content: unknown; options?: unknown }> = [];
  return {
    sent,
    async send(chatId: string, content: unknown, options?: unknown) {
      sent.push({ chatId, content, options });
      return { messageId: `sent_${sent.length}` };
    },
  };
}

describe('sendFinalReply on-demand auth sentinel', () => {
  it('suppresses the sentinel, DMs an auth link, and posts a group notice', async () => {
    const channel = makeChannel();
    const startAuth = vi.fn(async () => ({
      verificationUrl: 'https://example.com/verify',
      expiresIn: 600,
    }));
    const isPending = vi.fn(() => false);

    await sendFinalReply({
      channel,
      chatId: 'oc_group',
      scope: 'oc_group',
      state: finalTextState(NEED_USER_AUTH_SENTINEL),
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_1' },
      cardRenderOptions: {},
      userAuthTrigger: {
        userTokenRegistry: { isPending, startAuth },
        senderId: 'ou_sender',
        appId: 'cli_test',
        appBrand: 'feishu',
      },
    });

    expect(startAuth).toHaveBeenCalledWith('ou_sender', {
      appId: 'cli_test',
      brand: 'feishu',
      extraArgs: ['--recommend'],
    });
    // Private DM with the verification link.
    expect(channel.sent).toContainEqual(
      expect.objectContaining({ chatId: 'ou_sender' }),
    );
    // Group notice, no leak of the raw sentinel text anywhere.
    const groupNotice = channel.sent.find((s) => s.chatId === 'oc_group');
    expect(groupNotice).toBeDefined();
    const groupMarkdown = (groupNotice?.content as { markdown?: string }).markdown ?? '';
    expect(groupMarkdown).toContain('授权');
    for (const s of channel.sent) {
      const markdown = (s.content as { markdown?: string }).markdown ?? '';
      expect(markdown).not.toContain(NEED_USER_AUTH_SENTINEL);
    }
  });

  it('reminds the sender instead of restarting auth when already pending', async () => {
    const channel = makeChannel();
    const startAuth = vi.fn();
    const isPending = vi.fn(() => true);

    await sendFinalReply({
      channel,
      chatId: 'oc_group',
      scope: 'oc_group',
      state: finalTextState(NEED_USER_AUTH_SENTINEL),
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_1' },
      cardRenderOptions: {},
      userAuthTrigger: {
        userTokenRegistry: { isPending, startAuth },
        senderId: 'ou_sender',
        appId: 'cli_test',
      },
    });

    expect(startAuth).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.chatId).toBe('ou_sender');
  });

  it('delivers the reply normally when there is no auth trigger (p2p call sites)', async () => {
    const channel = makeChannel();

    await sendFinalReply({
      channel,
      chatId: 'oc_dm',
      scope: 'oc_dm',
      state: finalTextState('a normal reply'),
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_1' },
      cardRenderOptions: {},
    });

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.chatId).toBe('oc_dm');
    expect((channel.sent[0]?.content as { markdown?: string }).markdown).toBe('a normal reply');
  });

  it('delivers a reply that merely mentions the sentinel word without being an exact match', async () => {
    const channel = makeChannel();
    const startAuth = vi.fn();

    await sendFinalReply({
      channel,
      chatId: 'oc_group',
      scope: 'oc_group',
      state: finalTextState(`explaining ${NEED_USER_AUTH_SENTINEL} in prose`),
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_1' },
      cardRenderOptions: {},
      userAuthTrigger: {
        userTokenRegistry: { isPending: () => false, startAuth },
        senderId: 'ou_sender',
        appId: 'cli_test',
      },
    });

    expect(startAuth).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.chatId).toBe('oc_group');
  });
});
