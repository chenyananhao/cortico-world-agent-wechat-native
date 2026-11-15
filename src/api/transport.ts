/**
 * HTTP 传输层：只用 `node:https`，从不关闭证书校验。
 * 系统信任库由 Core 进程（`--use-system-ca`）负责；`caCertFile` 用于额外追加一条 CA（PEM）。
 * 令牌只出现在 Authorization 头里，任何错误信息都不带它。
 */
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest, type IncomingMessage } from 'node:https';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'timeout' | 'auth' | 'forbidden' | 'not-found' | 'conflict' | 'http' | 'tls',
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 认证/权限类错误要人动手（换令牌、加权限），不是重试能解决的。 */
  get needsOperator(): boolean {
    return this.kind === 'auth' || this.kind === 'forbidden' || this.kind === 'tls';
  }
}

export interface TransportOptions {
  baseUrl: string;
  token: string;
  caCertFile?: string;
  timeoutMs: number;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 覆盖本次超时（媒体上传/下载常更慢）。 */
  timeoutMs?: number;
  /** 原始字节体（上传用）。 */
  raw?: Uint8Array;
  contentType?: string;
}

interface Resolved {
  url: URL;
  agent: Agent;
  token: string;
  timeoutMs: number;
}

/** 一次构造、多次请求；`baseUrl` 变化时重建（World 重启即可）。 */
export class Transport {
  private resolved: Resolved;

  constructor(private readonly options: TransportOptions) {
    this.resolved = this.resolve();
  }

  private resolve(): Resolved {
    let url: URL;
    try {
      url = new URL(this.options.baseUrl);
    } catch {
      throw new ApiError(`baseUrl 不是合法 URL`, 'network');
    }
    if (url.protocol !== 'https:') throw new ApiError('baseUrl 必须是 https://，不会跳过证书校验', 'tls');
    // 末尾斜杠统一去掉，路径拼接收敛在一处。
    url.pathname = url.pathname.replace(/\/+$/, '');
    const ca = this.options.caCertFile ? [readFileSync(this.options.caCertFile, 'utf8')] : undefined;
    return {
      url,
      // keep-alive 复用连接；rejectUnauthorized 保持缺省 true，绝不改成 false。
      agent: new Agent({ keepAlive: true, maxSockets: 8, ...(ca ? { ca } : {}) }),
      token: this.options.token,
      timeoutMs: this.options.timeoutMs,
    };
  }

  /** 用新配置重建（配置热更新后调用）。 */
  reconfigure(options: TransportOptions): void {
    this.destroy();
    (this as { options: TransportOptions }).options = options;
    this.resolved = this.resolve();
  }

  destroy(): void {
    this.resolved?.agent.destroy();
  }

  url(path: string): URL {
    const { url } = this.resolved;
    return new URL(`${url.pathname}${path.startsWith('/') ? path : `/${path}`}`, url);
  }

  /** 打开一个流式响应（SSE 用）；调用方负责 `.resume()`/`destroy()`。 */
  openStream(path: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<IncomingMessage> {
    return this.send('GET', path, { headers, signal, stream: true }) as Promise<IncomingMessage>;
  }

  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send('GET', path, options) as Promise<T>;
  }

  async sendJson<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.send(method, path, options) as Promise<T>;
  }

  /**
   * 取原始字节（媒体内容）。超过上限直接报错，而不是把内存吃光 ——
   * 大文件应当走 daemon 的 Range 分片，这里只负责"能读到的整块"。
   */
  download(path: string, options: RequestOptions = {}): Promise<{ bytes: Uint8Array; mime: string }> {
    const { agent, token, timeoutMs } = this.resolved;
    const target = this.url(path);
    const limit = options.timeoutMs ?? Math.max(timeoutMs, 120_000);
    const maxBytes = 64 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: '*/*', ...(options.headers ?? {}) },
          agent,
          rejectUnauthorized: true,
        },
        (res) => {
          if (!res.statusCode || res.statusCode >= 400) {
            readBody(res).then((text) => reject(httpError(res.statusCode ?? 0, text)), () => reject(new ApiError('下载失败', 'network')));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let overflow = false;
          res.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maxBytes) {
              overflow = true;
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (timer) clearTimeout(timer);
            if (overflow) {
              reject(new ApiError(`媒体超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`, 'http', res.statusCode));
              return;
            }
            resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), mime: String(res.headers['content-type'] ?? 'application/octet-stream') });
          });
          res.on('error', (e: Error) => reject(new ApiError(`下载中断：${e.message}`, 'network')));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        reject(new ApiError('下载超时', 'timeout'));
      }, limit);
      timer.unref?.();
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer);
        const code = error.code ?? '';
        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
          reject(new ApiError(`TLS 证书校验失败（${code}）`, 'tls'));
          return;
        }
        reject(new ApiError(`下载连接失败（${code || error.message}）`, 'network'));
      });
      req.end();
    });
  }

  private send(
    method: string,
    path: string,
    options: RequestOptions & { stream?: boolean },
  ): Promise<unknown> {
    const { agent, token, timeoutMs } = this.resolved;
    const target = this.url(path);
    const body = this.bodyOf(options);
    const headers: Record<string, string> = {
      accept: options.stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': options.contentType ?? 'application/json', 'content-length': String(body.byteLength) } : {}),
      ...(options.headers ?? {}),
    };
    const limit = options.timeoutMs ?? timeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: ApiError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          agent,
          // 证书校验永远开启：这里不提供关闭的开关。
          rejectUnauthorized: true,
        },
        (res) => {
          if (options.stream) {
            if (!res.statusCode || res.statusCode >= 400) {
              readBody(res).then((text) => {
                fail(httpError(res.statusCode ?? 0, text));
                res.resume();
              }, () => fail(new ApiError('读取错误响应失败', 'network')));
              return;
            }
            settled = true;
            resolve(res);
            return;
          }
          readBody(res).then((text) => {
            if (settled) return;
            if (!res.statusCode || res.statusCode >= 400) {
              settled = true;
              reject(httpError(res.statusCode ?? 0, text));
              return;
            }
            settled = true;
            if (!text) return resolve(undefined);
            try {
              resolve(JSON.parse(text) as unknown);
            } catch {
              reject(new ApiError(`响应不是 JSON（${text.slice(0, 120)}）`, 'http', res.statusCode));
            }
          }, (e: Error) => fail(new ApiError(`读取响应失败：${e.message}`, 'network')));
        },
      );

      // 普通请求要总超时；SSE 长连接不能有——否则连上 20 秒就被自己掐断再重连。
      // 流的中断交给 signal 取消和 EventPump 的空闲重连兜底。
      let timer: NodeJS.Timeout | undefined;
      if (!options.stream) {
        timer = setTimeout(() => {
          req.destroy();
          fail(new ApiError(`请求超时（${limit}ms）：${method} ${target.pathname}`, 'timeout'));
        }, limit);
        timer.unref?.();
      }

      const onAbort = () => {
        req.destroy();
        fail(new ApiError('请求已取消', 'network'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      req.on('error', (error: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const code = error.code ?? '';
        // 证书类错误单列：这是要人去信任 CA 的问题，不是网络抖动。
        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
          fail(new ApiError(`TLS 证书校验失败（${code}）。把签发它的 CA 放进 Windows 信任库，或在 caCertFile 指定 PEM。`, 'tls'));
          return;
        }
        fail(new ApiError(`连接失败（${code || error.message}）`, 'network'));
      });

      req.on('close', () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      });

      if (body) req.write(body);
      req.end();
    });
  }

  private bodyOf(options: RequestOptions): Buffer | undefined {
    if (options.raw) return Buffer.from(options.raw);
    if (options.body === undefined) return undefined;
    return Buffer.from(JSON.stringify(options.body), 'utf8');
  }
}

function httpError(status: number, text: string): ApiError {
  const { code, message } = parseError(text);
  const suffix = code ? `（${code}）` : '';
  const detail = message ? `：${message}` : '';
  if (status === 401) return new ApiError(`令牌被拒绝${suffix}${detail}`, 'auth', status, code);
  if (status === 403) return new ApiError(`权限不足${suffix}${detail}`, 'forbidden', status, code);
  if (status === 404) return new ApiError(`资源不存在${suffix}${detail}`, 'not-found', status, code);
  if (status === 409) return new ApiError(`冲突${suffix}${detail}`, 'conflict', status, code);
  return new ApiError(`HTTP ${status}${suffix}${detail}`, 'http', status, code);
}

function parseError(text: string): { code?: string; message?: string } {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown };
    const error = typeof parsed.error === 'object' && parsed.error !== null ? (parsed.error as Record<string, unknown>) : parsed;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const message = typeof error.message === 'string' ? error.message : undefined;
    // 真机常常只给 code（如 invalid_request），把原始响应体带一小段，否则错误信息等于没有。
    if (!message && code) return { code, message: text.length > 120 ? `${text.slice(0, 120)}…` : text };
    return { code, message };
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      // 错误响应与普通 JSON 都远小于这个量；超了直接截断，避免无限缓冲。
      if (size <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}
