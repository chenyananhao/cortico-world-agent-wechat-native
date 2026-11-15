/**
 * 持久化：身份映射、事件游标、去重集合、发送账本。
 * 落在 World 的 dataDir 下（`agentwechat-*.json`），写入走临时文件+改名，避免半截文件。
 * 不在这里存聊天正文 —— 上下文归 Coopanion 的 session 日志，这里只存"路由需要的最小事实"。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ThreadKind } from '../protocol.ts';

export interface ThreadRecord {
  accountId: string;
  threadId: string;
  threadType: ThreadKind;
  /** 最近一条进来的消息的发送者（群聊里就是具体那位群友）。 */
  senderId?: string;
  displayName?: string;
  groupName?: string;
  lastMessageId?: string;
  lastSeenAt?: string;
  /** 该会话最近一次被投递的时间，用于冷却与统计。 */
  lastDeliveredAt?: string;
}

export interface SendRecord {
  /** 幂等键：同一次逻辑发送的所有重试共用。 */
  key: string;
  accountId: string;
  threadId: string;
  /** daemon 侧的发送记录 id（拿到就记住，超时补查用）。 */
  sendId?: string;
  state: 'queued' | 'accepted' | 'failed' | 'needs_review' | 'unknown';
  at: string;
  messageId?: string;
}

export interface StoreData {
  version: 1;
  threads: Record<string, ThreadRecord>;
  /** SSE 消费游标：只写"已经可靠处理完"的那一条。 */
  cursor: string | null;
  /** 最近处理过的消息 id，防止同一 message.committed 被投递两次。 */
  seen: string[];
  sends: Record<string, SendRecord>;
}

const SEEN_LIMIT = 400;
const SEND_LIMIT = 200;

export class WorldStore {
  private data: StoreData;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'agentwechat-state.json');
    this.data = this.load();
  }

  get path(): string {
    return this.file;
  }

  get cursor(): string | null {
    return this.data.cursor;
  }

  setCursor(cursor: string): void {
    this.data.cursor = cursor;
    this.save();
  }

  thread(key: string): ThreadRecord | undefined {
    return this.data.threads[key];
  }

  threads(): ThreadRecord[] {
    return Object.values(this.data.threads);
  }

  rememberThread(record: ThreadRecord): ThreadRecord {
    const previous = this.data.threads[`${record.accountId}|${record.threadId}`];
    const merged: ThreadRecord = { ...previous, ...record };
    this.data.threads[`${record.accountId}|${record.threadId}`] = merged;
    this.save();
    return merged;
  }

  markSeen(messageId: string): boolean {
    if (this.data.seen.includes(messageId)) return false;
    this.data.seen.push(messageId);
    if (this.data.seen.length > SEEN_LIMIT) this.data.seen = this.data.seen.slice(-SEEN_LIMIT);
    return true;
  }

  saveSend(record: SendRecord): void {
    this.data.sends[record.key] = record;
    const keys = Object.keys(this.data.sends);
    if (keys.length > SEND_LIMIT) {
      for (const key of keys.slice(0, keys.length - SEND_LIMIT)) delete this.data.sends[key];
    }
    this.save();
  }

  send(key: string): SendRecord | undefined {
    return this.data.sends[key];
  }

  /** 还没定论的发送（queued/unknown 且有 sendId）：重启后拿它们去补查真实状态。 */
  unsettledSends(limit = 20): SendRecord[] {
    return Object.values(this.data.sends)
      .filter((record) => (record.state === 'queued' || record.state === 'unknown') && record.sendId)
      .slice(-limit);
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  private load(): StoreData {
    const empty: StoreData = { version: 1, threads: {}, cursor: null, seen: [], sends: {} };
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      return {
        version: 1,
        threads: isRecord(parsed.threads) ? (parsed.threads as Record<string, ThreadRecord>) : {},
        cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
        seen: Array.isArray(parsed.seen) ? parsed.seen.filter((id): id is string => typeof id === 'string') : [],
        sends: isRecord(parsed.sends) ? (parsed.sends as Record<string, SendRecord>) : {},
      };
    } catch {
      // 文件损坏：保留现场，从空状态继续（游标丢失会重放，去重集合也会丢，但不会卡死）。
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* 改不动就算了，不要因此启动失败 */
      }
      return empty;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
