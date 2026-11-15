/**
 * 发：每次逻辑发送一个幂等键，超时先补查、再原键重试，绝不换键重发。
 * `needs_review` 是"不知道发没发出去"，照实返回，不当成功也不当失败。
 */
import { randomUUID } from 'node:crypto';
import type { AgentWechatApiClient, SendOutcome } from '../api/client.ts';
import { ApiError } from '../api/transport.ts';
import type { NativeMediaKind, NativeTextSendRequest } from '../api/types.ts';
import type { AgentWechatConfigSection } from '../config.ts';
import type { SendRecord, WorldStore } from '../identity/store.ts';

export interface OutboundDeps {
  client: AgentWechatApiClient;
  store: WorldStore;
  config: () => AgentWechatConfigSection;
  log: { info(message: string): void; warn(message: string): void; debug?(message: string): void };
}

/** 查询发送状态的退避（毫秒）：只问几次，问不出来就照实说"已入队"。 */
const SETTLE_DELAYS = [400, 900, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendRequest {
  threadId: string;
  text: string;
  quoteMessageId?: string;
  quoteServerId?: string;
  mentions?: NativeTextSendRequest['mentions'];
  /** 同一次逻辑发送的重试必须传同一个；不传则就地生成。 */
  idempotencyKey?: string;
}

export interface SendResult {
  ok: boolean;
  state: SendRecord['state'];
  sendId?: string;
  messageId?: string;
  idempotencyKey: string;
  needsReview: boolean;
  error?: string;
}

export interface SendMediaRequest {
  threadId: string;
  kind: NativeMediaKind;
  sourceId: string;
  fileName?: string;
  /** 同一次逻辑发送的重试必须传同一个；不传则就地生成。 */
  idempotencyKey?: string;
}

export function newIdempotencyKey(): string {
  return `awx-${randomUUID()}`;
}

export class Outbound {
  constructor(private readonly deps: OutboundDeps) {}

  async sendText(request: SendRequest): Promise<SendResult> {
    const config = this.deps.config();
    const key = request.idempotencyKey?.trim() || newIdempotencyKey();
    if (!config.sendEnabled) {
      return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '发送未在配置中启用（sendEnabled=false）' };
    }
    const text = request.text.trim();
    if (!text) return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '正文为空' };
    if (!request.threadId) return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '缺少 threadId' };

    const limit = request.quoteMessageId || request.quoteServerId ? 16 * 1024 : 64 * 1024;
    if (Buffer.byteLength(text, 'utf8') > limit) {
      return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: `正文超过 ${limit} 字节上限` };
    }

    const previous = this.deps.store.send(key);
    if (previous?.state === 'accepted') {
      return { ok: true, state: 'accepted', sendId: previous.sendId, messageId: previous.messageId, idempotencyKey: key, needsReview: false };
    }

    const quote = await this.resolveQuote(config.accountId, request);
    const body: NativeTextSendRequest = {
      threadId: request.threadId,
      text,
      ...(quote ? { quote } : {}),
      ...(request.mentions ? { mentions: request.mentions } : {}),
    };

    this.deps.store.saveSend({ key, accountId: config.accountId, threadId: request.threadId, state: 'queued', at: new Date().toISOString() });
    return this.runSend(key, request.threadId, config.accountId, () => this.deps.client.sendText(config.accountId, body, key));
  }

  /**
   * 引用回复的 quote：两个 id 都要保留；只给了 messageId 时顺手把 serverId 查出来，
   * 免得服务端收到半个引用。查不到就只带 messageId，让服务端自己判断。
   */
  private async resolveQuote(
    accountId: string,
    request: SendRequest,
  ): Promise<{ messageId?: string; serverId?: string } | null> {
    if (!request.quoteMessageId && !request.quoteServerId) return null;
    const quote: { messageId?: string; serverId?: string } = {};
    if (request.quoteMessageId) quote.messageId = request.quoteMessageId;
    if (request.quoteServerId) quote.serverId = request.quoteServerId;
    if (!quote.serverId && quote.messageId) {
      try {
        const message = await this.deps.client.message(accountId, quote.messageId);
        if (typeof message.serverId === 'string' && message.serverId !== '') quote.serverId = message.serverId;
      } catch {
        // 拿不到 serverId 不算失败：引用仍然生效，只是服务端可能只认 messageId。
      }
    }
    return quote;
  }

  /**
   * 发媒体：先上传拿 sourceId，再按 sourceId 发。上传与发送各自幂等 ——
   * 上传失败不会产生任何发送记录；发送阶段沿用同一套"超时先补查、原键重试"。
   */
  async sendMedia(request: SendMediaRequest): Promise<SendResult> {
    const config = this.deps.config();
    const key = request.idempotencyKey?.trim() || newIdempotencyKey();
    if (!config.sendEnabled) {
      return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '发送未在配置中启用（sendEnabled=false）' };
    }
    if (!config.mediaEnabled) {
      return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '媒体未在配置中启用（mediaEnabled=false）' };
    }
    if (!request.threadId) return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '缺少 threadId' };
    if (!request.sourceId) return { ok: false, state: 'failed', idempotencyKey: key, needsReview: false, error: '缺少 sourceId（先上传）' };

    const previous = this.deps.store.send(key);
    if (previous?.state === 'accepted') {
      return { ok: true, state: 'accepted', sendId: previous.sendId, messageId: previous.messageId, idempotencyKey: key, needsReview: false };
    }

    this.deps.store.saveSend({ key, accountId: config.accountId, threadId: request.threadId, state: 'queued', at: new Date().toISOString() });
    return this.runSend(key, request.threadId, config.accountId, () =>
      this.deps.client.sendMedia(
        config.accountId,
        { threadId: request.threadId, kind: request.kind, sourceId: request.sourceId, ...(request.fileName ? { fileName: request.fileName } : {}) },
        key,
      ),
    );
  }

  /** 发送重试的唯一实现：超时/断线先按幂等键补查，查不到才用同一把键重试，绝不换键。 */
  private async runSend(key: string, threadId: string, accountId: string, attempt: () => Promise<SendOutcome>): Promise<SendResult> {
    let lastError: string | undefined;
    for (let round = 1; round <= 2; round += 1) {
      try {
        return this.settle(key, threadId, accountId, await attempt());
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError && error.kind === 'timeout') {
          // 请求可能已经落到 daemon：先按幂等键问一句，别盲目重发。
          const found = await this.lookup(accountId, key);
          if (found) return this.settle(key, threadId, accountId, found);
          this.deps.log.warn(`发送超时且未查到记录，用同一幂等键重试：${key}`);
          continue;
        }
        if (error instanceof ApiError && error.kind === 'network' && round === 1) {
          const found = await this.lookup(accountId, key);
          if (found) return this.settle(key, threadId, accountId, found);
          continue;
        }
        break;
      }
    }

    const state: SendRecord['state'] = 'unknown';
    this.deps.store.saveSend({ key, accountId, threadId, state, at: new Date().toISOString() });
    return { ok: false, state, idempotencyKey: key, needsReview: true, error: lastError ?? '发送结果未知' };
  }

  private async lookup(accountId: string, key: string): Promise<SendOutcome | null> {
    try {
      const send = await this.deps.client.sendByIdempotencyKey(accountId, key);
      return { send, delivered: send.state === 'accepted', needsReview: send.state === 'needs_review' };
    } catch (error) {
      // 查不到（404）是正常的"没发出去"；其它错误继续按未知处理。
      if (error instanceof ApiError && error.kind === 'not-found') return null;
      this.deps.log.debug?.(`补查发送记录失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async settle(key: string, threadId: string, accountId: string, outcome: SendOutcome): Promise<SendResult> {
    let { send } = outcome;
    // 非终态（queued/submitting）就按官方建议轮询 GET /sends/{id}，问清楚再报，别把"入队"说成"送达"。
    for (const delay of SETTLE_DELAYS) {
      if (send.state !== 'queued' && send.state !== 'submitting') break;
      await sleep(delay);
      try {
        send = await this.deps.client.send(accountId, send.id);
      } catch (error) {
        this.deps.log.debug?.(`查询发送状态失败：${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    const settled = send.state === 'queued' || send.state === 'submitting';
    const record: SendRecord = {
      key,
      accountId,
      threadId,
      sendId: send.id,
      state: settled ? 'queued' : send.state,
      at: send.createdAt ?? new Date().toISOString(),
      messageId: send.localMessageId ?? undefined,
    };
    this.deps.store.saveSend(record);
    if (send.state === 'failed') {
      return { ok: false, state: 'failed', sendId: send.id, idempotencyKey: key, needsReview: false, error: send.errorCode ?? '发送失败' };
    }
    if (send.state === 'needs_review') {
      return { ok: false, state: 'needs_review', sendId: send.id, idempotencyKey: key, needsReview: true, error: '需要人工核对（结果未知，不是失败）' };
    }
    // accepted 才算送达；排队中还可能失败，如实上报状态。
    return { ok: send.state === 'accepted', state: settled ? 'queued' : send.state, sendId: send.id, messageId: record.messageId, idempotencyKey: key, needsReview: false };
  }
}
