/**
 * `worlds.agentwechat` 的形状、默认值与校验。
 * 只放可以进 config.json 的东西；令牌不在这里，走 secret 存储（见 tokenEnv）。
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';
import { readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { awxText } from './strings.ts';

export const AGENTWECHAT_ID = 'agentwechat';

/** 令牌存放在部署 .env 里的环境变量名；配置页只显示“已配置/未配置”。 */
export const AGENTWECHAT_TOKEN_ENV = 'CORTICO_AGENTWECHAT_TOKEN';

/** 消费位点登记用的消费者名，固定不变。 */
export const AGENTWECHAT_CONSUMER = 'coopanion-agent-wechat-native';

export interface AgentWechatConfigSection {
  enabled: boolean;
  /** daemon 的 API 根地址，如 `https://<NAS 地址>:7443/v1`。 */
  baseUrl: string;
  /** 要接入的微信账号 id（`GET /accounts` 里那个），不是昵称。 */
  accountId: string;
  /** 额外的 CA 证书文件（PEM）；留空时只用系统信任库。 */
  caCertFile: string;
  receiveEnabled: boolean;
  sendEnabled: boolean;
  directMessagesEnabled: boolean;
  groupMessagesEnabled: boolean;
  /** 群聊只有明确 @ 到本账号时才进上下文；关闭则群里说什么都收。 */
  groupMentionOnly: boolean;
  mediaEnabled: boolean;
  /**
   * `awx_send_media` 允许读取的目录；留空用 `<dataDir>/outbox`。
   * 目录之外的文件（含符号链接指出去的）一律拒绝发送。
   */
  mediaSendRoot: string;
  /** 语音消息转成文字再进上下文；关掉就只留「（附件：语音）」。 */
  voiceToTextEnabled: boolean;
  /** 识别模型目录；留空用桌宠那份 SenseVoiceSmall。 */
  voiceModelDir: string;
  /** `zh`/`en`/`ja`/`ko`/`yue`/`auto`。 */
  voiceLanguage: string;
  /** 超过这个秒数的语音不转写（0 = 不限制）。 */
  voiceMaxSeconds: number;
  /** 允许接收的会话（threadId）；空数组表示不额外限制。 */
  allowedThreads: string[];
  requestTimeoutMs: number;
  /** SSE 断线后的最长重连间隔。 */
  reconnectMaxMs: number;
}

export const AGENTWECHAT_DEFAULTS: AgentWechatConfigSection = {
  enabled: false,
  baseUrl: '',
  accountId: '',
  caCertFile: '',
  receiveEnabled: true,
  sendEnabled: true,
  directMessagesEnabled: true,
  groupMessagesEnabled: false,
  groupMentionOnly: true,
  mediaEnabled: false,
  mediaSendRoot: '',
  voiceToTextEnabled: true,
  voiceModelDir: '',
  voiceLanguage: 'auto',
  voiceMaxSeconds: 120,
  allowedThreads: [],
  requestTimeoutMs: 20000,
  reconnectMaxMs: 30000,
};

export function normalizeConfig(raw: Partial<AgentWechatConfigSection> | undefined): AgentWechatConfigSection {
  const cfg = { ...AGENTWECHAT_DEFAULTS, ...(raw ?? {}) } as AgentWechatConfigSection;
  cfg.baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
  cfg.accountId = typeof cfg.accountId === 'string' ? cfg.accountId.trim() : '';
  cfg.caCertFile = typeof cfg.caCertFile === 'string' ? cfg.caCertFile.trim() : '';
  cfg.mediaSendRoot = typeof cfg.mediaSendRoot === 'string' ? cfg.mediaSendRoot.trim() : '';
  cfg.voiceModelDir = typeof cfg.voiceModelDir === 'string' ? cfg.voiceModelDir.trim() : '';
  cfg.voiceLanguage = typeof cfg.voiceLanguage === 'string' && cfg.voiceLanguage.trim() !== '' ? cfg.voiceLanguage.trim() : 'auto';
  cfg.allowedThreads = Array.isArray(cfg.allowedThreads)
    ? cfg.allowedThreads.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : [];
  return cfg;
}

/** 激活前的检查：配置能自洽才允许启用。 */
export function validateConfig(cfg: AgentWechatConfigSection): void {
  if (!cfg.baseUrl) return; // 未填地址时只报“未配置”，由 start() 给出可读状态，不阻止挂载
  let url: URL;
  try {
    url = new URL(cfg.baseUrl);
  } catch {
    throw new Error(`baseUrl 不是合法 URL：${cfg.baseUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error('baseUrl 必须是 https://（不跳过证书校验）');
  integer(cfg.requestTimeoutMs, 'requestTimeoutMs', 1000, 300000);
  integer(cfg.reconnectMaxMs, 'reconnectMaxMs', 1000, 600000);
  integer(cfg.voiceMaxSeconds, 'voiceMaxSeconds', 0, 600);
  if (!VOICE_LANGUAGES.has(cfg.voiceLanguage)) {
    throw new Error(`voiceLanguage 只能是 ${[...VOICE_LANGUAGES].join('/')} 之一`);
  }
  if (cfg.voiceModelDir && /[\r\n\0]/.test(cfg.voiceModelDir)) throw new Error('voiceModelDir 含非法字符');
  if (cfg.caCertFile && /[\r\n\0]/.test(cfg.caCertFile)) throw new Error('caCertFile 含非法字符');
  if (cfg.mediaSendRoot) {
    if (/[\r\n\0]/.test(cfg.mediaSendRoot)) throw new Error('mediaSendRoot 含非法字符');
    if (!isAbsolute(cfg.mediaSendRoot)) throw new Error('mediaSendRoot 必须是绝对路径，例如 D:\\wechat-outbox');
  }
}

/** SenseVoice 认这几种语言，其它值一律按 `auto` 交给模型自己判断。 */
export const VOICE_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);

/** 桌宠下载的那份模型目录名；版本变了就退回到「同目录里第一份能用的模型」。 */
const SENSEVOICE_DIR = 'sensevoice-small-int8-2024-07-17';

function looksLikeModelDir(dir: string): boolean {
  try {
    const files = readdirSync(dir);
    return files.some((name) => name.endsWith('.onnx')) && files.includes('tokens.txt');
  } catch {
    return false;
  }
}

/**
 * 默认模型目录：桌宠语音输入下发的那份 SenseVoiceSmall。
 *
 * 位置是 `<CORTICO_HOME>/models/desktop-pet/<模型版本>`，而 World 的 `dataDir` 是
 * `<CORTICO_HOME>/companion/data`（还要再上两层），所以不能按固定层数拼——从 `CORTICO_HOME`
 * 和 `dataDir` 各往上找几级，真正存在模型文件的那层才算数。
 */
export function defaultVoiceModelDir(dataDir?: string): string {
  const roots: string[] = [];
  const home = process.env.CORTICO_HOME?.trim();
  if (home) roots.push(resolve(home));
  if (dataDir) {
    let dir = resolve(dataDir);
    for (let i = 0; i < 5; i += 1) {
      roots.push(dir);
      dir = resolve(dir, '..');
    }
  }
  for (const root of roots) {
    const pet = resolve(root, 'models', 'desktop-pet');
    const exact = resolve(pet, SENSEVOICE_DIR);
    if (looksLikeModelDir(exact)) return exact;
    try {
      // 版本号换了也别整条线哑掉：挑第一份真能用的模型。
      for (const name of readdirSync(pet).sort()) {
        const dir = resolve(pet, name);
        if (looksLikeModelDir(dir)) return dir;
      }
    } catch {
      // 目录不存在：继续往上找。
    }
  }
  // 一份都没找到时给最有希望的路径，让报错能指到具体位置。
  const fallbackRoot = home ? resolve(home) : dataDir ? resolve(dataDir, '..', '..') : process.cwd();
  return resolve(fallbackRoot, 'models', 'desktop-pet', SENSEVOICE_DIR);
}

/** `awx_send_media` 的默认发送目录：`<dataDir>/outbox`（World 启动时建出来）。 */
export function defaultMediaSendRoot(dataDir: string): string {
  return resolve(dataDir, 'outbox');
}

function integer(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 之间的整数`);
  }
}

/** World 页“设置”用的配置组：只有非敏感项，令牌通过面板单独写入 secret。 */
export function agentWechatConfigGroup(language?: Language): ConfigGroup {
  const t = awxText(language);
  const k = `worlds.${AGENTWECHAT_ID}`;
  return {
    id: `world:${AGENTWECHAT_ID}`,
    owner: `world:${AGENTWECHAT_ID}`,
    schema: {
      type: 'object',
      title: t.settings,
      properties: {
        [`${k}.baseUrl`]: { type: 'string', title: t.baseUrl, 'x-hot': false },
        [`${k}.accountId`]: { type: 'string', title: t.accountId, 'x-hot': false },
        [`${k}.caCertFile`]: { type: 'string', title: t.caCertFile, 'x-hot': false },
        [`${k}.receiveEnabled`]: { type: 'boolean', title: t.receiveEnabled, 'x-hot': true },
        [`${k}.sendEnabled`]: { type: 'boolean', title: t.sendEnabled, 'x-hot': true },
        [`${k}.directMessagesEnabled`]: { type: 'boolean', title: t.directMessagesEnabled, 'x-hot': true },
        [`${k}.groupMessagesEnabled`]: { type: 'boolean', title: t.groupMessagesEnabled, 'x-hot': true },
        [`${k}.groupMentionOnly`]: { type: 'boolean', title: t.groupMentionOnly, 'x-hot': true },
        [`${k}.mediaEnabled`]: { type: 'boolean', title: t.mediaEnabled, 'x-hot': true },
        [`${k}.mediaSendRoot`]: { type: 'string', title: t.mediaSendRoot, 'x-hot': true },
        [`${k}.voiceToTextEnabled`]: { type: 'boolean', title: t.voiceToTextEnabled, 'x-hot': true },
        [`${k}.voiceModelDir`]: { type: 'string', title: t.voiceModelDir, 'x-hot': false },
        [`${k}.voiceLanguage`]: {
          type: 'string', title: t.voiceLanguage, enum: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'], 'x-hot': true,
        },
        [`${k}.voiceMaxSeconds`]: {
          type: 'integer', title: t.voiceMaxSeconds, minimum: 0, maximum: 600, 'x-suffix': 's', 'x-hot': true,
        },
        [`${k}.allowedThreads`]: {
          type: 'array', title: t.allowedThreads, items: { type: 'string' }, 'x-hot': true,
        },
        [`${k}.requestTimeoutMs`]: {
          type: 'integer', title: t.requestTimeoutMs, minimum: 1000, maximum: 300000, 'x-suffix': 'ms', 'x-hot': false,
        },
      },
    },
  };
}
