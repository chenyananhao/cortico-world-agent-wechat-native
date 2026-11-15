/** 配置页与运行状态里给人看的文字；模型看到的工具描述在 tools.ts。 */
import type { Language } from 'cortico/core/language.ts';
import type { DescribeText } from 'cortico/core/types.ts';

export interface AgentWechatText {
  worldLabel: string;
  settings: string;
  baseUrl: string;
  accountId: string;
  caCertFile: string;
  receiveEnabled: string;
  sendEnabled: string;
  directMessagesEnabled: string;
  groupMessagesEnabled: string;
  groupMentionOnly: string;
  mediaEnabled: string;
  voiceToTextEnabled: string;
  voiceModelDir: string;
  voiceLanguage: string;
  voiceMaxSeconds: string;
  voice: string;
  allowedThreads: string;
  requestTimeoutMs: string;
  token: string;
  tokenConfigured: string;
  tokenMissing: string;
  connection: string;
  account: string;
  stream: string;
  lastEvent: string;
  cursor: string;
  lastError: string;
  lastSend: string;
  threads: string;
  promptTitle: string;
  promptDescription: string;
  notConfigured: string;
  online: string;
  offline: string;
  connecting: string;
  connected: string;
  disconnected: string;
  never: string;
}

const ZH: AgentWechatText = {
  worldLabel: 'NAS 微信',
  settings: 'NAS 微信设置',
  baseUrl: 'API 根地址',
  accountId: '微信账号 ID',
  caCertFile: 'CA 证书文件（可选，PEM 路径）',
  receiveEnabled: '接收消息',
  sendEnabled: '允许发送',
  directMessagesEnabled: '处理私聊',
  groupMessagesEnabled: '处理群聊',
  groupMentionOnly: '群聊仅在被 @ 时响应',
  mediaEnabled: '处理图片、文件、视频、语音',
  voiceToTextEnabled: '语音转文字',
  voiceModelDir: '语音模型目录（留空用桌宠那份）',
  voiceLanguage: '语音识别语言',
  voiceMaxSeconds: '超过此时长的语音不转写（0 = 不限制）',
  voice: '语音转写',
  allowedThreads: '只接收这些会话（留空表示不限制）',
  requestTimeoutMs: '请求超时',
  token: 'API 令牌',
  tokenConfigured: '已配置',
  tokenMissing: '未配置',
  connection: 'API 连接',
  account: '微信账号状态',
  stream: '事件流',
  lastEvent: '最后收到事件',
  cursor: '事件游标',
  lastError: '最后一次错误',
  lastSend: '最近发送结果',
  threads: '会话',
  promptTitle: 'NAS 微信环境说明',
  promptDescription: '告诉模型这条微信线的记忆域怎么用（主人层 main、会话层 awx.*）。',
  notConfigured: '未配置',
  online: '在线',
  offline: '离线',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  never: '还没有',
};

const EN: AgentWechatText = {
  worldLabel: 'NAS WeChat',
  settings: 'NAS WeChat settings',
  baseUrl: 'API base URL',
  accountId: 'WeChat account ID',
  caCertFile: 'CA certificate file (optional, PEM path)',
  receiveEnabled: 'Receive messages',
  sendEnabled: 'Allow sending',
  directMessagesEnabled: 'Handle direct chats',
  groupMessagesEnabled: 'Handle groups',
  groupMentionOnly: 'Groups: reply only when mentioned',
  mediaEnabled: 'Handle images, files, video and voice',
  voiceToTextEnabled: 'Transcribe voice messages',
  voiceModelDir: 'Speech model folder (empty uses the desktop pet one)',
  voiceLanguage: 'Speech language',
  voiceMaxSeconds: 'Skip voice longer than this (0 = no limit)',
  voice: 'Voice transcription',
  allowedThreads: 'Only these chats (empty means no limit)',
  requestTimeoutMs: 'Request timeout',
  token: 'API token',
  tokenConfigured: 'configured',
  tokenMissing: 'missing',
  connection: 'API connection',
  account: 'WeChat account',
  stream: 'Event stream',
  lastEvent: 'Last event',
  cursor: 'Event cursor',
  lastError: 'Last error',
  lastSend: 'Last send',
  threads: 'Chats',
  promptTitle: 'NAS WeChat environment',
  promptDescription: 'Tells the model how memory scopes work for this WeChat line (owner layer main, per-chat awx.*).',
  notConfigured: 'not configured',
  online: 'online',
  offline: 'offline',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected',
  never: 'never',
};

export function awxText(language?: Language): AgentWechatText {
  return language === 'en' ? EN : ZH;
}

export const AGENTWECHAT_EVENT_DESCRIPTIONS = {
  message: {
    zh: '收到一条微信消息，渲染成一行可读文本；每个会话独立进上下文。',
    en: 'A WeChat message rendered as one readable line; each chat has its own context.',
  } satisfies DescribeText,
  receipt: {
    zh: '发送回执（accepted、failed 或 needs_review）；不唤醒模型。',
    en: 'A send receipt (accepted, failed or needs_review); does not wake the model.',
  } satisfies DescribeText,
  status: {
    zh: '连接、账号或事件流状态变化；不唤醒模型。',
    en: 'A connection, account or stream state change; does not wake the model.',
  } satisfies DescribeText,
} as const;

export const AGENTWECHAT_TOOL_SUMMARIES = {
  awx_status: { zh: '看一眼 NAS 微信的连接、账号和事件流状态。', en: 'Shows the NAS WeChat connection, account and stream state.' },
  awx_threads: { zh: '列出最近的微信会话。', en: 'Lists recent WeChat chats.' },
  awx_messages: { zh: '读某个会话最近的消息。', en: 'Reads recent messages of one chat.' },
  awx_contacts: { zh: '查微信联系人。', en: 'Looks up WeChat contacts.' },
  awx_send_text: { zh: '往微信会话发一条文字，可引用、可 @。', en: 'Sends text to a chat, optionally quoting or mentioning members.' },
  awx_send_status: { zh: '查一条发送的真实状态（按 sendId 或幂等键），不确定时先查再决定。', en: 'Looks up the real state of a send by sendId or idempotency key.' },
  awx_send_media: { zh: '上传并发送图片、文件、视频或语音。', en: 'Uploads and sends an image, file, video or voice clip.' },
} as const;
