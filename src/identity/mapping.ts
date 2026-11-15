/**
 * 身份映射：把微信侧的 id 换成人看的名字，并把"谁在这个会话里"记进 store。
 * 群聊里 senderId 才是发话的人，threadId 只是房间，两者不能混。
 */
import type { AgentWechatApiClient } from '../api/client.ts';
import type { NativeAccount, NativeContact, NativeGroup, NativeGroupMember, NativeThread } from '../api/types.ts';
import { isGroupThread, kindOf, type ThreadKind } from '../protocol.ts';
import type { ThreadRecord, WorldStore } from './store.ts';

export interface SenderFacts {
  senderId?: string;
  senderName?: string;
  threadName?: string;
  threadType: ThreadKind;
}

/** 服务端分页上限是 200：500 会被判 400 invalid_request。 */
const PAGE_LIMIT = 200;

export class IdentityMap {
  private readonly contacts = new Map<string, NativeContact>();
  private readonly groups = new Map<string, NativeGroup>();
  private readonly members = new Map<string, NativeGroupMember>();
  private loadedFor: string | null = null;
  private loading: Promise<void> | null = null;
  private loadedAt = 0;
  /** 自己的 wxid 与所有可用的显示名（通讯录里 id 等于 ownUsername 的那条）。 */
  private ownUsername: string | null = null;
  private ownNames: string[] = [];

  constructor(
    private readonly client: AgentWechatApiClient,
    private readonly store: WorldStore,
    private readonly log: { warn(message: string): void; debug?(message: string): void },
  ) {}

  /** 拉一次通讯录与群列表（失败不致命，名字退化成 id）。 */
  async ensure(accountId: string): Promise<void> {
    if (this.loadedFor === accountId && Date.now() - this.loadedAt < 5 * 60_000) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const [contacts, groups, accounts] = await Promise.all([
          this.client.contacts(accountId, { limit: PAGE_LIMIT }),
          this.client.groups(accountId, { limit: PAGE_LIMIT }),
          this.client.accounts().catch(() => null),
        ]);
        this.contacts.clear();
        this.groups.clear();
        for (const contact of contacts.items) this.contacts.set(contact.id, contact);
        for (const group of groups.items) this.groups.set(group.id, group);
        this.resolveSelf(accountId, accounts?.items ?? []);
        this.loadedFor = accountId;
        this.loadedAt = Date.now();
      } catch (error) {
        this.log.warn(`读取通讯录失败（名字会退化成 id）：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * 认出"我自己"。真实 daemon 对群聊 @ 常常给出 `mentions: {self:false, userIds:[]}`，
   * 只认 self 会把合法 @ 全过滤掉，所以这里把 ownUsername 与自己显示名都留一份。
   */
  private resolveSelf(accountId: string, accounts: NativeAccount[]): void {
    const account = accounts.find((item) => item.id === accountId);
    const own = typeof account?.ownUsername === 'string' && account.ownUsername !== '' ? account.ownUsername : null;
    this.ownUsername = own;
    const names = new Set<string>();
    const self = own ? this.contacts.get(own) ?? [...this.contacts.values()].find((c) => c.username === own) : undefined;
    for (const value of [self?.displayName, self?.nickname, self?.remark]) {
      if (typeof value === 'string' && value.trim() !== '') names.add(value.trim());
    }
    this.ownNames = [...names];
  }

  /** 自己的身份：wxid 列表 + 显示名列表，供群聊 @ 三级判定用。 */
  async selfIdentity(accountId: string): Promise<{ ids: string[]; names: string[] }> {
    await this.ensure(accountId);
    return { ids: this.ownUsername ? [this.ownUsername] : [], names: [...this.ownNames] };
  }

  /** 群成员按需补：只在该群第一次出现时拉。 */
  async ensureGroupMembers(accountId: string, groupId: string): Promise<void> {
    if (this.members.has(groupId)) return;
    try {
      const list = await this.client.groupMembers(accountId, groupId, { limit: PAGE_LIMIT });
      for (const member of list.items) this.members.set(member.id, member);
    } catch (error) {
      this.log.debug?.(`读取群成员失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  nameOf(senderId: string | null | undefined): string | undefined {
    if (!senderId) return undefined;
    const member = this.members.get(senderId);
    if (member?.displayName) return member.displayName;
    const contact = this.contacts.get(senderId);
    return contact?.remark ?? contact?.displayName ?? contact?.nickname ?? undefined;
  }

  nameOfGroup(threadId: string): string | undefined {
    return this.groups.get(threadId)?.displayName;
  }

  factsFor(thread: NativeThread | undefined, threadId: string, senderId: string | null): SenderFacts {
    // 会话详情读不到时用 id 兜底：群 id 恒以 `@chatroom` 结尾，别把群记成 unknown/direct。
    const reported = kindOf(thread?.kind);
    const threadType: ThreadKind =
      reported !== 'unknown' ? reported : threadId.endsWith('@chatroom') ? 'group' : 'direct';
    if (isGroupThread(threadId, threadType)) {
      return {
        senderId: senderId ?? undefined,
        senderName: this.nameOf(senderId),
        threadName: thread?.displayName ?? this.nameOfGroup(threadId) ?? threadId,
        threadType,
      };
    }
    return {
      senderId: senderId ?? undefined,
      senderName: thread?.displayName ?? this.nameOf(senderId) ?? senderId ?? undefined,
      threadName: thread?.displayName ?? this.nameOf(senderId) ?? threadId,
      threadType,
    };
  }

  remember(accountId: string, threadId: string, facts: SenderFacts, messageId: string): ThreadRecord {
    const now = new Date().toISOString();
    return this.store.rememberThread({
      accountId,
      threadId,
      threadType: facts.threadType,
      senderId: facts.senderId ?? this.store.thread(`${accountId}|${threadId}`)?.senderId,
      displayName: facts.threadType === 'group' ? facts.threadName : facts.senderName,
      groupName: facts.threadType === 'group' ? facts.threadName : undefined,
      lastMessageId: messageId,
      lastSeenAt: now,
    });
  }
}
