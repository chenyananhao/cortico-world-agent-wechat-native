/**
 * agent-wechat 1 号 API 里我们要用到的形状，取自官方的 `native.generated.ts`。
 * 只声明用到的字段；其余字段照原样留在 `raw` 里，不做猜测。
 * 所有 ID 都是字符串（serverId 会超出 JS 安全整数范围）。
 */

export interface NativeEvent {
  /** 事件在日志里的位置，十进制字符串，只增。断线后用它续传。 */
  cursor: string;
  /** `message.committed` / `group.updated` / `send.updated` / `operation.updated` 等。 */
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface NativeMessage {
  id: string;
  accountId: string;
  threadId: string;
  serverId: string | null;
  senderId: string | null;
  /** 微信数字类型：1 文本、3 图片、34 语音、43 视频、49 应用消息、10000 系统提示。 */
  type: number;
  appMessageType?: number;
  quote?: { serverId: string; type: number; state?: string; senderId?: string };
  direction: string | null;
  body: string | null;
  createdAt: string | null;
  mentions: { state: string; userIds: string[]; self: boolean | null; all: boolean | null; source: string | null };
  version: string;
  [key: string]: unknown;
}

export interface NativeThread {
  id: string;
  accountId: string;
  peerId: string;
  /** `direct` / `group` / `system`。 */
  kind: string;
  displayName: string | null;
  unreadCount: number | null;
  readStateVersion: string;
  lastMessage?: NativeThreadMessage | null;
  [key: string]: unknown;
}

/** 真机（2.4.0）`GET /threads/{threadId}/messages` 的条目：正文在 `body`。 */
export interface NativeThreadMessage {
  id: string;
  senderId: string | null;
  senderName?: string | null;
  direction: string | null;
  type: number;
  appMessageType?: number | null;
  /** 正文字段（真机就是这个）。非文字消息为 null。 */
  body?: string | null;
  /** 旧文档里写的 `text`，真机不总有；保留做兜底。 */
  text?: string | null;
  createdAt: string | null;
}

export interface NativeContact {
  id: string;
  username: string;
  displayName: string | null;
  nickname: string | null;
  remark: string | null;
  [key: string]: unknown;
}

export interface NativeGroup {
  id: string;
  roomId: string;
  displayName: string | null;
  ownerId: string | null;
  [key: string]: unknown;
}

export interface NativeGroupMember {
  id: string;
  displayName: string | null;
  [key: string]: unknown;
}

/** 发送意图；`state` 为 accepted 才算微信真的收下了。 */
export interface NativeSendIntent {
  id: string;
  accountId: string;
  destination: string;
  /** queued / submitting / accepted / failed / needs_review / cancelled。 */
  state: string;
  clientId: string | null;
  serverId: string | null;
  errorCode: string | null;
  localMessageId?: string;
  createdAt: string;
}

export interface NativeTextSendRequest {
  threadId: string;
  text: string;
  quote?: { messageId: string; serverId: string };
  mentions?: { userIds?: string[]; all?: boolean };
}

export type NativeMediaKind = 'image' | 'file' | 'video' | 'voice';

export interface NativeMediaSendRequest {
  threadId: string;
  kind: NativeMediaKind;
  sourceId: string;
  fileName?: string;
}

/** `POST /accounts/{account}/uploads` 的响应：暂存好的文件，`id` 就是发送时要的 sourceId。 */
export interface NativeOwnedMediaSource {
  id: string;
  name: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export interface NativeMediaAsset {
  /** 附件 id，取内容时用作 `/media/{id}/content` 的 id。 */
  id: string;
  contentType?: string;
  byteLength?: number;
  /**
   * `available` 才拿得到内容；同一条语音消息常同时列出 `available` 与 `pending` 两份音轨，
   * 取 `pending` 那份会得到 409 `media_not_available`（实测）。
   */
  state?: string | null;
  variant?: string | null;
  advertisedByteLength?: number | null;
  /** 原始文件名；图片/表情通常为 null。 */
  filename?: string | null;
  /** 服务端给的内容地址（带 `/v1` 前缀）；客户端自己拼路径时以它为准。 */
  contentUrl?: string;
  actualVariant?: string;
  kind?: string;
  variants?: Array<{ variant: string; size?: number; mimeType?: string }>;
  [key: string]: unknown;
}

/** `POST /accounts/{account}/media/lookup` 的单条结果：一条消息对一份附件清单。 */
export interface NativeMediaLookupItem {
  messageId: string;
  assets?: NativeMediaAsset[];
  error?: string;
}

export interface NativeMediaJob {
  id: string;
  state: string;
  [key: string]: unknown;
}

export interface NativeList<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface NativeIdentity {
  product: string;
  backend: string;
  version: string;
  apiVersion: number;
  capabilities: string[];
}

export interface NativeAccount {
  id: string;
  alias?: string | null;
  /** 是否已经完成微信登录认证。 */
  authenticated?: boolean;
  /** 是否启用自动连接。 */
  autoConnect?: boolean;
  /** online / offline 等连接状态。 */
  connection?: string;
  /** 联系人同步是否就绪。 */
  contactSyncReady?: boolean;
  /** 消息接收传输方式，例如 native_push。 */
  incomingTransport?: string;
  /** 是否运行原生运行环境。 */
  nativeRuntime?: boolean;
  ownUsername?: string | null;
  pendingCursorProjection?: boolean;
  pendingMessageRecalls?: number;
  pendingProjectionBatches?: number;
  pendingReadProjections?: number;
  pendingRecallProjections?: number;
  pendingSavedLoginProjection?: boolean;
  profileRecoveryPending?: boolean;
  schemaCompatibility?: string;
  storageMode?: string;
  [key: string]: unknown;
}
