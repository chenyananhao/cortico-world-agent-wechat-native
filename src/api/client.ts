/**
 * agent-wechat HTTP API 的薄封装。路径按 v1 路由表；参数与响应以官方 native.generated.ts 为准。
 * 所有 id 都是字符串，原样透传，不做数字解析。
 */
import { buildMultipart } from './multipart.ts';
import { Transport, type RequestOptions, type TransportOptions } from './transport.ts';
import type {
  NativeAccount, NativeContact, NativeEvent, NativeGroup, NativeGroupMember, NativeIdentity, NativeList,
  NativeMediaAsset, NativeMediaLookupItem, NativeMediaSendRequest, NativeMessage, NativeOwnedMediaSource, NativeSendIntent,
  NativeTextSendRequest, NativeThread, NativeThreadMessage,
} from './types.ts';

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

/** 发送结果：把 daemon 的三种终态摊平成调用方要判断的东西。 */
export interface SendOutcome {
  send: NativeSendIntent;
  /** accepted 才算送达；needs_review 是"不知道"，不是失败。 */
  delivered: boolean;
  needsReview: boolean;
}

export class AgentWechatApiClient {
  private readonly transport: Transport;

  constructor(options: TransportOptions) {
    this.transport = new Transport(options);
  }

  reconfigure(options: TransportOptions): void {
    this.transport.reconfigure(options);
  }

  destroy(): void {
    this.transport.destroy();
  }

  /** 未认证的健康检查；用来把"服务不可达"和"令牌不对"分开。 */
  async health(): Promise<{ ok: boolean; status?: number }> {
    try {
      await this.transport.requestJson<unknown>('/health', { timeoutMs: 8000 });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  identity(): Promise<NativeIdentity> {
    return this.transport.requestJson<NativeIdentity>('/');
  }

  accounts(): Promise<NativeList<NativeAccount>> {
    return this.transport.requestJson<NativeList<NativeAccount>>('/accounts');
  }

  threads(accountId: string, query: PageQuery = {}): Promise<NativeList<NativeThread>> {
    return this.transport.requestJson<NativeList<NativeThread>>(withQuery(`/accounts/${seg(accountId)}/threads`, query));
  }

  thread(accountId: string, threadId: string): Promise<NativeThread> {
    return this.transport.requestJson<NativeThread>(`/accounts/${seg(accountId)}/threads/${seg(threadId)}`);
  }

  threadMessages(accountId: string, threadId: string, query: PageQuery = {}): Promise<NativeList<NativeThreadMessage>> {
    return this.transport.requestJson<NativeList<NativeThreadMessage>>(
      withQuery(`/accounts/${seg(accountId)}/threads/${seg(threadId)}/messages`, query),
    );
  }

  message(accountId: string, messageId: string): Promise<NativeMessage> {
    return this.transport.requestJson<NativeMessage>(`/accounts/${seg(accountId)}/messages/${seg(messageId)}`);
  }

  contacts(accountId: string, query: PageQuery & { query?: string } = {}): Promise<NativeList<NativeContact>> {
    return this.transport.requestJson<NativeList<NativeContact>>(withQuery(`/accounts/${seg(accountId)}/contacts`, query));
  }

  groups(accountId: string, query: PageQuery = {}): Promise<NativeList<NativeGroup>> {
    return this.transport.requestJson<NativeList<NativeGroup>>(withQuery(`/accounts/${seg(accountId)}/groups`, query));
  }

  groupMembers(accountId: string, groupId: string, query: PageQuery = {}): Promise<NativeList<NativeGroupMember>> {
    return this.transport.requestJson<NativeList<NativeGroupMember>>(
      withQuery(`/accounts/${seg(accountId)}/groups/${seg(groupId)}/members`, query),
    );
  }

  /**
   * 发文字。`idempotencyKey` 由调用方生成且必须与"这一次逻辑发送"一一对应：
   * 重试、超时后补查都复用它，绝不换新键重发。
   */
  async sendText(
    accountId: string,
    request: NativeTextSendRequest,
    idempotencyKey: string,
    options: RequestOptions = {},
  ): Promise<SendOutcome> {
    const send = await this.transport.sendJson<NativeSendIntent>('POST', `/accounts/${seg(accountId)}/sends`, {
      body: { kind: 'text', ...request },
      headers: { 'idempotency-key': idempotencyKey },
      ...options,
    });
    return outcome(send);
  }

  /** 发送记录是**按账号**分区的：实测 /sends/{id} 会 404，必须带账号段。 */
  send(accountId: string, sendId: string): Promise<NativeSendIntent> {
    return this.transport.requestJson<NativeSendIntent>(`/accounts/${seg(accountId)}/sends/${seg(sendId)}`);
  }

  sendByIdempotencyKey(accountId: string, key: string): Promise<NativeSendIntent> {
    return this.transport.requestJson<NativeSendIntent>(
      withQuery(`/accounts/${seg(accountId)}/sends/by-idempotency-key`, { key }),
    );
  }

  /**
   * 媒体附件元数据（需要 media 权限）。
   * 真实 daemon 的路径是账号分区的 `POST /accounts/{account}/media/lookup`，
   * 响应 `{items:[{messageId,assets,error?}]}` —— 一条消息一份清单。
   */
  async mediaAssets(accountId: string, messageId: string): Promise<{ assets: NativeMediaAsset[]; error?: string }> {
    const looked = await this.transport.sendJson<{ items?: NativeMediaLookupItem[] }>(
      'POST',
      `/accounts/${seg(accountId)}/media/lookup`,
      { body: { messageIds: [messageId] } },
    );
    const item = looked.items?.[0];
    return { assets: item?.assets ?? [], ...(item?.error ? { error: item.error } : {}) };
  }

  /** 媒体内容；返回原始字节，调用方决定落盘还是进 blob。 */
  mediaContent(accountId: string, mediaId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.transport.download(`/accounts/${seg(accountId)}/media/${seg(mediaId)}/content`);
  }

  /**
   * 上传一个文件的暂存副本，拿到发送要用的 source ID。
   * 契约：`POST /accounts/{account}/uploads`，multipart 字段 `file`，响应是 `OwnedMediaSource{id,name,mediaType,byteLength,sha256}`。
   */
  async upload(
    accountId: string,
    file: { bytes: Uint8Array; fileName: string; mimeType: string },
  ): Promise<{ sourceId: string; name: string; byteLength: number; sha256: string }> {
    const form = buildMultipart({ field: 'file', fileName: file.fileName, mimeType: file.mimeType, bytes: file.bytes });
    const stored = await this.transport.sendJson<NativeOwnedMediaSource>('POST', `/accounts/${seg(accountId)}/uploads`, {
      raw: form.body,
      contentType: form.contentType,
      // 大文件上传按最长一侧给足时间，仍受 requestTimeoutMs 之外的上限约束。
      timeoutMs: 300_000,
    });
    return { sourceId: stored.id, name: stored.name, byteLength: stored.byteLength, sha256: stored.sha256 };
  }

  async sendMedia(accountId: string, request: NativeMediaSendRequest, idempotencyKey: string): Promise<SendOutcome> {
    // 真机不接受 fileName：上传时服务端已经记下名字，带上它会整体 400 invalid_request。
    const send = await this.transport.sendJson<NativeSendIntent>('POST', `/accounts/${seg(accountId)}/sends`, {
      body: { kind: request.kind, threadId: request.threadId, sourceId: request.sourceId },
      headers: { 'idempotency-key': idempotencyKey },
    });
    return outcome(send);
  }

  /** 事件流：先读一次归档（补历史），再用 SSE 跟实时。 */
  events(accountId: string, after?: string): Promise<NativeList<NativeEvent>> {
    return this.transport.requestJson<NativeList<NativeEvent>>(withQuery(`/accounts/${seg(accountId)}/events`, { after }));
  }

  /** SSE 长连接；带 `after` 或 Last-Event-ID 由调用方决定。 */
  openEventStream(accountId: string, after: string | null, signal: AbortSignal) {
    const headers: Record<string, string> = {};
    if (after) headers['last-event-id'] = after;
    const path = withQuery(`/accounts/${seg(accountId)}/events/stream`, after ? { after } : {});
    return this.transport.openStream(path, headers, signal);
  }

  /**
   * 记录消费者位点；必须在事件可靠处理之后调用。
   * 注意：消费位点是**按账号**的，路由为 /accounts/{account}/consumers/{name}/ack；
   * 少了账号段会 404（资源不存在），看起来像"ack 失败"。
   */
  ackConsumer(accountId: string, name: string, cursor: string): Promise<unknown> {
    return this.transport.sendJson(
      'POST',
      `/accounts/${seg(accountId)}/consumers/${seg(name)}/ack`,
      { body: { cursor } },
    );
  }
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

function outcome(send: NativeSendIntent): SendOutcome {
  return { send, delivered: send.state === 'accepted', needsReview: send.state === 'needs_review' };
}
