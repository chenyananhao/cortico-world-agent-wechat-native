/**
 * AgentWechatWorld：把 NAS 上的 agent-wechat 服务接成 Coopanion 的一个 World。
 * 收到的每条消息投给它自己的 session（`wechat-<threadId>`），发送只允许走 awx_ 工具，
 * 全程复用 Coopanion 的模型、人格与 Memory。
 */
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { AgentWechatApiClient } from './api/client.ts';
import { EventPump } from './api/events.ts';
import type { NativeEvent } from './api/types.ts';
import {
  AGENTWECHAT_CONSUMER, AGENTWECHAT_ID, AGENTWECHAT_TOKEN_ENV, agentWechatConfigGroup, defaultVoiceModelDir,
  normalizeConfig, validateConfig, type AgentWechatConfigSection,
} from './config.ts';
import { IdentityMap } from './identity/mapping.ts';
import { WorldStore } from './identity/store.ts';
import { InboundHandler } from './messaging/inbound.ts';
import { Outbound, type SendRequest, type SendResult } from './messaging/outbound.ts';
import { sessionIdFor, threadIdHintFromSession } from './protocol.ts';
import { awxText } from './strings.ts';
import { buildTools } from './tools.ts';
import { VoiceTranscriber } from './voice/stt.ts';
import type { WorldContext } from 'cortico/world.ts';

type SseState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** 同一条事件连续失败到这个次数就跳过（并记 error），避免坏消息卡住整个事件流。 */
const MAX_EVENT_ATTEMPTS = 3;
/** 周期补查发送状态：把本地 queued/unknown 的记录追到服务端终态。 */
const SETTLE_INTERVAL_MS = 45_000;

export class AgentWechatWorld implements World {
  readonly id = AGENTWECHAT_ID;

  private readonly ctx: WorldContext<AgentWechatConfigSection>;
  private readonly store: WorldStore;
  private host: WorldHost | null = null;
  private client: AgentWechatApiClient | null = null;
  private identity: IdentityMap | null = null;
  private outbound: Outbound | null = null;
  private voice: VoiceTranscriber | null = null;
  private pump: EventPump | null = null;
  private abort: AbortController | null = null;

  private sse: SseState = 'idle';
  private accountOnline: boolean | null = null;
  private lastEventAt: string | null = null;
  private lastEventKind: string | null = null;
  private lastError: string | null = null;
  private lastSend: SendResult | null = null;
  private delivered = 0;
  /** 同一条事件连续处理失败几次就跳过它：再多也不动，会把整条事件流堵死。 */
  private stuckKey: string | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private stuckCount = 0;
  private skipped = 0;

  constructor(ctx: WorldContext<AgentWechatConfigSection>) {
    this.ctx = ctx;
    this.store = new WorldStore(ctx.dataDir);
  }

  private get cfg(): AgentWechatConfigSection {
    // ctx.cfg 是 worlds.agentwechat 的活引用：配置面板改完立刻能读到。
    return normalizeConfig(this.ctx.cfg);
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lastError = null;
    this.stuckKey = null;
    this.stuckCount = 0;
    this.skipped = 0;
    const cfg = this.cfg;
    if (!cfg.enabled) {
      this.sse = 'idle';
      return;
    }
    validateConfig(cfg);

    let token: string;
    try {
      token = this.ctx.secret(AGENTWECHAT_TOKEN_ENV);
    } catch {
      token = '';
    }
    if (!token) {
      throw new Error(`缺少 API Token：请在本 World 配置页写入 ${AGENTWECHAT_TOKEN_ENV}（不会写进 config.json，也不会出现在日志里）`);
    }

    this.client = new AgentWechatApiClient({
      baseUrl: cfg.baseUrl,
      token,
      caCertFile: cfg.caCertFile || undefined,
      timeoutMs: cfg.requestTimeoutMs,
    });
    this.identity = new IdentityMap(this.client, this.store, {
      warn: (message) => host.log.warn(message),
      debug: (message) => host.log.debug?.(message),
    });
    this.outbound = new Outbound({
      client: this.client,
      store: this.store,
      config: () => this.cfg,
      log: { info: (m) => host.log.info(m), warn: (m) => host.log.warn(m), debug: (m) => host.log.debug?.(m) },
    });
    // 语音转写复用应用自带的 sherpa-onnx + 桌宠那份 SenseVoiceSmall；模型懒加载（第一条语音才载入）。
    this.voice = new VoiceTranscriber({
      modelDir: () => this.cfg.voiceModelDir,
      defaultModelDir: defaultVoiceModelDir(this.ctx.dataDir),
      language: () => this.cfg.voiceLanguage,
      threads: () => 2,
      maxSeconds: () => this.cfg.voiceMaxSeconds,
      enabled: () => this.cfg.voiceToTextEnabled,
      log: { info: (m) => host.log.info(m), warn: (m) => host.log.warn(m), debug: (m) => host.log.debug?.(m) },
    });

    await this.refreshAccount();
    // 上次运行留下的"结果未知"发送，启动后补查一次；查到终态就订正本地记录。
    void this.reconcileSends();
    // 之后周期性补查：重启后新发的 queued 记录没人追，本地就会一直停在"未确认"。
    this.settleTimer = setInterval(() => {
      void this.reconcileSends();
    }, SETTLE_INTERVAL_MS);
    this.settleTimer.unref?.();

    if (!cfg.receiveEnabled) {
      this.sse = 'idle';
      return;
    }

    const inbound = new InboundHandler({
      client: this.client,
      host: () => this.host,
      config: () => this.cfg,
      store: this.store,
      identity: this.identity,
      worldId: this.id,
      log: { info: (m) => host.log.info(m), warn: (m) => host.log.warn(m), debug: (m) => host.log.debug?.(m) },
      onDelivered: (info) => {
        this.delivered += 1;
        this.lastEventAt = info.at;
      },
      transcribe: (input) => this.voice!.transcribe(input.bytes, input.key),
    });

    this.abort = new AbortController();
    this.pump = new EventPump({
      signal: this.abort.signal,
      reconnectMs: 1000,
      maxReconnectMs: cfg.reconnectMaxMs,
      log: { info: (m) => host.log.info(m), warn: (m) => host.log.warn(m), debug: (m) => host.log.debug?.(m) },
      cursor: () => this.store.cursor,
      onState: (state, detail) => {
        this.sse = state;
        // 连上了就把上次的断线/abort 痕迹清掉，否则面板会一直挂着一条早就恢复的错误。
        if (state === 'open') this.lastError = null;
        else if (state === 'error' && detail) this.lastError = detail;
        host.log.info(`事件流状态：${state}${detail ? `（${detail}）` : ''}`);
      },
      open: (after, signal) => this.client!.openEventStream(cfg.accountId, after, signal),
      onEvent: (event) => this.consume(event, inbound),
    });

    void this.pump.run().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.sse = 'error';
      host.log.error(`事件循环退出：${this.lastError}`);
    });
    host.log.info(`NAS 微信已启动：${cfg.baseUrl}（account=${cfg.accountId}）`);
  }

  private async consume(event: NativeEvent, inbound: InboundHandler): Promise<void> {
    // 「最后收到事件的时间」看的是流里真正来过的最后一条，不只看投递出去的：
    // 被过滤掉的消息（别人的私聊、没 @ 的群聊、自己发出的）也算收到过，面板不该显示（无）。
    this.lastEventAt = new Date().toISOString();
    this.lastEventKind = event.kind;
    const key = this.eventKey(event);
    const result = await inbound.handle(event);
    if (result.ok) {
      this.stuckKey = null;
      this.stuckCount = 0;
      await this.commit(event);
      return;
    }

    // 同一条消息连续失败才可能是"永远处理不了"（比如服务端 404、权限不足）；
    // 一次失败仍按原样抛出去重连，游标不动，重连后同一条会再来。
    const reason = result.reason ?? '处理事件失败';
    if (this.stuckKey === key) this.stuckCount += 1;
    else {
      this.stuckKey = key;
      this.stuckCount = 1;
    }
    if (this.stuckCount < MAX_EVENT_ATTEMPTS) throw new Error(reason);

    // 到这里说明同一条消息已经连续失败多次。继续卡着不动，后面所有消息都会被它堵死；
    // 所以明确跳过、记一条 error、把游标推过去，让流继续走（跳过是坏消息的代价，不是静默丢失）。
    this.skipped += 1;
    this.stuckKey = null;
    this.stuckCount = 0;
    this.lastError = `已跳过一条无法处理的消息（${key}）：${reason}`;
    this.host?.log.error(`事件 ${key} 连续处理失败 ${MAX_EVENT_ATTEMPTS} 次，跳过并推进游标：${reason}`);
    await this.commit(event);
  }

  /** 事件处理成功或被跳过后的收尾：落游标 + ack（ack 失败只提醒，不影响本地游标）。 */
  private async commit(event: NativeEvent): Promise<void> {
    this.store.setCursor(event.cursor);
    this.lastEventAt = new Date().toISOString();
    try {
      await this.client?.ackConsumer(this.cfg.accountId, AGENTWECHAT_CONSUMER, event.cursor);
    } catch (error) {
      this.host?.log.warn(`消费者 ack 失败（不影响本地游标）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private eventKey(event: NativeEvent): string {
    const messageId = event.data?.messageId;
    return typeof messageId === 'string' && messageId !== '' ? messageId : event.cursor;
  }

  private async refreshAccount(): Promise<void> {
    if (!this.client) return;
    try {
      const accounts = await this.client.accounts();
      const account = accounts.items.find((item) => item.id === this.cfg.accountId);
      this.accountOnline = account ? account.state !== 'offline' : null;
    } catch (error) {
      this.accountOnline = null;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * 补查上次留下的非终态发送。只读、只订正本地记录：查到 accepted/failed 就写回去，
   * 避免面板和 awx_status 一直停在"排队中"。
   */
  private async reconcileSends(): Promise<void> {
    const client = this.client;
    const accountId = this.cfg.accountId;
    if (!client || !accountId) return;
    const pending = this.store.unsettledSends(20);
    if (pending.length === 0) return;
    this.host?.log.info(`补查历史发送：${pending.length} 条未定论`);
    let settled = 0;
    for (const record of pending) {
      if (!record.sendId) continue;
      try {
        const send = await client.send(accountId, record.sendId);
        if (send.state === 'accepted' || send.state === 'failed' || send.state === 'needs_review') {
          this.store.saveSend({
            ...record,
            state: send.state,
            messageId: send.localMessageId ?? record.messageId,
          });
          settled += 1;
        }
      } catch (error) {
        this.host?.log.debug?.(`补查发送状态失败：${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (settled > 0) this.host?.log.info(`补查了 ${settled} 条历史发送的状态`);
  }

  async stop(): Promise<void> {
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.pump?.stop();
    this.pump = null;
    this.client?.destroy();
    this.client = null;
    // 语音模型几百 MB，停了就释放（sherpa-onnx-node 没有 free，靠 finalizer + gc）。
    this.voice?.dispose();
    this.voice = null;
    this.outbound = null;
    this.identity = null;
    this.host = null;
    this.sse = 'idle';
  }

  tools(): ToolDef[] {
    return buildTools({
      client: () => this.client,
      outbound: () => this.outbound,
      store: this.store,
      config: () => this.cfg,
      status: () => this.statusText(),
      log: { warn: (m) => this.host?.log.warn(m), debug: (m) => this.host?.log.debug?.(m) },
    });
  }

  envPromptVars(): Record<string, string> | null {
    // 环境提示词模板（src/ENV_PROMPT.md）里的占位符必须总能取到值，否则会把 {{…}} 原样塞进提示词。
    return { 'worlds.agentwechat.account': this.cfg.accountId || '（未配置）' };
  }

  webUi(language: Language): WorldWebUiDecl {
    const text = awxText(language);
    return {
      label: text.worldLabel,
      lamps: [
        { label: text.connection, state: this.accountOnline === null ? 'offline' : this.accountOnline ? 'online' : 'error', hint: this.lastError ?? undefined },
        { label: text.stream, state: this.lampState(), hint: this.sse },
      ],
      badges: [
        { label: text.threads, value: this.store.threads().length },
        { label: text.cursor, value: this.store.cursor ?? '-' },
      ],
      panels: [
        { id: 'status', title: text.settings, getMethods: ['snapshot'] },
        { id: 'threads', title: text.threads, getMethods: ['list'] },
      ],
      promptDocs: [{
        key: 'worlds.agentwechat.envPrompt',
        title: text.promptTitle,
        description: text.promptDescription,
        role: 'envPrompt',
        path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
        vars: [{ name: 'worlds.agentwechat.account', description: text.account, multiline: false }],
      }],
      invoke: async (panel, method, args) => {
        if (panel === 'threads' && method === 'list') return { items: this.threadList() };
        if (panel !== 'status') return undefined;
        if (method === 'snapshot') return this.snapshot();
        if (method === 'setToken') {
          // 令牌只进部署 .env（仅本人可读），不写 config.json，也不会回显。
          const token = typeof args[0] === 'string' ? args[0].trim() : '';
          if (!token) throw new Error('令牌不能为空');
          this.ctx.storeSecret(AGENTWECHAT_TOKEN_ENV, token);
          void this.ctx.restart();
          return { configured: true, restarting: true };
        }
        if (method === 'reconnect') {
          void this.ctx.restart();
          return { restarting: true };
        }
        return undefined;
      },
      config: [agentWechatConfigGroup(language)],
    };
  }

  private lampState(): 'online' | 'loading' | 'error' | 'offline' {
    if (!this.cfg.enabled) return 'offline';
    if (this.sse === 'open') return 'online';
    if (this.sse === 'connecting' || this.sse === 'idle') return 'loading';
    if (this.sse === 'error') return 'error';
    return 'offline';
  }

  snapshot(): Record<string, unknown> {
    return {
      enabled: this.cfg.enabled,
      baseUrl: this.cfg.baseUrl,
      accountId: this.cfg.accountId,
      accountOnline: this.accountOnline,
      sse: this.sse,
      cursor: this.store.cursor,
      lastEventAt: this.lastEventAt,
      lastEventKind: this.lastEventKind,
      lastError: this.lastError,
      delivered: this.delivered,
      skipped: this.skipped,
      lastSend: this.lastSend,
      voice: this.voice ? this.voice.stats() : { enabled: false },
      threads: this.store.threads().length,
      threadList: this.threadList(),
    };
  }

  /** 面板用：每个微信会话一行，含类型与最近活动——用来肉眼确认"各自独立"。 */
  threadList(): Array<Record<string, unknown>> {
    return this.store
      .threads()
      .map((record) => ({
        threadId: record.threadId,
        kind: record.threadType,
        name: record.threadType === 'group' ? (record.groupName ?? record.displayName ?? '') : (record.displayName ?? ''),
        session: sessionIdFor({ threadId: record.threadId }),
        lastSeenAt: record.lastSeenAt ?? null,
        lastDeliveredAt: record.lastDeliveredAt ?? null,
        lastMessageId: record.lastMessageId ?? null,
      }))
      .sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
  }

  /** 一行话讲清语音转写现在能不能用：未启用 / 已就绪 / 等载入 / 上次失败。 */
  private voiceLine(): string {
    const stats = this.voice?.stats();
    if (!stats) return '未接入';
    if (!stats.enabled) return '未启用';
    const state = stats.ready ? '已就绪' : '等第一条语音时载入';
    const model = stats.model ?? `${stats.modelDir}（找不到模型文件）`;
    const failure = stats.lastError ? `；上次失败：${stats.lastError}` : '';
    return `${state}（${stats.language}、${model}、已转 ${stats.done} 条${failure}）`;
  }

  statusText(): string {
    const cfg = this.cfg;
    const lines = [
      `启用：${cfg.enabled ? '是' : '否'}`,
      `地址：${cfg.baseUrl || '（未配置）'}`,
      `账号：${cfg.accountId || '（未配置）'}（${this.accountOnline === null ? '状态未知' : this.accountOnline ? '在线' : '异常'}）`,
      `事件流：${this.sse}`,
      `游标：${this.store.cursor ?? '（尚未消费）'}`,
      `最近事件：${this.lastEventAt ?? '（无）'}`,
      `已投递：${this.delivered}`,
      `语音转写：${this.voiceLine()}`,
      `最后错误：${this.lastError ?? '（无）'}`,
    ];
    if (this.lastSend) {
      lines.push(`最近发送：${this.lastSend.state}${this.lastSend.sendId ? `（sendId=${this.lastSend.sendId}）` : ''}${this.lastSend.error ? ` ${this.lastSend.error}` : ''}`);
    }
    return lines.join('\n');
  }
}

export function knownThreadHint(sessionId: string): string | null {
  return threadIdHintFromSession(sessionId);
}
