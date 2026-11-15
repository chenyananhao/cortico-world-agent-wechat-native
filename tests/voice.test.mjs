/**
 * 语音转文字：WAV 解析、转写失败不出空话、真机那种"双音轨（available + pending）"只取可读的。
 * 模型本体（228 MB）不在这里加载：真实识别由 Coopanion 自带的 sherpa-onnx 做，
 * 测试用假 transcriber 断言接线与降级行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentWechatApiClient } from '../src/api/client.ts';
import { AGENTWECHAT_DEFAULTS } from '../src/config.ts';
import { WorldStore } from '../src/identity/store.ts';
import { IdentityMap } from '../src/identity/mapping.ts';
import { InboundHandler } from '../src/messaging/inbound.ts';
import { parseWav } from '../src/voice/stt.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');
const silentLog = { info() {}, warn() {}, debug() {} };

/** 造一段 WAV：samples 个 16 位样本，channels 声道，rate 采样率。 */
function wav({ seconds = 0.5, rate = 16000, channels = 1 } = {}) {
  const frames = Math.round(seconds * rate);
  const dataLength = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000);
    for (let c = 0; c < channels; c += 1) buffer.writeInt16LE(value, 44 + (i * channels + c) * 2);
  }
  return new Uint8Array(buffer);
}

const voiceWav = wav({ seconds: 0.5 });
const pendingBytes = new TextEncoder().encode('不该被取的内容');

const messages = {
  m_voice: {
    id: 'm_voice', accountId: 'account-1', threadId: 'wxid_a', serverId: 's1', senderId: 'wxid_a',
    type: 34, direction: 'incoming', body: null, createdAt: '2026-11-15T12:00:00.000Z', version: 1, media: [],
  },
  m_voice_short: {
    id: 'm_voice_short', accountId: 'account-1', threadId: 'wxid_a', serverId: 's2', senderId: 'wxid_a',
    type: 34, direction: 'incoming', body: null, createdAt: '2026-11-15T12:00:01.000Z', version: 1, media: [],
  },
};

/** 真机形状：同一条语音列出两份音轨，先 pending 后 available。 */
const media = {
  m_voice: [
    { id: 'asset_pending', state: 'pending', contentType: null, byteLength: null },
    { id: 'asset_voice', state: 'available', contentType: 'audio/wav', byteLength: voiceWav.byteLength },
  ],
  m_voice_short: [
    { id: 'asset_voice_short', state: 'available', contentType: 'audio/wav', byteLength: voiceWav.byteLength },
  ],
};

const mediaContent = {
  asset_pending: { bytes: pendingBytes, mime: 'audio/wav' },
  asset_voice: { bytes: voiceWav, mime: 'audio/wav' },
  asset_voice_short: { bytes: voiceWav, mime: 'audio/wav' },
};

async function setup({ transcribe, overrides = {} } = {}) {
  const api = await startMockApi({
    messages, media, mediaContent,
    ownUsername: 'wxid_self',
    selfContact: { id: 'wxid_self', displayName: '一条大肥鱼', nickname: '一条大肥鱼', remark: null },
  });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-voice-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 5000 });
  const identity = new IdentityMap(client, store, silentLog);
  const config = {
    ...AGENTWECHAT_DEFAULTS,
    enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', receiveEnabled: true,
    directMessagesEnabled: true, mediaEnabled: true, voiceToTextEnabled: true,
    ...overrides,
  };
  const pushed = [];
  const calls = [];
  const host = {
    pushEvent(event, options) {
      pushed.push({ event, options });
      return { ok: true, cursor: pushed.length };
    },
  };
  const inbound = new InboundHandler({
    client, host: () => host, config: () => config, store, identity,
    worldId: 'agentwechat', log: silentLog, onDelivered: () => {},
    ...(transcribe === null
      ? {}
      : {
          transcribe: async (input) => {
            calls.push(input);
            return transcribe(input);
          },
        }),
  });
  const event = (messageId, cursor = '1') => ({
    cursor, kind: 'message.committed', data: { messageId, threadId: 'wxid_a' }, createdAt: '2026-11-15T12:00:00.000Z',
  });
  return { api, store, config, pushed, calls, inbound, event, close: () => api.close() };
}

test('WAV 解析：16 kHz 单声道原样进模型，8 kHz 会重采样，非 PCM 直接说明', () => {
  const mono = parseWav(wav({ seconds: 0.25, rate: 16000 }));
  assert.ok(!('error' in mono));
  assert.equal(mono.samples.length, 4000);

  const eightK = parseWav(wav({ seconds: 0.25, rate: 8000 }));
  assert.ok(!('error' in eightK));
  assert.equal(eightK.samples.length, 4000); // 8 kHz 0.25 s = 2000 帧 → 16 kHz 4000 帧

  const stereo = parseWav(wav({ seconds: 0.25, rate: 16000, channels: 2 }));
  assert.ok(!('error' in stereo));
  assert.equal(stereo.samples.length, 4000);

  const junk = parseWav(new Uint8Array(100));
  assert.ok('error' in junk);
  assert.match(String(junk.error), /WAV|RIFF/);
});

test('语音消息：转写结果进正文，并带上 meta.transcript', async () => {
  const ctx = await setup({ transcribe: () => ({ ok: true, text: '明天下午三点开会' }) });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_voice'));
    assert.deepEqual([result.ok, result.delivered], [true, true]);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].key, 'm_voice|asset_voice'); // pending 那份不转
    assert.equal(ctx.calls[0].mime, 'audio/wav');
    const { event, options } = ctx.pushed[0];
    assert.match(event.text, /（语音）明天下午三点开会/);
    assert.equal(event.meta.transcript, '明天下午三点开会');
    assert.equal(options.session, 'wechat-wxid_a');
  } finally {
    await ctx.close();
  }
});

test('语音消息：真机双音轨里只取 available 那条（pending 不碰）', async () => {
  const ctx = await setup({ transcribe: (input) => ({ ok: true, text: `字节数=${input.bytes.byteLength}` }) });
  try {
    await ctx.inbound.handle(ctx.event('m_voice'));
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].bytes.byteLength, voiceWav.byteLength);
    assert.notEqual(ctx.calls[0].bytes.byteLength, pendingBytes.byteLength);
  } finally {
    await ctx.close();
  }
});

test('转写失败：消息照投，正文写明原因，不出现空正文', async () => {
  const ctx = await setup({ transcribe: () => ({ ok: false, error: '模型目录不存在：D:/nope' }) });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_voice'));
    assert.deepEqual([result.ok, result.delivered], [true, true]);
    const { event } = ctx.pushed[0];
    assert.match(event.text, /（语音，模型目录不存在：D:\/nope）/);
    assert.match(event.text, /私聊：/);
    assert.equal(event.meta.transcript, undefined);
  } finally {
    await ctx.close();
  }
});

test('转写关闭：不调用转写器，正文说明未启用', async () => {
  const ctx = await setup({ transcribe: () => ({ ok: true, text: '不该出现' }), overrides: { voiceToTextEnabled: false } });
  try {
    await ctx.inbound.handle(ctx.event('m_voice'));
    assert.equal(ctx.calls.length, 0);
    assert.match(ctx.pushed[0].event.text, /（语音，语音转写未启用）/);
  } finally {
    await ctx.close();
  }
});

test('没有接入转写器：语音仍然投递，正文给出原因', async () => {
  const ctx = await setup({ transcribe: null });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_voice_short'));
    assert.deepEqual([result.ok, result.delivered], [true, true]);
    assert.match(ctx.pushed[0].event.text, /未接入语音转写/);
  } finally {
    await ctx.close();
  }
});
