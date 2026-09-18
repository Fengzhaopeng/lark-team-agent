import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import { DEFAULT_MODEL, normalizeModelSelection, supportedModels } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { helpCard, resumeCard, statusCard, workspacesCard } from '../card/templates';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getChatRequireMention,
  getCotMessages,
  getImageDefaultModel,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getModel,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  getVideoDefaultModel,
  secretKeyForApp,
} from '../config/schema';
import type {
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
} from '../config/profile-schema';
import { effectiveLarkCliIdentity } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { accessToClaudePermissionMode } from '../config/permissions';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../session/history';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { applyLarkCliIdentityPolicy, hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';
import { fetchModels, filterByCapability, filterChatModels, formatFetchModelsError, groupModels } from '../anthropic/models';
import { loadCapabilityCache, probeAllModels, saveCapabilityCache, type CapabilityCache } from '../anthropic/model-probe';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p it equals `msg.senderId` (multi-user mode)
   * or `msg.chatId` (original mode); for regular groups it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}`.
   * All handlers should read/write session / workspace / activeRuns through
   * this — never through `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex';
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/model': handleModel,
  '/image': handleMediaGen,
  '/video': handleMediaGen,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/@bot': handleAtBot,
  '/quota': handleQuota,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  '/@bot',
  '/quota',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (
    isAdminCommand(cmd) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (
    isAdminCommand(name) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

/** Path to the model capability probe cache for a given profile. */
function capabilityCachePath(configPath: string, profile: string): string {
  return join(dirname(configPath), 'profiles', profile, 'model-capabilities.json');
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Default the new group to the invoker's personal workspace. In multi-user
  // mode `cwdFor(senderId)` is the personal dir (`/workspace/<pinyin>`), which
  // is what the user expects a fresh chat to start in. Previously the source
  // chat's cwd won outright, so running `/new chat` from a group bound to
  // `/workspace/shared` (or someone else's dir) produced a new group parked in
  // the wrong place.
  //
  // Exception: when the source chat already sits inside the invoker's own
  // workspace (e.g. `.../projects/<x>`), keep that subdir — this preserves the
  // "spin up a group for this project" flow. Falls back to the source cwd when
  // no personal workspace is recorded (non multi-user mode, or a user who has
  // only ever spoken in groups).
  const personalCwd = ctx.workspaces.cwdFor(ctx.msg.senderId);
  const inheritCwd =
    personalCwd && sourceCwd && isWithinDirectory(sourceCwd, personalCwd)
      ? sourceCwd
      : (personalCwd ?? sourceCwd);
  if (inheritCwd) {
    ctx.workspaces.setCwd(created.chatId, inheritCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = inheritCwd
    ? `🎉 群已建好，工作目录：\`${inheritCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    const identity = ctx.sessionCatalogIdentity;
    const entry =
      ctx.sessionCatalog && identity
        ? ctx.sessionCatalog.activeFor(identity)
        : undefined;
    const history = identity ? await listCodexResumeHistory(ctx, cwd, limit) : [];
    if (history.length > 0 && identity) {
      const entries = history.map((thread) => {
        const nonce = issueResumeCandidate(identity, { threadId: thread.threadId });
        return {
          sessionId: nonce,
          preview: thread.name || thread.preview,
          relTime: formatRelTime(thread.updatedAtMs),
          detail: `Codex · ${thread.source}`,
          current: thread.threadId === entry?.threadId,
        };
      });
      const card = resumeCard(cwd, entries);
      await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
      return;
    }
    if (entry?.threadId && identity) {
      const nonce = issueResumeCandidate(identity, { threadId: entry.threadId });
      await reply(
        ctx,
        `当前 Codex thread 可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
      );
      return;
    }
    const card = resumeCard(cwd, []);
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }

  const sessions = await listClaudeResumeHistory(ctx, cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      ctx.activeRuns.interrupt(ctx.scope);
      if (ctx.sessionCatalogIdentity.agentId === 'codex') {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'codex',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          threadId: resolved.threadId!,
        });
      } else {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'claude',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId!,
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId!, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    if (ctx.sessionCatalogIdentity.agentId === 'codex') {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalogIdentity.agentId === 'claude') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    await reply(ctx, '当前上下文没有可恢复的 Codex thread，请先在当前工作区完成一次运行。');
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    (identity.agentId === 'claude' && !candidate.sessionId) ||
    (identity.agentId === 'codex' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

/**
 * True when `child` is `parent` itself or nested under it. Uses path math
 * rather than string prefixes so `/workspace/u2` is not treated as being
 * inside `/workspace/u`.
 */
function isWithinDirectory(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  if (profileConfig.agentKind === 'claude') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: 'sandbox',
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = ctx.controls.profileConfig.agentKind === 'codex';
  const catalogEntry =
    isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isCodex ? '(未建立)' : undefined,
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const scope = targetScope || ctx.scope;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function handleModel(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();

  // /model scan — probe all models and cache capabilities
  if (input === 'scan') {
    const cachePath = capabilityCachePath(ctx.controls.configPath, ctx.controls.profile);
    await reply(ctx, '🔍 正在探测所有模型的实际能力，预计 2-5 分钟…\n（chat 探测快，图像/视频需要实际生成，单模型最长 90s）');
    const listResult = await fetchModels();
    if (!listResult.ok) {
      await reply(ctx, `❌ 获取模型列表失败：${formatFetchModelsError(listResult.error)}`);
      return;
    }
    const allIds = listResult.models.map((m) => m.id);
    let done = 0;
    const records = await probeAllModels(allIds, {
      onProgress: (_done, total, _id) => { done = _done; void total; },
    });
    await saveCapabilityCache(cachePath, records);
    const chat = records.filter((r) => r.capabilities.includes('chat')).length;
    const img = records.filter((r) => r.capabilities.includes('image-gen')).length;
    const vid = records.filter((r) => r.capabilities.includes('video-gen')).length;
    const none = records.filter((r) => r.capabilities.length === 0).length;
    await reply(
      ctx,
      [
        `✅ 探测完成（共 ${records.length} 个模型，各项能力可重叠）`,
        `- 💬 对话（chat）：${chat} 个`,
        `- 🎨 图像生成（/image）：${img} 个`,
        `- 🎬 视频生成（/video）：${vid} 个`,
        ...(none > 0 ? [`- ❓ 三项均不支持：${none} 个`] : []),
        '',
        '用 `/model list` 查看对话模型，`/image` 或 `/video` 直接生成媒体。',
      ].join('\n'),
    );
    return;
  }

  if (input === 'list') {
    await reply(ctx, '正在查询可用模型…');
    const result = await fetchModels();
    if (!result.ok) {
      await reply(ctx, `❌ 查询失败：${formatFetchModelsError(result.error)}`);
      return;
    }
    const scopeModel = ctx.sessions.getScopeModel(ctx.scope);
    const globalModel = getModel(ctx.controls.cfg);
    const current = scopeModel ?? globalModel;
    const cachePath = capabilityCachePath(ctx.controls.configPath, ctx.controls.profile);
    const probeCache = await loadCapabilityCache(cachePath);

    const cacheNote = probeCache
      ? `扫描于 ${probeCache.probedAt.slice(0, 10)}`
      : '未探测 — 运行 `/model scan` 可获精准分类';

    const lines: string[] = [`**模型列表**（${cacheNote}）\n`];

    // ── 对话模型 ─────────────────────────────────────────
    const chatModels = filterChatModels(result.models, probeCache);
    const chatGroups = groupModels(chatModels);
    lines.push(`**💬 对话模型**（${chatModels.length} 个，可用于 \`/model\` 切换）`);
    for (const group of chatGroups) {
      lines.push(`\n_${group.label}_`);
      for (const m of group.models) {
        lines.push(m.id === current ? `- \`${m.id}\` ← 当前` : `- \`${m.id}\``);
      }
    }
    lines.push('');

    if (probeCache) {
      // ── 生图模型 ───────────────────────────────────────
      const imgModels = filterByCapability(result.models, 'image-gen', probeCache);
      if (imgModels.length > 0) {
        lines.push(`**🎨 生图模型**（${imgModels.length} 个，用 \`/image\` 调用）`);
        for (const m of groupModels(imgModels)) {
          lines.push(`\n_${m.label}_`);
          m.models.forEach((x) => lines.push(`- \`${x.id}\``));
        }
        lines.push('');
      }

      // ── 生视频模型 ────────────────────────────────────
      const vidModels = filterByCapability(result.models, 'video-gen', probeCache);
      if (vidModels.length > 0) {
        lines.push(`**🎬 生视频模型**（${vidModels.length} 个，用 \`/video\` 调用）`);
        for (const m of groupModels(vidModels)) {
          lines.push(`\n_${m.label}_`);
          m.models.forEach((x) => lines.push(`- \`${x.id}\``));
        }
        lines.push('');
      }
    }

    lines.push('用 `/model <模型名>` 切换对话模型，`/model --global <模型名>` 改全局默认。');
    await reply(ctx, lines.join('\n'));
    return;
  }

  // --global flag: write to profile preferences (affects all scopes without override)
  const globalFlag = input.startsWith('--global ');
  const effectiveInput = globalFlag ? input.slice('--global '.length).trim() : input;

  if (!effectiveInput) {
    const scopeModel = ctx.sessions.getScopeModel(ctx.scope);
    const globalModel = getModel(ctx.controls.cfg);
    const parts: string[] = [];
    if (scopeModel) {
      parts.push(`当前会话模型：\`${scopeModel}\`（已覆盖全局）`);
    } else if (globalModel) {
      parts.push(`当前模型：\`${globalModel}\`（全局默认）`);
    } else {
      parts.push('当前使用默认模型（由 `ANTHROPIC_MODEL` 环境变量决定）');
    }
    parts.push('\n用法：');
    parts.push('- `/model <模型名>` — 仅本会话切换');
    parts.push('- `/model reset` — 清除本会话覆盖，恢复全局');
    parts.push('- `/model --global <模型名>` — 修改全局默认');
    parts.push('- `/model list` — 查看可用模型');
    await reply(ctx, parts.join('\n'));
    return;
  }

  const isReset = effectiveInput === 'reset' || effectiveInput === 'default';

  if (globalFlag) {
    // Write to global preferences
    const newModel = isReset ? undefined : effectiveInput;
    await withConfigFileLock(ctx.controls.configPath, async () => {
      const root = await loadRootConfig(ctx.controls.configPath);
      if (!root) {
        ctx.controls.cfg.preferences = { ...(ctx.controls.cfg.preferences ?? {}), model: newModel };
        await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
        return;
      }
      const profile = root.profiles[ctx.controls.profile];
      if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
      root.profiles[ctx.controls.profile] = {
        ...profile,
        preferences: { ...(profile.preferences ?? {}), model: newModel },
      };
      await saveRootConfig(root, ctx.controls.configPath);
    });
    ctx.controls.cfg.preferences = { ...(ctx.controls.cfg.preferences ?? {}), model: newModel };
    ctx.controls.profileConfig = {
      ...ctx.controls.profileConfig,
      preferences: { ...ctx.controls.profileConfig.preferences, model: newModel },
    };
    await reply(
      ctx,
      newModel
        ? `✓ 全局默认模型已设为 \`${newModel}\`，对无覆盖的会话立即生效。`
        : '✓ 已清除全局模型设置，恢复环境变量默认。',
    );
    return;
  }

  // Per-scope model change
  if (isReset) {
    const removed = ctx.sessions.clearScopeModel(ctx.scope);
    const fallback = getModel(ctx.controls.cfg);
    await reply(
      ctx,
      removed
        ? `✓ 已清除本会话模型覆盖，恢复为${fallback ? `全局默认 \`${fallback}\`` : '环境变量默认'}。`
        : `本会话未设置模型覆盖（当前使用${fallback ? `全局默认 \`${fallback}\`` : '环境变量默认'}）。`,
    );
    return;
  }

  ctx.sessions.setScopeModel(ctx.scope, effectiveInput);
  await reply(ctx, `✓ 本会话模型已切换为 \`${effectiveInput}\`，下次对话立即生效。`);
}

// ── Media generation (/image, /video) ──────────────────────────────────────

async function handleMediaGen(args: string, ctx: CommandContext): Promise<void> {
  const cmdName = ctx.msg.content.trim().split(/\s+/)[0] ?? '';
  const capability = cmdName === '/video' ? 'video-gen' : 'image-gen';
  const input = args.trim();

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const baseUrl = (process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');

  if (!apiKey) {
    await reply(ctx, '❌ ANTHROPIC_API_KEY 未设置，无法调用媒体生成 API。');
    return;
  }

  const cachePath = capabilityCachePath(ctx.controls.configPath, ctx.controls.profile);
  const probeCache = await loadCapabilityCache(cachePath);

  if (!input || input === 'help') {
    const label = capability === 'video-gen' ? '视频生成' : '图像生成';
    const cmd = capability === 'video-gen' ? '/video' : '/image';
    const lines = [
      `**${label}** \`${cmd} <描述> [--model <模型ID>] [--size <尺寸>]\``,
      '',
    ];
    if (probeCache) {
      const available = probeCache.models
        .filter((m) => m.capabilities.includes(capability))
        .map((m) => `- \`${m.modelId}\``);
      if (available.length > 0) {
        lines.push('可用模型（来自 `/model scan` 缓存）：', ...available);
      } else {
        lines.push('_暂无可用模型，请先执行 `/model scan` 重新探测。_');
      }
    } else {
      lines.push('_尚未探测模型能力，请先执行 `/model scan`。_');
    }
    await reply(ctx, lines.join('\n'));
    return;
  }

  if (!probeCache) {
    await reply(
      ctx,
      `❌ 尚未探测模型能力。请先执行 \`/model scan\` 获取可用的${capability === 'video-gen' ? '视频' : '图像'}生成模型列表。`,
    );
    return;
  }

  const availableIds = probeCache.models
    .filter((m) => m.capabilities.includes(capability))
    .map((m) => m.modelId);

  if (availableIds.length === 0) {
    await reply(
      ctx,
      `❌ 没有可用的${capability === 'video-gen' ? '视频' : '图像'}生成模型。请重新执行 \`/model scan\`。`,
    );
    return;
  }

  // Parse --model flag. Two supported forms:
  //   --model <id>    explicit flag name (canonical)
  //   --<id>          shorthand when the id contains dashes (e.g. --doubao-xxx-2-0)
  let prompt = input;
  const configDefaultModel =
    capability === 'image-gen'
      ? getImageDefaultModel(ctx.controls.cfg)
      : getVideoDefaultModel(ctx.controls.cfg);
  // Use config-set default if valid, otherwise fall back to first available
  const effectiveDefault =
    configDefaultModel && availableIds.includes(configDefaultModel)
      ? configDefaultModel
      : availableIds[0]!;
  let modelId = effectiveDefault;

  // Try --model <id> first
  const modelMatch = prompt.match(/\s+--model\s+(\S+)/);
  if (modelMatch) {
    const requested = modelMatch[1]!;
    if (!availableIds.includes(requested)) {
      await reply(
        ctx,
        `❌ 模型 \`${requested}\` 不支持${capability === 'video-gen' ? '视频' : '图像'}生成，或不在探测缓存中。` +
          `\n可用模型：${availableIds.map((id) => `\`${id}\``).join(', ')}`,
      );
      return;
    }
    modelId = requested;
    prompt = prompt.replace(modelMatch[0], '').trim();
  } else {
    // Try --<modelId> shorthand: match any --word that contains a dash
    // and exactly matches one of the available model IDs
    const shortMatch = prompt.match(/\s+--([\w][\w.-]+)/);
    if (shortMatch) {
      const candidate = shortMatch[1]!;
      if (availableIds.includes(candidate)) {
        modelId = candidate;
        prompt = prompt.replace(shortMatch[0], '').trim();
      }
      // If not in available list, leave as unrecognised flag — will be part of prompt
    }
  }

  // Parse --size flag
  let size: string | undefined;
  const sizeMatch = prompt.match(/\s+--size\s+(\S+)/);
  if (sizeMatch) {
    size = sizeMatch[1];
    prompt = prompt.replace(sizeMatch[0], '').trim();
  }

  if (!prompt) {
    await reply(ctx, '❌ 请提供描述文字。');
    return;
  }

  if (capability === 'image-gen') {
    await handleImageGen(prompt, modelId, size, apiKey, baseUrl, ctx);
  } else {
    await handleVideoGen(prompt, modelId, size, apiKey, baseUrl, ctx);
  }
}

async function handleImageGen(
  prompt: string,
  modelId: string,
  size: string | undefined,
  apiKey: string,
  baseUrl: string,
  ctx: CommandContext,
): Promise<void> {
  await reply(ctx, `🎨 正在生成图像，模型 \`${modelId}\`…`);

  const body: Record<string, unknown> = { model: modelId, prompt, n: 1 };
  if (size) body['size'] = size;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      res = await fetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    await reply(ctx, `❌ 请求失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let data: unknown;
  try { data = await res.json(); } catch {
    await reply(ctx, `❌ API 返回非 JSON（HTTP ${res.status}）`);
    return;
  }

  if (!res.ok) {
    const errMsg = ((data as Record<string, unknown>)?.['error'] as Record<string, unknown> | undefined)?.['message'];
    await reply(ctx, `❌ API 错误 ${res.status}：${errMsg ?? JSON.stringify(data).slice(0, 200)}`);
    return;
  }

  const imageData = ((data as Record<string, unknown>)?.['data'] as Record<string, unknown>[])?.[0];
  if (!imageData) {
    await reply(ctx, '❌ API 返回了空结果。');
    return;
  }

  try {
    if (typeof imageData['b64_json'] === 'string') {
      const imgBuffer = Buffer.from(imageData['b64_json'], 'base64');
      await ctx.channel.send(ctx.msg.chatId, { image: { source: imgBuffer } }, commandReplyOptions(ctx));
    } else if (typeof imageData['url'] === 'string') {
      await ctx.channel.send(ctx.msg.chatId, { image: { source: imageData['url'] } }, commandReplyOptions(ctx));
    } else {
      await reply(ctx, `❌ 未识别的响应格式：${JSON.stringify(imageData).slice(0, 200)}`);
    }
  } catch (err) {
    await reply(ctx, `❌ 发送图片失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleVideoGen(
  prompt: string,
  modelId: string,
  size: string | undefined,
  apiKey: string,
  baseUrl: string,
  ctx: CommandContext,
): Promise<void> {
  // Parse optional duration from prompt: "...5秒" or "...5s" or "...5 seconds"
  let duration = 10;
  const durationMatch = prompt.match(/(\d+)\s*(?:秒|s(?:ec(?:ond)?s?)?)\b/i);
  if (durationMatch) {
    const d = parseInt(durationMatch[1]!, 10);
    if (d >= 1 && d <= 30) duration = d;
    prompt = prompt.replace(durationMatch[0], '').trim();
  }

  await reply(ctx, `🎬 正在提交视频生成任务，模型 \`${modelId}\`，时长 ${duration} 秒…`);

  const body: Record<string, unknown> = { model: modelId, prompt, duration };
  if (size) body['size'] = size;

  let submitRes: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      submitRes = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    await reply(ctx, `❌ 提交失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let submitData: unknown;
  try { submitData = await submitRes.json(); } catch {
    await reply(ctx, `❌ API 返回非 JSON（HTTP ${submitRes.status}）`);
    return;
  }

  if (!submitRes.ok) {
    const errMsg = ((submitData as Record<string, unknown>)?.['error'] as Record<string, unknown> | undefined)?.['message'];
    await reply(ctx, `❌ API 错误 ${submitRes.status}：${errMsg ?? JSON.stringify(submitData).slice(0, 200)}`);
    return;
  }

  const taskId = (submitData as Record<string, unknown>)?.['task_id'] as string | undefined
    ?? (submitData as Record<string, unknown>)?.['id'] as string | undefined;

  if (!taskId) {
    await reply(ctx, `❌ 未获取到任务 ID，原始响应：${JSON.stringify(submitData).slice(0, 200)}`);
    return;
  }

  await reply(ctx, `⏳ 任务已提交（ID: \`${taskId}\`），正在等待生成完成…`);

  // Poll until complete (max 8 minutes, every 8s — video generation typically takes 3-5 min)
  const pollDeadline = Date.now() + 8 * 60 * 1000;
  let videoUrl: string | undefined;

  while (Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 8_000));

    let pollRes: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        pollRes = await fetch(`${baseUrl}/v1/video/generations/${taskId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      continue;
    }

    let pollData: unknown;
    try { pollData = await pollRes.json(); } catch { continue; }

    const d = pollData as Record<string, unknown>;
    // Support both flat response and nested { code: "success", data: {...} } envelope
    const inner = (d['code'] === 'success' || d['code'] !== undefined)
      ? (d['data'] as Record<string, unknown> | undefined ?? d)
      : d;

    const status = String(
      inner['status'] ??
      (inner['data'] as Record<string, unknown> | undefined)?.['status'] ??
      '',
    ).toUpperCase();

    if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'COMPLETED') {
      // Probe multiple known URL paths from the API response
      videoUrl =
        (inner['result_url'] as string | undefined) ??
        (inner['video_url'] as string | undefined) ??
        ((inner['data'] as Record<string, unknown> | undefined)?.['content'] as Record<string, unknown> | undefined)?.['video_url'] as string | undefined ??
        ((inner['data'] as Record<string, unknown> | undefined)?.['video_url'] as string | undefined);
      break;
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'FAILURE') {
      const reason =
        (inner['fail_reason'] as string | undefined) ??
        (inner['error'] as Record<string, unknown> | undefined)?.['message'] ??
        inner['message'] ??
        '未知原因';
      await reply(ctx, `❌ 视频生成失败：${reason}`);
      return;
    }
  }

  if (!videoUrl) {
    await reply(ctx, '❌ 视频生成超时（8 分钟），请稍后重试。');
    return;
  }

  // Download the video and send it as a real video message via lark-cli.
  // Lark requires a cover image alongside the video, so we generate a
  // minimal 1x1 JPEG cover before uploading.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { mkdtempSync: mktmp, writeFileSync: wfs, rmSync: rms } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');

  const tmpDir = mktmp(`${td()}/lark-video-`);
  const videoPath = `${tmpDir}/video.mp4`;
  const coverPath = `${tmpDir}/cover.jpg`;

  try {
    // Download video
    const videoResp = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
    if (!videoResp.ok) throw new Error(`download failed: ${videoResp.status}`);
    const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
    wfs(videoPath, videoBuffer);

    // Generate minimal JPEG cover (1x1 gray pixel, FFD8...FFD9 baseline JPEG)
    const minimalJpeg = Buffer.from(
      'FFD8FFE000104A46494600010100000100010000FFDB004300080606070605080707070909080A0C' +
      '140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F' +
      '27393D38323C2E333432FFDB0043010909090C0B0C180D0D1832211C213232323232323232323232' +
      '32323232323232323232323232323232323232323232323232323232323232323232323232FFC00011' +
      '080001000103012200021101031101FFC4001F0000010501010101010100000000000000000102030405' +
      '060708090A0BFFC400B5100002010303020403050504040000017D01020300041105122131410613516' +
      '1072232718114912A081B1A1C109233352F0156272D10A162434E125F11718191A262728292A353637' +
      '38393A434445464748494A535455565758595A636465666768696A737475767778797A838485868788' +
      '898A929394959697989990A0A2A3A4A5A6A7A8A9AAB2B3B4B5B6B7B8B9BAC2C3C4C5C6C7C8C9CAD2' +
      'D3D4D5D6D7D8D9DAE1E2E3E4E5E6E7E8E9EAF1F2F3F4F5F6F7F8F9FAFFC4001F0100030101010101' +
      '01010101000000000000010203040506070809000BFFC400B511000201020404030407050404000102' +
      '7700010203110405213106124151076171132232810814422191A1B1C109233352F0156272D10A162' +
      '434E125F11718191A262728292A353637383A434445464748494A535455565758595A63646566676869' +
      '6A737475767778797A82838485868788898A929394959697989990A0A2A3A4A5A6A7A8A9AAB2B3B4' +
      'B5B6B7B8B9BAC2C3C4C5C6C7C8C9CAD2D3D4D5D6D7D8D9DAE2E3E4E5E6E7E8E9EAF2F3F4F5F6F7' +
      'F8F9FAFFDA000C03010002110311003F009FE52B28A2803FFFD9',
      'hex',
    );
    wfs(coverPath, minimalJpeg);

    // Send via lark-cli
    const result = await execFileAsync(
      'lark-cli',
      [
        'im', '+messages-send', '--as', 'bot',
        '--chat-id', ctx.msg.chatId,
        '--video', `./video.mp4`,
        '--video-cover', `./cover.jpg`,
        '--json',
      ],
      { cwd: tmpDir, env: { ...process.env, LARK_CHANNEL: '' }, timeout: 60_000 },
    );
    const sent = JSON.parse(result.stdout) as { ok?: boolean; error?: { message?: string } };
    if (!sent.ok) {
      throw new Error(sent.error?.message ?? 'lark-cli send failed');
    }
  } catch (err) {
    // Fallback: reply with URL if upload fails
    await reply(ctx, `✅ 视频已生成，直接链接（发送失败时备用）：${videoUrl}\n\n原因：${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    try { rms(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在停止当前运行并重连…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability =
    ctx.controls.profileConfig.agentKind === 'codex'
      ? codexCapability(ctx.controls.profileConfig)
      : claudeCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '`/remove group` 请在要移除的群里发，私聊里没有可移除的群。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  try {
    return await withConfigFileLock(ctx.controls.configPath, async () => {
      const root = await loadRootConfig(ctx.controls.configPath);
      if (!root) {
        const access = mutate(ctx.controls.profileConfig.access);
        ctx.controls.profileConfig = {
          ...ctx.controls.profileConfig,
          access,
        };
        ctx.controls.cfg.preferences = {
          ...(ctx.controls.cfg.preferences ?? {}),
          access: {
            allowedUsers: access.allowedUsers,
            allowedChats: access.allowedChats,
            admins: access.admins,
          },
          requireMentionInGroup: access.requireMentionInGroup,
        };
        await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
        return access;
      }

      const profile = root.profiles[ctx.controls.profile];
      if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
      const access = mutate(profile.access);
      root.profiles[ctx.controls.profile] = {
        ...profile,
        access,
      };
      await saveRootConfig(root, ctx.controls.configPath);
      ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
      ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
      log.info('command', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
      });
      return access;
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'access.save' });
    throw err;
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;

  // Load capability cache for image/video model pickers
  const cachePath = capabilityCachePath(ctx.controls.configPath, ctx.controls.profile);
  const probeCache = await loadCapabilityCache(cachePath);

  const AUTO_OPTION = 'auto';

  const imageModels = probeCache
    ? probeCache.models
        .filter((m) => m.capabilities.includes('image-gen'))
        .map((m) => ({ value: m.modelId, label: m.modelId }))
    : [];

  const videoModels = probeCache
    ? probeCache.models
        .filter((m) => m.capabilities.includes('video-gen'))
        .map((m) => ({ value: m.modelId, label: m.modelId }))
    : [];

  const savedImageModel = getImageDefaultModel(ctx.controls.cfg);
  const imageDefaultModel =
    savedImageModel && imageModels.some((m) => m.value === savedImageModel)
      ? savedImageModel
      : AUTO_OPTION;

  const savedVideoModel = getVideoDefaultModel(ctx.controls.cfg);
  const videoDefaultModel =
    savedVideoModel && videoModels.some((m) => m.value === savedVideoModel)
      ? savedVideoModel
      : AUTO_OPTION;

  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    mode: ctx.controls.profileConfig.mode,
    model: normalizeModelSelection(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.cfg.preferences?.model,
    ),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    imageModels,
    imageDefaultModel,
    videoModels,
    videoDefaultModel,
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelValid = rawModel !== '' && supportedModels(agentKind).some((m) => m.value === rawModel);
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  // Parse deployment mode. Empty / unexpected keeps current.
  const rawMode = String(fv.deploy_mode ?? '').trim();
  const mode: ProfileMode =
    rawMode === 'team' || rawMode === 'personal'
      ? rawMode
      : ctx.controls.profileConfig.mode;
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  // Effective preset = what actually gets applied to lark-cli. Team mode forces
  // bot-only regardless of the stored identity select; the select value is still
  // saved verbatim so it comes back when switching to personal mode. Re-apply
  // the lark-cli policy whenever the *effective* preset changes (covers both a
  // direct identity-select change and a personal↔team flip).
  const nextEffectiveIdentity: LarkCliIdentityPreset =
    mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(ctx.controls.profileConfig);
  const larkCliIdentityChanged = nextEffectiveIdentity !== previousEffectiveIdentity;

  // Parse image/video default model. 'auto' / empty / unexpected → undefined (auto-select).
  const rawImageModel = String(fv.image_default_model ?? '').trim();
  const imageDefaultModel = rawImageModel && rawImageModel !== 'auto' ? rawImageModel : undefined;
  const rawVideoModel = String(fv.video_default_model ?? '').trim();
  const videoDefaultModel = rawVideoModel && rawVideoModel !== 'auto' ? rawVideoModel : undefined;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      imageDefaultModel,
      videoDefaultModel,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, nextEffectiveIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity, mode);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousEffectiveIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousEffectiveIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      mode,
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        mode,
        model: modelSelection,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
        imageModels: [],
        imageDefaultModel: imageDefaultModel ?? 'auto',
        videoModels: [],
        videoDefaultModel: videoDefaultModel ?? 'auto',
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = commandProfilePaths(ctx);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: ctx.controls.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('command', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = commandProfilePaths(ctx);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(ctx.controls.configPath);
  if (!root) {
    await saveConfig(newCfg, ctx.controls.configPath);
    ctx.controls.cfg = newCfg;
    return;
  }

  const profile = root.profiles[ctx.controls.profile];
  if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
  root.profiles[ctx.controls.profile] = {
    ...profile,
    accounts: newCfg.accounts,
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, ctx.controls.configPath);
  ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
  ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
): Promise<void> {
  // Store the user's identity selection verbatim (not the team-mode-forced
  // effective preset) so it comes back into effect when switching to personal.
  const larkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  await withConfigFileLock(ctx.controls.configPath, async () => {
    const root = await loadRootConfig(ctx.controls.configPath);
    if (!root) {
      ctx.controls.cfg.preferences = preferences;
      ctx.controls.profileConfig.larkCli = larkCli;
      ctx.controls.profileConfig.mode = mode;
      await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
      return;
    }

    const profile = root.profiles[ctx.controls.profile];
    if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    root.profiles[ctx.controls.profile] = {
      ...profile,
      mode,
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      larkCli,
    };
    await saveRootConfig(root, ctx.controls.configPath);
    ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
    ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
  });
}

/**
 * /@bot on|off|status — per-chat override for the @-mention requirement.
 *
 * - `/@bot on`     require @-mention in this chat (override global)
 * - `/@bot off`    respond without @-mention in this chat (override global)
 * - `/@bot reset`  remove override, revert to global setting
 * - `/@bot status` show current effective setting for this chat
 * - `/@bot`        same as status
 *
 * Only works in group chats (p2p is always unrestricted regardless).
 * Restricted to admins.
 */
async function handleAtBot(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.msg.chatType === 'p2p') {
    await reply(ctx, '私聊不需要 @bot，此指令仅在群聊中有效。');
    return;
  }

  const chatId = ctx.msg.chatId;
  const sub = args.trim().toLowerCase();

  if (sub === 'status' || sub === '') {
    const overrides = ctx.controls.cfg.preferences?.chatMentionOverrides ?? {};
    const globalVal = getRequireMentionInGroup(ctx.controls.cfg);
    const effective = getChatRequireMention(ctx.controls.cfg, chatId);
    const hasOverride = chatId in overrides;
    const lines = [
      `**当前群 @bot 设置**`,
      `- 全局默认：${globalVal ? '需要 @bot' : '无需 @bot'}`,
      `- 本群覆盖：${hasOverride ? (overrides[chatId] ? '需要 @bot（on）' : '无需 @bot（off）') : '未设置（跟全局）'}`,
      `- 当前生效：**${effective ? '需要 @bot' : '无需 @bot'}**`,
      '',
      '用 `/@bot on` / `/@bot off` 设置本群，`/@bot reset` 恢复全局。',
    ];
    await reply(ctx, lines.join('\n'));
    return;
  }

  if (sub !== 'on' && sub !== 'off' && sub !== 'reset') {
    await reply(ctx, '用法：`/@bot on` | `/@bot off` | `/@bot reset` | `/@bot status`');
    return;
  }

  const prefs = ctx.controls.cfg.preferences ?? {};
  const overrides = { ...(prefs.chatMentionOverrides ?? {}) };

  if (sub === 'reset') {
    delete overrides[chatId];
    const globalVal = getRequireMentionInGroup(ctx.controls.cfg);
    ctx.controls.cfg.preferences = { ...prefs, chatMentionOverrides: overrides };
    await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
    await reply(ctx, `已移除本群覆盖，恢复全局设置（${globalVal ? '需要 @bot' : '无需 @bot'}）。`);
    return;
  }

  const newVal = sub === 'on';
  overrides[chatId] = newVal;
  ctx.controls.cfg.preferences = { ...prefs, chatMentionOverrides: overrides };
  await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
  await reply(
    ctx,
    newVal
      ? '已设置：本群需要 @bot 才响应（覆盖全局）。'
      : '已设置：本群无需 @bot，任意消息均响应（覆盖全局）。',
  );
}

/**
 * /quota — query usage and remaining balance for each key in the API key pool.
 *
 * Reads ANTHROPIC_API_KEY_POOL (comma-separated) and ANTHROPIC_BASE_URL from
 * the environment. Falls back to ANTHROPIC_API_KEY when no pool is defined.
 * Calls GET <baseUrl>/api/usage/token/ for each key concurrently and renders
 * a summary table.
 *
 * Admin-only command.
 */
async function handleQuota(_args: string, ctx: CommandContext): Promise<void> {
  const baseUrl = (process.env['ANTHROPIC_BASE_URL'] ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    await reply(ctx, 'ANTHROPIC_BASE_URL 未设置，无法查询配额（此功能仅适用于 modelproxy 代理）。');
    return;
  }

  const poolEnv = process.env['ANTHROPIC_API_KEY_POOL'] ?? '';
  const singleKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const rawKeys = poolEnv
    ? poolEnv.split(',').map((k) => k.trim()).filter(Boolean)
    : singleKey
      ? [singleKey]
      : [];

  if (rawKeys.length === 0) {
    await reply(ctx, '未找到 ANTHROPIC_API_KEY_POOL 或 ANTHROPIC_API_KEY，无法查询配额。');
    return;
  }

  await reply(ctx, `正在查询 ${rawKeys.length} 个 key 的配额…`);

  interface QuotaResult {
    key: string;
    ok: boolean;
    name?: string;
    remaining?: number;
    used?: number;
    total?: number;
    unlimited?: boolean;
    error?: string;
  }

  const results = await Promise.all(
    rawKeys.map(async (key): Promise<QuotaResult> => {
      const shortKey = `…${key.slice(-8)}`;
      try {
        const resp = await fetch(`${baseUrl}/api/usage/token/`, {
          headers: {
            Authorization: `Bearer ${key}`,
            'User-Agent': 'lark-channel-bridge/quota',
          },
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await resp.json()) as {
          code?: number;
          data?: {
            name?: string;
            unlimited_quota?: boolean;
            total_available?: number;
            total_used?: number;
            total_granted?: number;
          };
          message?: string;
        };
        if (json.code && json.data) {
          const d = json.data;
          if (d.unlimited_quota) {
            return { key: shortKey, ok: true, name: d.name, unlimited: true };
          }
          return {
            key: shortKey,
            ok: true,
            name: d.name,
            remaining: (d.total_available ?? 0) / 500000,
            used: (d.total_used ?? 0) / 500000,
            total: (d.total_granted ?? 0) / 500000,
          };
        }
        return { key: shortKey, ok: false, error: json.message ?? `HTTP ${resp.status}` };
      } catch (err) {
        return { key: shortKey, ok: false, error: String(err) };
      }
    }),
  );

  const lines: string[] = ['**API Key 配额报告**', ''];
  let totalRemaining = 0;
  let totalUsed = 0;

  for (const r of results) {
    if (!r.ok) {
      lines.push(`- \`${r.key}\` ❌ ${r.error}`);
      continue;
    }
    if (r.unlimited) {
      lines.push(`- \`${r.key}\` [${r.name ?? ''}] 无限额度`);
      continue;
    }
    const rem = r.remaining ?? 0;
    const used = r.used ?? 0;
    const total = r.total ?? 0;
    totalRemaining += rem;
    totalUsed += used;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    lines.push(
      `- \`${r.key}\` [${r.name ?? ''}] 剩余 **$${rem.toFixed(2)}** / 已用 $${used.toFixed(2)} / 总 $${total.toFixed(2)} (${pct}%)`,
    );
  }

  lines.push('');
  lines.push(`**汇总：剩余 $${totalRemaining.toFixed(2)}，已用 $${totalUsed.toFixed(2)}**`);

  await reply(ctx, lines.join('\n'));
}
