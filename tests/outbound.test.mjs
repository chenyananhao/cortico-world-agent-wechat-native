/**
 * 发：幂等键唯一、超时先补查、needs_review 不装成失败或成功。
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
import { Outbound, newIdempotencyKey } from '../src/messaging/outbound.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');
const silentLog = { info() {}, warn() {}, debug() {} };

async function setup(sendScenario, overrides = {}) {
  const api = await startMockApi({ sendScenario });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-outbound-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 3000 });
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', sendEnabled: true, ...overrides };
  const outbound = new Outbound({ client, store, config: () => config, log: silentLog });
  return { api, store, outbound, config, close: () => api.close() };
}

test('普通文字发送：带幂等键，成功即 accepted', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: '收到' });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'accepted');
    assert.equal(result.idempotencyKey.startsWith('awx-'), true);
    assert.equal(ctx.api.state.sends.length, 1);
    assert.equal(ctx.api.state.sends[0].body.kind, 'text');
    assert.equal(ctx.api.state.sends[0].body.text, '收到');
    assert.equal(ctx.api.state.sends[0].key, result.idempotencyKey);
  } finally {
    await ctx.close();
  }
});

test('响应丢失（超时/断连）：先按幂等键补查，再用同一个键重试，不重复发送', async () => {
  const ctx = await setup(() => ({ state: 'accepted', loseResponse: true }));
  try {
    const key = newIdempotencyKey();
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: '在吗', idempotencyKey: key });
    assert.equal(result.ok, true, '补查能确认送达，就不该报失败');
    assert.equal(result.state, 'accepted');
    assert.equal(result.idempotencyKey, key);
    const mine = ctx.api.state.sends.filter((item) => item.key === key);
    assert.equal(mine.length, 1, '同一个幂等键只能产生一条发送记录');
  } finally {
    await ctx.close();
  }
});

test('needs_review：照实返回"结果未知"，既不报成功也不报失败', async () => {
  const ctx = await setup(() => ({ state: 'needs_review' }));
  try {
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: '喂' });
    assert.equal(result.ok, false);
    assert.equal(result.needsReview, true);
    assert.equal(result.state, 'needs_review');
    assert.equal(result.error.includes('需要人工核对'), true);
  } finally {
    await ctx.close();
  }
});

test('同一幂等键重复调用：走本地记录，不再发第二次', async () => {
  const ctx = await setup();
  try {
    const key = newIdempotencyKey();
    await ctx.outbound.sendText({ threadId: 'wxid_a', text: '一', idempotencyKey: key });
    const second = await ctx.outbound.sendText({ threadId: 'wxid_a', text: '一', idempotencyKey: key });
    assert.equal(second.ok, true);
    assert.equal(ctx.api.state.sends.length, 1);
  } finally {
    await ctx.close();
  }
});

test('sendEnabled=false：拒绝发送且不打网络', async () => {
  const ctx = await setup(undefined, { sendEnabled: false });
  try {
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.includes('sendEnabled'), true);
    assert.equal(ctx.api.state.sends.length, 0);
  } finally {
    await ctx.close();
  }
});

test('超长正文被拒在本地', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: 'x'.repeat(65 * 1024) });
    assert.equal(result.ok, false);
    assert.equal(result.error.includes('上限'), true);
    assert.equal(ctx.api.state.sends.length, 0);
  } finally {
    await ctx.close();
  }
});

test('先 queued 后 accepted：按 GET /sends/{id} 问清楚再报送达', async () => {
  let polls = 0;
  const api = await startMockApi({
    sendScenario: () => ({ state: 'queued' }),
    settleScenario: (record) => {
      polls += 1;
      return { ...record.send, state: 'accepted', serverId: 'server-9', localMessageId: 'local-9' };
    },
  });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-settle-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 3000 });
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', sendEnabled: true };
  const outbound = new Outbound({ client, store, config: () => config, log: silentLog });
  try {
    const result = await outbound.sendText({ threadId: 'wxid_a', text: '排队中' });
    assert.equal(polls, 1, '应该查询一次发送状态');
    assert.equal(result.ok, true);
    assert.equal(result.state, 'accepted');
    assert.equal(api.state.sends.length, 1, '轮询不能产生第二次发送');
    assert.equal(store.send(result.idempotencyKey).state, 'accepted');
  } finally {
    client.destroy();
    await api.close();
  }
});

test('一直 queued：如实报"已入队未送达"，不当成成功也不当成失败', async () => {
  const api = await startMockApi({ sendScenario: () => ({ state: 'queued' }) });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-settle2-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 3000 });
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', sendEnabled: true };
  const outbound = new Outbound({ client, store, config: () => config, log: silentLog });
  try {
    const result = await outbound.sendText({ threadId: 'wxid_a', text: '还是排队' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'queued');
    assert.equal(result.needsReview, false);
    assert.equal(store.send(result.idempotencyKey).state, 'queued');
  } finally {
    client.destroy();
    await api.close();
  }
});

const QUOTED = {
  m_quote: {
    id: 'm_quote', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a', serverId: 'srv-9',
    type: 1, direction: 'incoming', body: '原始消息', createdAt: '2026-11-15T12:00:00.000Z', version: 1, media: [],
  },
};

async function quoteSetup() {
  const api = await startMockApi({ messages: QUOTED });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-quote-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 3000 });
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', sendEnabled: true };
  const outbound = new Outbound({ client, store, config: () => config, log: silentLog });
  return { api, outbound, client };
}

test('引用回复：只给 messageId 时自动补上 serverId', async () => {
  const ctx = await quoteSetup();
  try {
    const result = await ctx.outbound.sendText({ threadId: 'wxid_a', text: '收到', quoteMessageId: 'm_quote' });
    assert.equal(result.ok, true);
    const quote = ctx.api.state.sends[0].body.quote;
    assert.equal(quote.messageId, 'm_quote');
    assert.equal(quote.serverId, 'srv-9', '引用应该带全两个 id');
  } finally {
    ctx.client.destroy();
    await ctx.api.close();
  }
});

test('引用回复：两个 id 都给时都要保留，不能互相覆盖', async () => {
  const ctx = await quoteSetup();
  try {
    await ctx.outbound.sendText({ threadId: 'wxid_a', text: '嗯', quoteMessageId: 'm_quote', quoteServerId: 'srv-9' });
    const quote = ctx.api.state.sends[0].body.quote;
    assert.equal(quote.messageId, 'm_quote');
    assert.equal(quote.serverId, 'srv-9');
  } finally {
    ctx.client.destroy();
    await ctx.api.close();
  }
});
