/**
 * 给模型用的 `awx_` 工具。所有工具都"知道自己被哪个 session 调用"（`ctx.role`），
 * 因此默认回复落到当前会话，而不是最近说话的那个人。
 */
import { readFile } from 'node:fs/promises';
import type { ToolCallContext, ToolDef, ToolOutcome, ToolSchema, ToolTag } from 'cortico/core/types.ts';
import type { AgentWechatApiClient } from './api/client.ts';
import { mimeOfFileName } from './api/multipart.ts';
import type { NativeMediaKind } from './api/types.ts';
import type { AgentWechatConfigSection } from './config.ts';
import type { WorldStore } from './identity/store.ts';
import { checkMediaPath } from './media-guard.ts';
import type { Outbound } from './messaging/outbound.ts';
import { sessionIdFor, threadIdHintFromSession } from './protocol.ts';

export interface ToolDeps {
  client: () => AgentWechatApiClient | null;
  outbound: () => Outbound | null;
  store: WorldStore;
  config: () => AgentWechatConfigSection;
  /** 允许 `awx_send_media` 读的目录（默认 `<dataDir>/outbox`）。 */
  mediaRoot: () => string;
  status: () => string;
  log: { warn(message: string): void; debug?(message: string): void };
}

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;

/** daemon 支持的附件类型；其余一律按 file 处理前先挡住。 */
const MEDIA_KINDS: readonly NativeMediaKind[] = ['image', 'file', 'video', 'voice'];

interface ToolSpec {
  schema: ToolSchema;
  tags: readonly ToolTag[];
  handler: (deps: ToolDeps) => Handler;
}

const SPECS: ToolSpec[] = [
  {
    schema: {
      name: 'awx_status',
      description: '查看 NAS 微信的连接状态、当前事件游标、最近一次收消息/错误/发送结果。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    tags: ['read'],
    handler: (deps) => async () => deps.status(),
  },
  {
    schema: {
      name: 'awx_threads',
      description: '列出微信会话（私聊与群聊），用于找到该回复哪个 threadId。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条，默认 20' } },
        additionalProperties: false,
      },
    },
    tags: ['read'],
    handler: (deps) => async (args) => {
      const client = deps.client();
      if (!client) return '微信客户端未连接。';
      const limit = clamp(args.limit, 20, 1, 100);
      const list = await client.threads(deps.config().accountId, { limit });
      if (list.items.length === 0) return '没有会话。';
      return list.items.map((thread) => {
        const kind = thread.kind === 'group' ? '群' : thread.kind === 'direct' ? '私聊' : thread.kind;
        const unread = thread.unreadCount > 0 ? `（未读 ${thread.unreadCount}）` : '';
        return `- [${kind}] ${thread.displayName || thread.id} | threadId=${thread.id}${unread}`;
      }).join('\n');
    },
  },
  {
    schema: {
      name: 'awx_messages',
      description: '读某个微信会话的最近消息。默认当前会话；给 threadId 可读别的会话（只读，不会串上下文）。',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: '微信会话 id；省略则用当前所在会话' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 20' },
        },
        additionalProperties: false,
      },
    },
    tags: ['read'],
    handler: (deps) => async (args, ctx) => {
      const client = deps.client();
      if (!client) return '微信客户端未连接。';
      const threadId = text(args.threadId) ?? resolveThreadId(ctx.role, deps.store);
      if (!threadId) return '不知道要读哪个会话：请给出 threadId。';
      const limit = clamp(args.limit, 20, 1, 50);
      const list = await client.threadMessages(deps.config().accountId, threadId, { limit });
      if (list.items.length === 0) return '这个会话没有可见的历史消息。';
      return list.items.map((item) => {
        const who = item.senderName || item.senderId || (item.direction === 'outgoing' ? '我' : '对方');
        const at = item.createdAt?.replace('T', ' ').slice(0, 16) ?? '';
        return `[${at}] ${who}: ${item.body ?? item.text ?? '（无文本）'}`;
      }).join('\n');
    },
  },
  {
    schema: {
      name: 'awx_contacts',
      description: '查微信联系人（可按名字搜索）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按名字/备注搜索，省略则列出最近联系人' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20' },
        },
        additionalProperties: false,
      },
    },
    tags: ['read'],
    handler: (deps) => async (args) => {
      const client = deps.client();
      if (!client) return '微信客户端未连接。';
      const limit = clamp(args.limit, 20, 1, 100);
      const list = await client.contacts(deps.config().accountId, { limit, query: text(args.query) });
      if (list.items.length === 0) return '没有匹配的联系人。';
      return list.items.map((contact) => `- ${contact.remark || contact.displayName || contact.nickname || contact.id} | id=${contact.id}`).join('\n');
    },
  },
  {
    schema: {
      name: 'awx_send_text',
      description: '给微信会话发一条文字。默认发回当前会话；quoteMessageId 可引用回复；群聊里可用 mentions 点名。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发的文字' },
          threadId: { type: 'string', description: '目标会话 id；省略则发回当前会话' },
          quoteMessageId: { type: 'string', description: '要引用的微信消息 id（可选）' },
          mentions: {
            type: 'array',
            items: { type: 'string' },
            description: '要 @ 的群成员微信 id 列表（仅群聊有效）',
          },
          mentionAll: { type: 'boolean', description: '是否 @所有人（仅群聊，慎用）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    tags: ['write'],
    handler: (deps) => async (args, ctx) => {
      const outbound = deps.outbound();
      if (!outbound) return '微信发送通道未就绪。';
      const threadId = text(args.threadId) ?? resolveThreadId(ctx.role, deps.store);
      if (!threadId) return '不知道要发给谁：请给出 threadId。';
      const mentions = mentionsOf(args);
      const result = await outbound.sendText({
        threadId,
        text: text(args.text) ?? '',
        quoteMessageId: text(args.quoteMessageId),
        ...(mentions ? { mentions } : {}),
      });
      if (result.ok) return `已发送（sendId=${result.sendId ?? '?'}）。`;
      if (result.state === 'queued') {
        return `已入队但未确认送达（sendId=${result.sendId ?? '?'}，幂等键=${result.idempotencyKey}）：稍后可用 awx_status 看最近发送状态，别当成一定送到了。`;
      }
      if (result.needsReview) {
        return `发送结果未知，需要人工核对（sendId=${result.sendId ?? '?'}，幂等键=${result.idempotencyKey}）：${result.error ?? ''}`;
      }
      return `发送失败：${result.error ?? result.state}（幂等键=${result.idempotencyKey}）`;
    },
  },
  {
    schema: {
      name: 'awx_send_status',
      description: '查一条微信发送的真实状态（按 sendId 或幂等键）。结果不确定时先查这里，不要盲目重发。',
      parameters: {
        type: 'object',
        properties: {
          sendId: { type: 'string', description: '发送记录 id（awx_send_text/awx_send_media 返回的 sendId）' },
          idempotencyKey: { type: 'string', description: '发送时用的幂等键（awx- 开头）' },
        },
        additionalProperties: false,
      },
    },
    tags: ['read'],
    handler: (deps) => async (args) => {
      const client = deps.client();
      if (!client) return '微信通道未就绪。';
      const sendId = text(args.sendId);
      const key = text(args.idempotencyKey);
      if (!sendId && !key) return '给出 sendId 或 idempotencyKey 之一。';
      let send: { id?: string; state?: string; errorCode?: string | null; serverId?: string | null } | null = null;
      try {
        send = sendId
          ? await client.send(deps.config().accountId, sendId)
          : await client.sendByIdempotencyKey(deps.config().accountId, key as string);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sendId) return `查不到这条发送记录（sendId=${sendId}）：${message}`;
        return `没有这条幂等键的发送记录（key=${key}）：${message}`;
      }
      if (!send) return '没有查到发送记录。';
      return [
        `状态：${send.state ?? 'unknown'}`,
        `sendId：${send.id ?? sendId ?? '?'}`,
        `消息 id：${send.serverId ?? '（服务端还没给）'}`,
        send.errorCode ? `错误码：${send.errorCode}` : '',
        send.state === 'needs_review' ? '这条结果未知，需要人工核对，不要直接重发。' : '',
        send.state === 'queued' || send.state === 'submitting' ? '还在队列里，过一会儿再查。' : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
    },
  },
  {
    schema: {
      name: 'awx_send_media',
      description: '给微信会话发图片/文件/视频/语音：先上传本地文件拿到 sourceId，再发送。只能读发送目录里的文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径；必须在发送目录内（默认 <dataDir>/outbox）' },
          fileName: { type: 'string', description: '对方看到的文件名；省略用本文件名' },
          threadId: { type: 'string', description: '目标会话 id；省略则发回当前会话' },
          kind: { type: 'string', enum: ['image', 'file', 'video', 'voice'], description: '附件类型' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    tags: ['write'],
    handler: (deps) => async (args, ctx) => {
      const outbound = deps.outbound();
      const client = deps.client();
      if (!outbound || !client) return '微信发送通道未就绪。';
      const threadId = text(args.threadId) ?? resolveThreadId(ctx.role, deps.store);
      if (!threadId) return '不知道要发给谁：请给出 threadId。';
      const kind = (text(args.kind) ?? 'file') as NativeMediaKind;
      if (!MEDIA_KINDS.includes(kind)) return `不认识的附件类型：${kind}`;
      const path = text(args.path);
      if (!path) return '缺少 path：请给出本地文件绝对路径。';

      // 闸门：只读发送目录里的普通文件（realpath 解析，符号链接指出去也拒绝）。
      const check = await checkMediaPath(deps.mediaRoot(), path);
      if (!check.ok) return check.reason;

      // 校验通过后再真读一次：读失败要如实报，别把上传失败伪装成"已发送"。
      let bytes: Uint8Array;
      try {
        bytes = await readFile(check.path);
      } catch (error) {
        return `读不到文件：${check.path}（${error instanceof Error ? error.message : String(error)}）`;
      }
      const fileName = text(args.fileName) ?? check.name;
      const mimeType = mimeOfFileName(fileName);

      let upload: { sourceId: string; name: string; byteLength: number };
      try {
        upload = await client.upload(deps.config().accountId, { bytes, fileName, mimeType });
      } catch (error) {
        return `上传失败，未发送：${error instanceof Error ? error.message : String(error)}`;
      }

      const result = await outbound.sendMedia({ threadId, kind, sourceId: upload.sourceId, fileName });
      if (result.ok) return `已发送 ${kind}（${upload.name}，sourceId=${upload.sourceId}，sendId=${result.sendId ?? '?'}）。`;
      if (result.state === 'queued') {
        return `已上传并入队，但未确认送达（sendId=${result.sendId ?? '?'}，幂等键=${result.idempotencyKey}）。`;
      }
      if (result.needsReview) {
        return `发送结果未知，需要人工核对（sendId=${result.sendId ?? '?'}，幂等键=${result.idempotencyKey}）：${result.error ?? ''}`;
      }
      return `发送失败：${result.error ?? result.state}（幂等键=${result.idempotencyKey}）`;
    },
  },
];

/** 自描述用：不含 handler 的 schema 列表。 */
export const TOOL_SCHEMAS: Array<ToolSchema & { tags: readonly ToolTag[] }> = SPECS.map((spec) => ({
  ...spec.schema,
  tags: spec.tags,
}));

export function buildTools(deps: ToolDeps): ToolDef[] {
  return SPECS.map((spec) => ({
    ...spec.schema,
    tags: spec.tags,
    handler: spec.handler(deps),
  }));
}

/** 会话 id → 微信 threadId：先查映射，查不到再按前缀反推。 */
export function resolveThreadId(sessionId: string, store: WorldStore): string | null {
  for (const record of store.threads()) {
    if (sessionIdFor({ threadId: record.threadId }) === sessionId) return record.threadId;
  }
  return threadIdHintFromSession(sessionId);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 群聊 @ 成员：把工具参数整理成 daemon 的 `mentions` 结构；空就当作没点名。 */
function mentionsOf(args: Record<string, unknown>): { userIds?: string[]; all?: boolean } | undefined {
  const raw = Array.isArray(args.mentions) ? args.mentions : [];
  const userIds = raw.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
  const all = args.mentionAll === true;
  if (userIds.length === 0 && !all) return undefined;
  return { ...(userIds.length > 0 ? { userIds } : {}), ...(all ? { all: true } : {}) };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
