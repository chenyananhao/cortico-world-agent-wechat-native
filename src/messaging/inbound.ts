/**
 * 收：`message.committed` → 消息详情 → 过滤 → 渲染成人看的文本 → 投给该会话自己的 session。
 * 这里只决定"这条要不要给模型、给到哪个 session"，不碰模型与上下文。
 */
import type { AgentWechatApiClient } from '../api/client.ts';
import type { NativeEvent, NativeMediaAsset, NativeMessage, NativeThread } from '../api/types.ts';
import type { AgentWechatConfigSection } from '../config.ts';
import type { BlobInput, WorldHost } from 'cortico/core/types.ts';
import type { IdentityMap } from '../identity/mapping.ts';
import type { WorldStore } from '../identity/store.ts';
import { isGroupThread, memoryScopeOf, sessionIdFor, threadKey, type AgentWechatMeta, type ThreadKind } from '../protocol.ts';

export interface InboundDeps {
  client: AgentWechatApiClient;
  host: () => WorldHost | null;
  config: () => AgentWechatConfigSection;
  store: WorldStore;
  identity: IdentityMap;
  worldId: string;
  log: { info(message: string): void; warn(message: string): void; debug?(message: string): void };
  /** 状态面板要的"最近一条进站消息"。 */
  onDelivered: (info: { threadId: string; threadKind: ThreadKind; messageId: string; at: string; sessionId: string }) => void;
  /**
   * 语音转文字（World 注入）。缺省表示没接转写：语音只留「（附件：语音）」。
   * 返回值里 ok=false 时把 error 写进正文，绝不吞掉这条消息。
   */
  transcribe?: (input: { bytes: Uint8Array; mime: string; key: string }) => Promise<{ ok: boolean; text?: string; error?: string }>;
}

export interface InboundResult {
  /** false = 处理失败，游标不该前进。 */
  ok: boolean;
  /** 是否真的投递给了模型（过滤掉的不算）。 */
  delivered: boolean;
  reason?: string;
}

export class InboundHandler {
  constructor(private readonly deps: InboundDeps) {}

  /** 处理一条事件；返回 ok=false 时调用方必须停在原游标。 */
  async handle(event: NativeEvent): Promise<InboundResult> {
    if (event.kind !== 'message.committed') return { ok: true, delivered: false, reason: `忽略事件类型 ${event.kind}` };
    const data = event.data as { messageId?: unknown; threadId?: unknown };
    const messageId = typeof data.messageId === 'string' ? data.messageId : null;
    if (!messageId) return { ok: true, delivered: false, reason: '事件缺少 messageId' };

    // 去重要在请求详情之前：重复推送是最常见的噪声源。
    if (!this.deps.store.markSeen(messageId)) return { ok: true, delivered: false, reason: '重复消息' };
    this.deps.store.save();

    const { client, config } = { client: this.deps.client, config: this.deps.config() };
    let message: NativeMessage;
    try {
      message = await client.message(config.accountId, messageId);
    } catch (error) {
      this.deps.log.warn(`取消息详情失败 ${messageId}：${message instanceof Error ? error.message : String(error)}`);
      return { ok: false, delivered: false, reason: '取消息详情失败' };
    }

    const self = await this.deps.identity.selfIdentity(config.accountId);
    const verdict = this.screen(message, self);
    if (!verdict.ok) return { ok: true, delivered: false, reason: verdict.reason };

    let thread: NativeThread | undefined;
    try {
      thread = await client.thread(config.accountId, message.threadId);
    } catch {
      thread = undefined; // 单条会话读取失败不算失败：用 id 兜底
    }

    await this.deps.identity.ensure(config.accountId);
    const facts = this.deps.identity.factsFor(thread, message.threadId, message.senderId);
    if (facts.threadType === 'group') await this.deps.identity.ensureGroupMembers(config.accountId, message.threadId);
    if (facts.threadType === 'group') {
      facts.senderName = facts.senderName ?? this.deps.identity.nameOf(message.senderId) ?? message.senderId ?? '群友';
    }

    const record = this.deps.identity.remember(config.accountId, message.threadId, facts, message.id);
    const typedKind: ThreadKind = facts.threadType;
    const sessionId = sessionIdFor({ threadId: message.threadId });

    const host = this.deps.host();
    if (!host) return { ok: false, delivered: false, reason: 'World 未启动' };

    // 附件走事件 blobs：Core 会存成 BlobRef，模型支持该 MIME 才真正看到内容，否则只看到 fallbackText。
    const media = await this.collectMedia(message);
    const blobs = media.blobs;
    // 语音单独再转一遍文字：模型多半听不了 audio/wav，正文里有字才真的"听见"。
    const voice = await this.voiceText(message, media.audio);

    const meta: AgentWechatMeta = {
      accountId: config.accountId,
      threadId: message.threadId,
      threadKind: typedKind,
      session: sessionId,
      messageId: message.id,
      senderId: facts.senderId,
      senderName: facts.senderName,
      threadName: facts.threadName,
      key: threadKey({ accountId: config.accountId, threadId: message.threadId }),
      cursor: event.cursor,
      ...(voice?.text ? { transcript: voice.text } : {}),
    };

    host.pushEvent(
      {
        type: 'agentwechat.message',
        source: this.deps.worldId,
        // senderKey 同时是 companion 的记忆域键：用会话（不是发送者）保证「每个微信会话一个域」，
        // 否则带 `|` 的键会被 companion 的 cleanScope() 洗成 main，和桌宠的 desktop-pet.* 对不上。
        senderKey: memoryScopeOf({ threadId: message.threadId, kind: typedKind }),
        ts: new Date(message.createdAt ?? event.createdAt).toISOString(),
        text: render(message, facts.senderName, facts.threadName, typedKind, voice),
        meta,
        ...(blobs.length > 0 ? { blobs } : {}),
      },
      // session 决定这条进哪个上下文；Persona 没声明过的 id 会退回 main（不会静默丢消息）。
      { session: sessionId },
    );

    this.deps.store.rememberThread({ ...record, lastDeliveredAt: new Date().toISOString() });
    this.deps.onDelivered({
      threadId: message.threadId,
      threadKind: typedKind,
      messageId: message.id,
      at: new Date().toISOString(),
      sessionId,
    });
    return { ok: true, delivered: true };
  }

  /**
   * 媒体 → 事件附件。任何一步失败都只降级成文字说明，绝不因为附件而丢掉正文。
   * 总量有上限：大文件不塞进上下文，说明里会写明"未内联"。
   * 顺带把第一条"可用的音轨"挑出来，交给语音转写（daemon 上未转码完的音轨会是 409）。
   */
  private async collectMedia(message: NativeMessage): Promise<{ blobs: BlobInput[]; audio: VoiceAudio | null }> {
    const config = this.deps.config();
    const declared = message.media ?? [];
    // 真实 daemon 的消息详情里 media 基本是空的，附件清单只能靠 lookup 拿（见 mediaAssets 的注释）。
    // 所以只要媒体开关打开、且这条消息"可能带附件"，就去问一次清单；没附件自然返回空。
    if (!config.mediaEnabled) return { blobs: [], audio: null };
    const maybeHasMedia = declared.length > 0 || isMediaType(message.type);
    if (!maybeHasMedia) return { blobs: [], audio: null };

    let assets: NativeMediaAsset[] = [];
    try {
      const looked = await this.deps.client.mediaAssets(message.accountId, message.id);
      if (looked.error) this.deps.log.warn(`媒体清单带错误 ${message.id}：${looked.error}`);
      assets = looked.assets;
    } catch (error) {
      this.deps.log.warn(`取媒体清单失败 ${message.id}：${describeError(error)}`);
      return { blobs: [], audio: null };
    }

    const blobs: BlobInput[] = [];
    let audio: VoiceAudio | null = null;
    let total = 0;
    for (const asset of assets) {
      if (typeof asset?.id !== 'string' || asset.id === '') continue;
      // 一条消息可能同时列出"已可读"和"待转码"两份音轨；待转码那份取内容必然 409（实测），跳过。
      const state = typeof asset.state === 'string' ? asset.state : '';
      if (state !== '' && state !== 'available') {
        this.deps.log.debug?.(`跳过 ${state} 状态的附件 ${asset.id}`);
        continue;
      }
      if (blobs.length >= MAX_BLOBS) {
        this.deps.log.warn(`附件超过 ${MAX_BLOBS} 个，其余只在正文里列名`);
        break;
      }
      try {
        const content = await this.deps.client.mediaContent(message.accountId, asset.id);
        if (content.bytes.byteLength === 0) continue;
        if (total + content.bytes.byteLength > MAX_BLOB_TOTAL) {
          this.deps.log.warn(`附件总量超过 ${MAX_BLOB_TOTAL} 字节，其余不内联`);
          break;
        }
        total += content.bytes.byteLength;
        const mime = content.mime || 'application/octet-stream';
        if (!audio && mime.startsWith('audio/')) audio = { bytes: content.bytes, mime, assetId: asset.id };
        const label = mediaLabel(asset);
        blobs.push({
          bytes: content.bytes,
          mime,
          name: assetName(asset),
          fallbackText: `（收到${label}，当前模型不支持该格式时只能看到这条说明）`,
        });
      } catch (error) {
        this.deps.log.warn(`取媒体内容失败 ${asset.id}：${describeError(error)}`);
      }
    }
    return { blobs, audio };
  }

  /**
   * 语音转文字。只在"语音消息 + 开了转写 + 拿到了音轨"时才动；
   * 失败不抛，原因会进正文（模型因此知道"这里有段语音但没听出来"）。
   */
  private async voiceText(message: NativeMessage, audio: VoiceAudio | null): Promise<VoiceText | null> {
    if (message.type !== 34) return null;
    const config = this.deps.config();
    if (!config.voiceToTextEnabled) return { error: '语音转写未启用' };
    if (!audio) return { error: '没拿到音频（附件还没转码完）' };
    const transcribe = this.deps.transcribe;
    if (!transcribe) return { error: '未接入语音转写' };
    try {
      const result = await transcribe({
        bytes: audio.bytes,
        mime: audio.mime,
        key: `${message.id}|${audio.assetId}`,
      });
      if (result.ok && result.text) return { text: result.text };
      return { error: result.error ?? '转写失败' };
    } catch (error) {
      return { error: describeError(error) };
    }
  }

  /** 配置与消息类型层面的准入判断。 */
  private screen(message: NativeMessage, self: SelfIdentity): { ok: true } | { ok: false; reason: string } {
    const config = this.deps.config();
    if (!config.enabled || !config.receiveEnabled) return { ok: false, reason: '未启用接收' };
    // 自己发出去的消息不能回流成新输入。
    if (message.direction === 'outgoing') return { ok: false, reason: '自己发出的消息' };
    const threadId = message.threadId;
    if (threadId === '' ) return { ok: false, reason: '缺少 threadId' };
    const group = isGroupThread(threadId);
    if (group && !config.groupMessagesEnabled) return { ok: false, reason: '群聊未启用' };
    if (!group && !config.directMessagesEnabled) return { ok: false, reason: '私聊未启用' };
    if (config.allowedThreads.length > 0 && !config.allowedThreads.includes(threadId)) {
      return { ok: false, reason: '不在允许的会话列表内' };
    }
    if (group && config.groupMentionOnly && !messageMentionsMe(message, self)) return { ok: false, reason: '群聊仅响应 @' };
    if (message.type === 10000) return { ok: false, reason: '系统消息' };
    // 49 = 应用消息：文件/链接/小程序都走这里。带附件的放行（附件由 blobs 承载），纯卡片不处理。
    // 注意：真实 daemon 的消息详情里 media 常常是空数组，附件清单只能靠 `POST /media/lookup` 拿，
    // 所以"有没有附件"不能只看 message.media，否则图片/文件会被判成空消息直接丢掉。
    if (message.type === 49 && (message.media?.length ?? 0) === 0 && !looksLikeFileCard(message)) {
      return { ok: false, reason: '应用卡片消息（v1 只处理带附件的）' };
    }
    const hasText = typeof message.body === 'string' && message.body.trim() !== '';
    if (!hasText && !isMediaType(message.type) && (message.media?.length ?? 0) === 0) {
      return { ok: false, reason: '空消息' };
    }
    if (isMediaType(message.type) && !config.mediaEnabled) return { ok: false, reason: '媒体未启用' };
    return { ok: true };
  }
}

/** 自己的身份：wxid 与自己可能被 @ 的显示名。 */
export interface SelfIdentity {
  ids?: string[];
  names?: string[];
}

/** 语音转写结果：成功给 text，失败给 error（两者至少有一个）。 */
export interface VoiceText {
  text?: string;
  error?: string;
}

/** 从附件里挑出来的那条音轨。 */
interface VoiceAudio {
  bytes: Uint8Array;
  mime: string;
  assetId: string;
}

/**
 * 群聊 @ 判定，三级降级：
 * 1. daemon 直接给了 `mentions.self`；
 * 2. `mentions.userIds` 里出现自己的 wxid；
 * 3. 正文里出现「@自己的显示名」——真实 daemon 常常给 `self:false, userIds:[]`，
 *    只认前两级会把合法 @ 全丢掉（实测：正文「@一条大肥鱼 测试3」被判成没 @）。
 */
export function messageMentionsMe(message: NativeMessage, self: SelfIdentity = {}): boolean {
  if (message.mentions?.self === true) return true;
  const mentioned = message.mentions?.userIds ?? [];
  const ids = self.ids ?? [];
  if (mentioned.length > 0 && ids.length > 0 && mentioned.some((id) => ids.includes(id))) return true;
  const body = typeof message.body === 'string' ? message.body.replace(/[\u2005\u200b]/g, ' ') : '';
  if (body === '') return false;
  return (self.names ?? []).some((name) => name !== '' && body.includes(`@${name}`));
}

/** 微信消息类型里"正文为空但有附件"的那几种：图片 3、语音 34、视频 43、表情 47、文件/卡片 49。 */
export function isMediaType(type: number | undefined): boolean {
  return type === 3 || type === 34 || type === 43 || type === 47 || type === 49;
}

/** 应用消息里像文件的那些（appMessageType/标题带文件名），用来放行"微信文件"并交给 lookup 判定。 */
function looksLikeFileCard(message: NativeMessage): boolean {
  const appType = (message as { appMessageType?: unknown }).appMessageType;
  if (typeof appType === 'number' && appType > 0) return true;
  const body = typeof message.body === 'string' ? message.body : '';
  return /\.(?:docx?|xlsx?|pptx?|pdf|zip|rar|7z|mp4|mov|mp3|wav|amr|silk|txt|md|csv|apk|exe|bin)\b/i.test(body);
}

const TYPE_LABEL: Record<number, string> = { 3: '图片', 34: '语音', 43: '视频', 49: '卡片', 10000: '系统' };

/** 交给模型的一行：谁、在哪个会话、说了什么。上下文隔离靠 session，这里只是可读性。 */
export function render(
  message: NativeMessage,
  senderName?: string,
  threadName?: string,
  kind: ThreadKind = 'direct',
  voice?: VoiceText | null,
): string {
  const who = senderName ?? message.senderId ?? '对方';
  const where = kind === 'group' ? `群「${threadName ?? message.threadId}」` : '私聊';
  const head = `${who} 在${where}：`; // 冒号后换行，模型容易分段
  const quote = message.quote?.serverId ? '[引用] ' : '';
  return `${head}\n${quote}${bodyOf(message, voice)}`.trim();
}

function bodyOf(message: NativeMessage, voice?: VoiceText | null): string {
  const text = typeof message.body === 'string' ? message.body.trim() : '';
  // 语音：转写成功就让模型直接读字；失败也写清楚卡在哪，别让它以为对方什么都没说。
  if (message.type === 34) {
    if (voice?.text) return `（语音）${voice.text}`;
    if (voice?.error) return `（语音，${voice.error}）`;
  }
  if (text !== '') return text;
  if ((message.media?.length ?? 0) > 0) return mediaLine(message);
  if (isMediaType(message.type)) return `（附件：${TYPE_LABEL[message.type] ?? '附件'}）`;
  return '';
}

function mediaLine(message: NativeMessage): string {
  const items = message.media ?? [];
  const kinds = items.map((item) => `${TYPE_LABEL[item.kind as unknown as number] ?? item.kind}[${item.id}]`);
  return `（附件：${kinds.join('、')}）`;
}

/** 单条消息最多内联几个附件、总共多少字节（超出只保留文字说明）。 */
const MAX_BLOBS = 4;
const MAX_BLOB_TOTAL = 48 * 1024 * 1024;

function mediaLabel(asset: NativeMediaAsset): string {
  const table: Record<string, string> = { image: '图片', file: '文件', video: '视频', voice: '语音' };
  const kind = typeof asset.kind === 'string' ? asset.kind : '';
  if (kind !== '' && table[kind]) return table[kind];
  // 真实 daemon 的清单里没有 kind，只有 contentType（例如 image/png）——按 MIME 归类。
  const mime = typeof asset.contentType === 'string' ? asset.contentType : '';
  if (mime.startsWith('image/')) return '图片';
  if (mime.startsWith('video/')) return '视频';
  if (mime.startsWith('audio/')) return '语音';
  return '文件';
}

function assetName(asset: NativeMediaAsset): string {
  for (const key of ['name', 'fileName', 'filename'] as const) {
    const value = asset[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return `awx-${asset.id}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
