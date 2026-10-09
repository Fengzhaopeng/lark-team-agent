import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
  /**
   * open_id of the human who ran `/new chat`. When present they are set as the
   * group owner, so they can rename the group, invite colleagues and kick the
   * bot without asking us. Omit it (or pass `undefined`) to leave the bot as
   * the owner — the behaviour before ownership was configurable.
   */
  ownerOpenId?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

/** Shape of the `im.v1.chat.create` response we care about. */
interface CreateChatResponse {
  code?: number;
  msg?: string;
  data?: { chat_id?: string };
}

/**
 * Create a private group chat with the bot and one user, returning the new
 * chat_id. Requires `im:chat` scope on the bot.
 *
 * We call the raw node-sdk client instead of `channel.createChat` because the
 * channel wrapper only forwards `name` / `description` / `chat_mode` /
 * `chat_type` / `user_id_list`, and has no way to express `owner_id` — every
 * group it creates is owned by the bot. The invoker should own the group they
 * just asked for, so we pass `owner_id` and mirror the wrapper's defaults
 * exactly to avoid a silent behaviour change for callers that omit it.
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description, ownerOpenId } = opts;

  const res = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: {
      name,
      description,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [inviteOpenId],
      // Only set when we actually have a human owner; leaving it off keeps the
      // bot as owner, which is a deliberate fallback rather than a silent drop.
      ...(ownerOpenId ? { owner_id: ownerOpenId } : {}),
    },
  });

  const body = (res ?? {}) as CreateChatResponse;
  const chatId = body.data?.chat_id;
  if (!chatId) {
    // Business errors arrive as HTTP 200 with a non-zero `code`, so the raw
    // `msg` is the only place the real reason (bad owner_id, missing scope,
    // group limit reached) is spelled out. Surface it instead of a generic
    // "no chat_id" that sends the user hunting for `im:chat`.
    throw new Error(
      body.code
        ? `im.v1.chat.create failed: code=${body.code} msg=${body.msg ?? 'unknown'}`
        : 'im.v1.chat.create returned no chat_id',
    );
  }
  return { chatId, name };
}

export function defaultChatName(agentName = 'Agent'): string {
  const d = new Date();
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${agentName} · ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
