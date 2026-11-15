/**
 * SSE 读取与断线续传。
 * 只做"把字节变成事件"和"按游标重连"两件事；处理成功后的位点保存由调用方负责，
 * 位点通过在 `onEvent` 成功返回之后调用 `cursor()` 反映，重连一律从它续上。
 */
import type { IncomingMessage } from 'node:http';
import type { NativeEvent } from './types.ts';

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/** 按 SSE 规范解析一个流；心跳注释（`:` 开头）会被忽略。 */
export async function* readSse(res: IncomingMessage): AsyncGenerator<SseFrame> {
  res.setEncoding('utf8');
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];

  const flush = (): SseFrame | null => {
    // `id` 是粘性的（SSE 规范），不能拿它判断"这一帧有没有内容"；只有 data/event 才算。
    if (data.length === 0 && !event) return null;
    const frame: SseFrame = { data: data.join('\n'), id, event, retry };
    data = [];
    event = undefined;
    retry = undefined;
    return frame;
  };

  for await (const chunk of res as AsyncIterable<string>) {
    buffer += chunk;
    let index = buffer.search(/\r\n|\n|\r/);
    while (index >= 0) {
      const line = buffer.slice(0, index);
      const width = buffer.startsWith('\r\n', index) ? 2 : 1;
      buffer = buffer.slice(index + width);
      if (line === '') {
        const frame = flush();
        if (frame) yield frame;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = raw;
        else if (field === 'data') data.push(raw);
        else if (field === 'id') id = raw;
        else if (field === 'retry') {
          const value = Number.parseInt(raw, 10);
          if (Number.isFinite(value) && value >= 0) retry = value;
        }
      }
      index = buffer.search(/\r\n|\n|\r/);
    }
  }
  const tail = flush();
  if (tail) yield tail;
}

export interface EventPumpOptions {
  /** 打开流；`after` 为 null 表示不带游标。 */
  open(after: string | null, signal: AbortSignal): Promise<IncomingMessage>;
  /** 一条事件；抛错视为本次处理失败（不会推进游标）。 */
  onEvent(event: NativeEvent): Promise<void> | void;
  /** 已经成功处理到的游标。 */
  cursor(): string | null;
  onState(state: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void;
  log: { info(message: string): void; warn(message: string): void; debug?(message: string): void };
  reconnectMs: number;
  maxReconnectMs: number;
  signal: AbortSignal;
}

const IDLE_CLOSE_MS = 90_000;

/** 一条长连接的生命周期：连接 → 收事件 → 断了退避重连，直到 signal 中止。 */
export class EventPump {
  private socket: IncomingMessage | null = null;
  private stopped = false;

  constructor(private readonly options: EventPumpOptions) {}

  /** 停止并断开当前连接（World 停用时调用）。 */
  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
  }

  async run(): Promise<void> {
    let backoff = this.options.reconnectMs;
    while (!this.stopped && !this.options.signal.aborted) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.options.signal.addEventListener('abort', abort, { once: true });
      let idle: NodeJS.Timeout | undefined;
      try {
        this.options.onState('connecting');
        const res = await this.options.open(this.options.cursor(), controller.signal);
        this.socket = res;
        this.options.onState('open');
        backoff = this.options.reconnectMs;
        idle = setTimeout(() => {
          this.options.log.warn('事件流长时间无数据，主动重连');
          res.destroy();
        }, IDLE_CLOSE_MS);
        idle.unref?.();
        for await (const frame of readSse(res)) {
          if (this.stopped) return;
          idle.refresh?.();
          if (!frame.data) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            this.options.log.warn('收到无法解析的事件帧，已跳过');
            continue;
          }
          const event = asNativeEvent(payload, frame.id);
          if (!event) continue;
          // 处理失败直接抛出：游标不前进，重连后这条会再来一次。
          await this.options.onEvent(event);
        }
        if (!this.stopped) this.options.onState('closed', 'stream ended');
      } catch (error) {
        if (this.stopped || this.options.signal.aborted) return;
        this.options.onState('error', error instanceof Error ? error.message : String(error));
      } finally {
        if (idle) clearTimeout(idle);
        this.options.signal.removeEventListener('abort', abort);
        this.socket?.destroy();
        this.socket = null;
      }
      if (this.stopped || this.options.signal.aborted) return;
      await sleep(backoff + Math.floor(Math.random() * 250));
      backoff = Math.min(Math.round(backoff * 1.6), this.options.maxReconnectMs);
    }
  }
}

function asNativeEvent(payload: unknown, frameId?: string): NativeEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const cursor = typeof raw.cursor === 'string' ? raw.cursor : frameId;
  const kind = typeof raw.kind === 'string' ? raw.kind : typeof raw.event === 'string' ? raw.event : null;
  if (!cursor || !kind) return null;
  return {
    cursor,
    kind,
    data: (typeof raw.data === 'object' && raw.data !== null ? raw.data : {}) as Record<string, unknown>,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
