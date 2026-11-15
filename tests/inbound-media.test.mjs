/**
 * 收图/收文件：媒体清单 → 内容字节 → 事件 blobs。
 * 断言的是 World 交给 Core 的东西（blobs 的字节与 mime），而不是 mock 自己记的账。
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
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');
const silentLog = { info() {}, warn() {}, debug() {} };

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const FILE_BYTES = Buffer.from('部门预算 2026 版', 'utf8');

const messages = {
  m_image: {
    id: 'm_image', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a',
    type: 3, direction: 'incoming', body: '', createdAt: '2026-11-15T12:00:00.000Z', version: 1,
    media: [{ id: 'media-1', kind: 'image' }],
  },
  m_file: {
    id: 'm_file', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a',
    type: 49, direction: 'incoming', body: '', createdAt: '2026-11-15T12:00:01.000Z', version: 1,
    media: [{ id: 'media-2', kind: 'file' }],
  },
  m_text: {
    id: 'm_text', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a',
    type: 1, direction: 'incoming', body: '纯文字', createdAt: '2026-11-15T12:00:02.000Z', version: 1, media: [],
  },
};

const media = {
  m_image: [{ id: 'media-1', kind: 'image', name: '截图.png' }],
  m_file: [{ id: 'media-2', kind: 'file', name: '预算.xlsx' }],
};

const mediaContent = {
  'media-1': { bytes: IMAGE_BYTES, mime: 'image/png' },
  'media-2': { bytes: FILE_BYTES, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

async function setup(overrides = {}, options = {}) {
  const api = await startMockApi({ messages, media, mediaContent, ...options });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-media-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 5000 });
  const identity = new IdentityMap(client, store, silentLog);
  const config = {
    ...AGENTWECHAT_DEFAULTS,
    enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', receiveEnabled: true,
    directMessagesEnabled: true, mediaEnabled: true,
    ...overrides,
  };
  const pushed = [];
  const host = {
    pushEvent(event, opts) {
      pushed.push({ event, opts });
      return { ok: true, cursor: pushed.length };
    },
  };
  const inbound = new InboundHandler({
    client, host: () => host, config: () => config, store, identity,
    worldId: 'agentwechat', log: silentLog, onDelivered: () => {},
  });
  const event = (messageId, cursor = '1') => ({
    cursor, kind: 'message.committed', data: { messageId, threadId: 'wxid_a' }, createdAt: '2026-11-15T12:00:00.000Z',
  });
  return { api, store, client, pushed, inbound, event, close: () => api.close() };
}

test('图片消息：blobs 带原始字节与 mime，正文仍有可读说明', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_image'));
    assert.equal(result.delivered, true);
    assert.equal(ctx.pushed.length, 1);
    const { event, opts } = ctx.pushed[0];
    assert.equal(opts.session, 'wechat-wxid_a');
    assert.equal(event.blobs.length, 1);
    assert.equal(event.blobs[0].mime, 'image/png');
    assert.equal(event.blobs[0].name, '截图.png');
    assert.deepEqual([...event.blobs[0].bytes], [...IMAGE_BYTES]);
    assert.ok(event.blobs[0].fallbackText.includes('图片'), event.blobs[0].fallbackText);
    // 正文不该被附件吞掉，也不该只剩一堆空行
    assert.ok(event.text.length > 0, event.text);
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});

test('文件消息：按清单取内容，名字与 mime 保留', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_file', '2'));
    assert.equal(result.delivered, true);
    const blobs = ctx.pushed[0].event.blobs;
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].name, '预算.xlsx');
    assert.equal(blobs[0].mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(Buffer.from(blobs[0].bytes).toString('utf8'), '部门预算 2026 版');
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});

test('mediaEnabled=false：媒体消息不投递，也不请求内容', async () => {
  const ctx = await setup({ mediaEnabled: false });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_image', '3'));
    assert.equal(result.delivered, false);
    assert.equal(ctx.pushed.length, 0);
    assert.equal(ctx.api.state.mediaLookups.length, 0);
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});

test('纯文字消息不会被附件路径影响', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_text', '4'));
    assert.equal(result.delivered, true);
    assert.equal(ctx.pushed[0].event.blobs, undefined);
    assert.equal(ctx.api.state.mediaLookups.length, 0);
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});

test('真机形状：详情里没有 media 字段，也要去 lookup 并带上附件', async () => {
  // 真实 daemon 的图片消息详情是 { type: 3, body: null, media: [] }——附件清单只能靠 lookup。
  const bare = {
    id: 'm_bare', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a',
    type: 3, direction: 'incoming', body: null, createdAt: '2026-11-15T12:00:05.000Z', version: 1,
  };
  const ctx = await setup({}, {
    messages: { m_bare: bare },
    media: { m_bare: [{ id: 'media-9', contentType: 'image/jpeg', byteLength: IMAGE_BYTES.length }] },
    mediaContent: { 'media-9': { bytes: IMAGE_BYTES, mime: 'image/jpeg' } },
  });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_bare', '5'));
    assert.equal(result.delivered, true);
    const { event, opts } = ctx.pushed[0];
    assert.equal(opts.session, 'wechat-wxid_a');
    assert.equal(event.blobs.length, 1);
    assert.equal(event.blobs[0].mime, 'image/jpeg');
    assert.equal(Buffer.from(event.blobs[0].bytes).byteLength, IMAGE_BYTES.length);
    assert.match(event.text, /附件：图片/);
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});

test('媒体未启用：图片消息不投递，也不去取清单', async () => {
  const ctx = await setup({ mediaEnabled: false });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_image', '6'));
    assert.equal(result.delivered, false);
    assert.match(result.reason ?? '', /媒体未启用/);
    assert.equal(ctx.api.state.mediaLookups.length, 0);
  } finally {
    ctx.client.destroy();
    await ctx.close();
  }
});
