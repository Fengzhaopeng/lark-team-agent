import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { createBoundChat, defaultChatName } from '../../../src/bot/group.js';

/** Payload `createBoundChat` hands to `im.v1.chat.create`. */
interface CreatePayload {
  params: { user_id_type: string };
  data: {
    name?: string;
    description?: string;
    chat_mode?: string;
    chat_type?: string;
    user_id_list?: string[];
    owner_id?: string;
  };
}

/** Minimal stand-in for the one node-sdk method `createBoundChat` reaches for. */
function makeChannel(response: unknown): { channel: LarkChannel; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  const channel = { rawClient: { im: { v1: { chat: { create } } } } } as unknown as LarkChannel;
  return { channel, create };
}

/** Payload of the sole `chat.create` call — fails loudly if it never happened. */
function firstPayload(create: ReturnType<typeof vi.fn>): CreatePayload {
  const call = create.mock.calls[0];
  if (!call) throw new Error('im.v1.chat.create was never called');
  return call[0] as CreatePayload;
}

describe('group chat helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the current agent display name in generated chat names', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 25, 16, 52, 0));

    expect(defaultChatName('Codex')).toBe('Codex · 5-25 16:52');
  });
});

describe('createBoundChat', () => {
  it('makes the invoker the group owner and mirrors the channel wrapper defaults', async () => {
    const { channel, create } = makeChannel({ code: 0, data: { chat_id: 'oc_new' } });

    const created = await createBoundChat({
      channel,
      name: '项目群',
      inviteOpenId: 'ou_invoker',
      ownerOpenId: 'ou_invoker',
    });

    expect(created).toEqual({ chatId: 'oc_new', name: '项目群' });
    expect(create).toHaveBeenCalledTimes(1);
    const payload = firstPayload(create);
    expect(payload.params).toEqual({ user_id_type: 'open_id' });
    // chat_mode/chat_type must stay identical to channel.createChat's defaults,
    // otherwise every /new chat group silently changes shape.
    expect(payload.data).toMatchObject({
      name: '项目群',
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: ['ou_invoker'],
      owner_id: 'ou_invoker',
    });
  });

  it('passes description through when given', async () => {
    const { channel, create } = makeChannel({ code: 0, data: { chat_id: 'oc_new' } });

    await createBoundChat({
      channel,
      name: '项目群',
      description: '临时群',
      inviteOpenId: 'ou_invoker',
      ownerOpenId: 'ou_invoker',
    });

    expect(firstPayload(create).data.description).toBe('临时群');
  });

  it('omits owner_id when no owner is supplied, leaving the bot in charge', async () => {
    const { channel, create } = makeChannel({ code: 0, data: { chat_id: 'oc_new' } });

    await createBoundChat({ channel, name: 'bot owned', inviteOpenId: 'ou_invoker' });

    const { data } = firstPayload(create);
    expect('owner_id' in data).toBe(false);
    expect(data.user_id_list).toEqual(['ou_invoker']);
  });

  it('surfaces the API code and message instead of a generic failure', async () => {
    const { channel } = makeChannel({ code: 99991672, msg: 'owner_id is invalid' });

    await expect(
      createBoundChat({
        channel,
        name: '项目群',
        inviteOpenId: 'ou_invoker',
        ownerOpenId: 'ou_external',
      }),
    ).rejects.toThrow(/code=99991672.*owner_id is invalid/);
  });

  it('throws when the response carries no chat_id', async () => {
    const { channel } = makeChannel({ code: 0, data: {} });

    await expect(
      createBoundChat({ channel, name: '项目群', inviteOpenId: 'ou_invoker' }),
    ).rejects.toThrow(/returned no chat_id/);
  });

  it('propagates transport errors from the sdk', async () => {
    const create = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const channel = { rawClient: { im: { v1: { chat: { create } } } } } as unknown as LarkChannel;

    await expect(
      createBoundChat({ channel, name: '项目群', inviteOpenId: 'ou_invoker' }),
    ).rejects.toThrow('socket hang up');
  });
});
