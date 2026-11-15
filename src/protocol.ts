/**
 * 本扩展自己的契约：会话身份、会话 id 与会话 id 的反查。
 * 微信侧的原始类型在 api/types.ts；这里只放"我们要怎么认一个会话"。
 */

export type ThreadKind = 'direct' | 'group' | 'system' | 'unknown';

/** 一个微信会话的身份：账号 + 会话 id 才是主键，显示名只是显示。 */
export interface ThreadRef {
  accountId: string;
  threadId: string;
  kind: ThreadKind;
  displayName?: string;
}

/** 稳定的内部主键：accountId + threadId。 */
export function threadKey(ref: Pick<ThreadRef, 'accountId' | 'threadId'>): string {
  return `${ref.accountId}|${ref.threadId}`;
}

/** Core 的会话 id 前缀由 Persona 那边（`ISOLATED_SESSION_PREFIX`）约定。 */
export const SESSION_PREFIX = 'wechat-';

/** 会话 id 里只保留可打印、无分隔歧义的字符；其余折成 `-`。 */
export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'thread';
}

/**
 * 会话 id：Core 与 Persona 都按这个 id 认会话，同一 thread 必须永远算出同一个 id。
 * 群 id 形如 `xxx@chatroom`，`@` 折成 `-`。
 */
export function sessionIdFor(ref: Pick<ThreadRef, 'threadId'>): string {
  return `${SESSION_PREFIX}${sanitizeSegment(ref.threadId)}`.slice(0, 120);
}

/** 从会话 id 反推会话 id 候选（仅用于没有映射记录时的兜底显示）。 */
export function threadIdHintFromSession(sessionId: string): string | null {
  return sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : null;
}

/** `direct` / `group` / `system` 归一化。 */
export function kindOf(kind: string | null | undefined): ThreadKind {
  if (kind === 'direct' || kind === 'group' || kind === 'system') return kind;
  return 'unknown';
}

/** 群聊的 threadId 以 `@chatroom` 结尾；`kind` 缺失时用它兜底。 */
export function isGroupThread(threadId: string, kind?: ThreadKind): boolean {
  if (kind) return kind === 'group';
  return threadId.endsWith('@chatroom');
}

/**
 * 记忆域（companion 的 `cleanScope()` 只认 `[A-Za-z0-9._:-]`，其余一律被洗成 `main`）：
 * 每个微信会话一个域——私聊 `awx.<threadId>`、群 `awx.g.<群号>`。
 * 这样「会话内的经历」留在本会话域；「关于主人的事实」由环境提示词约定显式写 `main`。
 */
export function memoryScopeOf(ref: { threadId: string; kind?: ThreadKind }): string {
  const group = isGroupThread(ref.threadId, ref.kind);
  const base = ref.threadId.replace(/@chatroom$/i, '');
  const cleaned = base
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '');
  return `${group ? 'awx.g.' : 'awx.'}${cleaned || 'thread'}`.slice(0, 64);
}

/** 事件与回执共用的 meta：不渲染进模型上下文，只给存档与路由用。 */export interface AgentWechatMeta {
  accountId: string;
  threadId: string;
  threadKind: ThreadKind;
  session: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  /** 语音消息的转写结果（只有真转出字时才有）。 */
  transcript?: string;
  [key: string]: unknown;
}
