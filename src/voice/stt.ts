/**
 * 语音转文字：把微信语音（daemon 已转成 16 kHz 单声道 PCM16 WAV）交给 Coopanion 自带的
 * `sherpa-onnx-node` + SenseVoiceSmall 识别，得到一段文字。
 *
 * 为什么复用而不是自带模型：桌宠语音输入已经在跑同一套运行时和同一份模型
 * （`data/home/models/desktop-pet/sensevoice-small-int8-2024-07-17`），再下一份几百 MB 的模型
 * 没有意义，也会让"单一 AI 大脑"多出一个不认识的分支。
 *
 * 三个必须处理的现实：
 * 1. `sherpa-onnx-node` 是**应用自己的依赖**（`<app>/node_modules`）。本扩展装在
 *    `data/extensions` 下，向上找不到它，所以用 `createRequire(<app>/package.json)` 指定解析根。
 * 2. 模型只能整句识别；这里一次性喂完，异步解码（`decodeAsync`），不阻塞事件循环。
 * 3. 失败必须说清楚卡在哪，绝不返回空字符串冒充"听不清"——调用方据此把原因写进正文。
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 语音识别模型要求的采样率。 */
const SAMPLE_RATE = 16_000;

/** sherpa-onnx-node 里用到的那一小部分（测试可注入假实现）。 */
export interface SherpaRecognizer {
  createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void };
  decodeAsync(stream: unknown): Promise<{ text?: string }>;
}

export interface SherpaModule {
  OfflineRecognizer: { createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer> };
}

export interface VoiceLog {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

export interface VoiceTranscriberOptions {
  /** 配置里的模型目录；空字符串表示用默认路径。 */
  modelDir: () => string;
  /** 默认的模型目录（部署 data 目录下的桌宠模型）。 */
  defaultModelDir: string;
  /** ISO 639-1 或 `auto`。 */
  language: () => string;
  /** 解码线程数。 */
  threads: () => number;
  /** 超过这个时长的语音不转写（只报时长）。 */
  maxSeconds: () => number;
  /** 总开关；关闭时 `transcribe` 直接给出原因。 */
  enabled: () => boolean;
  log: VoiceLog;
  /** 注入点：返回模块或失败原因。默认按应用目录解析。 */
  load?: () => { module: SherpaModule; from: string } | { error: string };
}

export interface Transcript {
  ok: boolean;
  /** 成功时的文字；失败时为空。 */
  text: string;
  /** 失败原因（给人看的，会进正文/面板）。 */
  error?: string;
  /** 解码耗时。 */
  ms: number;
}

export interface VoiceStats {
  enabled: boolean;
  /** 识别器是否已经载入。 */
  ready: boolean;
  modelDir: string;
  model: string | null;
  language: string;
  threads: number;
  lastError: string | null;
  lastMs: number;
  /** 已经转写过的条数（含缓存命中）。 */
  done: number;
}

/** SenseVoice 认这几种语言，其它一律交给它自己判断。 */
const LANGUAGES = new Set(['zh', 'en', 'ja', 'ko', 'yue']);

export class VoiceTranscriber {
  private rec: SherpaRecognizer | null = null;
  private loadedSignature = '';
  private loading: Promise<SherpaRecognizer> | null = null;
  private lastError: string | null = null;
  private lastMs = 0;
  private done = 0;
  /** 一次只解一条：原生解码吃 CPU，并发只会互相拖慢。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 同一条语音被重放时不重跑推理（约 228 MB 模型，一次解码几百毫秒起）。 */
  private readonly cache = new Map<string, Transcript>();

  constructor(private readonly opts: VoiceTranscriberOptions) {}

  stats(): VoiceStats {
    const modelDir = this.modelDir();
    return {
      enabled: this.opts.enabled(),
      ready: this.rec !== null,
      modelDir,
      model: modelFile(modelDir)?.path ?? null,
      language: this.language(),
      threads: Math.max(1, Math.min(8, Math.trunc(this.opts.threads() || 2))),
      lastError: this.lastError,
      lastMs: this.lastMs,
      done: this.done,
    };
  }

  /**
   * 转写一段音频（WAV）。永远不抛：失败返回 `ok:false` + 原因。
   * `key` 用来做缓存（一般给 `${messageId}|${assetId}`）。
   */
  transcribe(bytes: Uint8Array, key?: string): Promise<Transcript> {
    const cached = key ? this.cache.get(key) : undefined;
    if (cached) return Promise.resolve(cached);
    const run = this.chain.then(
      () => this.run(bytes, key),
      () => this.run(bytes, key),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 释放识别器。sherpa-onnx-node 没有 free 接口，只能靠 finalizer；进程带 --expose-gc 时提前回收。 */
  dispose(): void {
    this.rec = null;
    this.loadedSignature = '';
    this.loading = null;
    this.cache.clear();
    (globalThis as { gc?: () => void }).gc?.();
  }

  private async run(bytes: Uint8Array, key?: string): Promise<Transcript> {
    const started = Date.now();
    const done = (result: Transcript): Transcript => {
      this.lastMs = Date.now() - started;
      this.lastError = result.ok ? null : (result.error ?? '转写失败');
      if (result.ok) this.done += 1;
      if (key) {
        this.cache.set(key, result);
        // 只留最近 50 条，避免无限长。
        while (this.cache.size > 50) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
      }
      return result;
    };

    if (!this.opts.enabled()) return done({ ok: false, text: '', error: '语音转写未启用', ms: 0 });

    const parsed = parseWav(bytes);
    if ('error' in parsed) return done({ ok: false, text: '', error: parsed.error, ms: 0 });
    const seconds = parsed.samples.length / SAMPLE_RATE;
    const limit = this.opts.maxSeconds();
    if (limit > 0 && seconds > limit) {
      return done({ ok: false, text: '', error: `语音 ${seconds.toFixed(1)} 秒，超过 ${limit} 秒上限，未转写`, ms: 0 });
    }

    let rec: SherpaRecognizer;
    try {
      rec = await this.ensureRecognizer();
    } catch (error) {
      return done({ ok: false, text: '', error: describe(error), ms: 0 });
    }

    try {
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: parsed.samples });
      const result = await rec.decodeAsync(stream);
      const text = (result.text ?? '').trim();
      if (text === '') return done({ ok: false, text: '', error: '没听出文字（可能是静音、太短或纯噪声）', ms: 0 });
      return done({ ok: true, text, ms: 0 });
    } catch (error) {
      return done({ ok: false, text: '', error: `识别失败：${describe(error)}`, ms: 0 });
    }
  }

  private language(): string {
    const value = String(this.opts.language() ?? '').trim();
    return LANGUAGES.has(value) ? value : 'auto';
  }

  private modelDir(): string {
    const configured = String(this.opts.modelDir() ?? '').trim();
    return resolve(configured !== '' ? configured : this.opts.defaultModelDir);
  }

  private async ensureRecognizer(): Promise<SherpaRecognizer> {
    if (this.rec) return this.rec;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<SherpaRecognizer> {
    const modelDir = this.modelDir();
    if (!existsSync(modelDir)) throw new Error(`模型目录不存在：${modelDir}`);
    const model = modelFile(modelDir);
    if (!model) throw new Error(`模型目录里找不到 .onnx：${modelDir}`);
    const tokens = join(modelDir, 'tokens.txt');
    if (!existsSync(tokens)) throw new Error(`模型目录里缺少 tokens.txt：${modelDir}`);

    const language = this.language();
    const threads = Math.max(1, Math.min(8, Math.trunc(this.opts.threads() || 2)));
    const signature = `${model.path}/${language}/${threads}`;
    if (this.loadedSignature === signature && this.rec) return this.rec;

    const loaded = (this.opts.load ?? defaultLoad)();
    if ('error' in loaded) throw new Error(loaded.error);
    const started = Date.now();
    const rec = await loaded.module.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: model.path, language, useInverseTextNormalization: 1 },
        tokens,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    });
    this.rec = rec;
    this.loadedSignature = signature;
    this.opts.log.info(`语音模型已载入：${model.name}（${Date.now() - started} ms，来自 ${loaded.from}）`);
    return rec;
  }
}

/**
 * 按应用目录解析 `sherpa-onnx-node`：扩展自己被安装在 `data/extensions` 下，
 * 普通 `createRequire(import.meta.url)` 一定找不到应用自带的这份依赖。
 */
export function loadFromApp(): { module: SherpaModule; from: string } | { error: string } {
  const tried: string[] = [];
  for (const root of appRoots()) {
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    if (!existsSync(join(root, 'node_modules', 'sherpa-onnx-node'))) {
      tried.push(`${root}（没有 node_modules/sherpa-onnx-node）`);
      continue;
    }
    try {
      const module = createRequire(manifest)('sherpa-onnx-node') as SherpaModule;
      return { module, from: root };
    } catch (error) {
      tried.push(`${root}（${describe(error)}）`);
    }
  }
  return { error: `找不到 sherpa-onnx-node：试过 ${tried.length > 0 ? tried.join('；') : '（没有可用的应用目录）'}` };
}

const defaultLoad = loadFromApp;

/** 候选应用目录：环境变量优先，其次从可执行文件推，最后是当前工作目录。 */
function appRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.CORTICO_APP_ROOT ?? process.env.CORTICO_RESOURCES ?? '';
  if (env.trim() !== '') roots.push(resolve(env.trim()));
  const exe = dirname(process.execPath);
  roots.push(join(exe, 'resources', 'app'));
  // 便携版/绿色版：可执行文件与 resources 同级
  roots.push(join(exe, '..', 'resources', 'app'));
  roots.push(join(process.cwd(), 'resources', 'app'));
  return [...new Set(roots)];
}

/** 模型目录里挑一个 .onnx：优先 int8（桌宠下发的就是这个），否则取第一个。 */
function modelFile(modelDir: string): { path: string; name: string } | null {
  let names: string[];
  try {
    names = readdirSync(modelDir).filter((name) => name.toLowerCase().endsWith('.onnx'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  names.sort((a, b) => Number(b.includes('int8')) - Number(a.includes('int8')) || a.localeCompare(b));
  return { path: join(modelDir, names[0]!), name: names[0]! };
}

/**
 * WAV → 16 kHz 单声道 Float32。
 * daemon 给的语音是 PCM16 单声道 16 kHz（实测 65 964 B ≈ 2.06 s），所以这里只做必要的兜底：
 * 双声道降混、其它采样率线性重采样；8 位/浮点等少见格式直接说明不支持，而不是瞎猜。
 */
export function parseWav(bytes: Uint8Array): { samples: Float32Array } | { error: string } {
  if (bytes.byteLength < 44) return { error: '音频太短，不是完整的 WAV' };
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WAVE') {
    return { error: '音频不是 WAV 格式（没有 RIFF/WAVE 头）' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(bytes, at, at + 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === 'data') {
      dataAt = at + 8;
      dataLength = Math.min(size, bytes.byteLength - dataAt);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0 || dataLength <= 0) return { error: 'WAV 里没有音频数据块' };
  // 1 = PCM，0xFFFE = WAVE_FORMAT_EXTENSIBLE（里面仍是 PCM）
  if (format !== 1 && format !== 0xFFFE) return { error: `不支持的 WAV 编码（format=${format}），只认 PCM` };
  if (bits !== 16) return { error: `不支持的采样位深（${bits} 位），只认 16 位 PCM` };
  if (channels < 1 || sampleRate < 8_000) return { error: `WAV 头不合理（${channels} 声道 / ${sampleRate} Hz）` };

  const frames = Math.floor(dataLength / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += view.getInt16(dataAt + (i * channels + c) * 2, true);
    mono[i] = sum / channels / 32768;
  }
  return { samples: sampleRate === SAMPLE_RATE ? mono : resample(mono, sampleRate, SAMPLE_RATE) };
}

/** 线性插值重采样（语音够用；只在采样率不是 16 kHz 时才走这里）。 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (input.length === 0 || from === to) return input;
  const ratio = to / from;
  const length = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const at = i / ratio;
    const low = Math.floor(at);
    const high = Math.min(input.length - 1, low + 1);
    const frac = at - low;
    out[i] = (input[low] ?? 0) * (1 - frac) + (input[high] ?? 0) * frac;
  }
  return out;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let text = '';
  for (let i = from; i < to && i < bytes.byteLength; i += 1) text += String.fromCharCode(bytes[i]!);
  return text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
