/**
 * 收：过滤、去重、渲染，以及"投递到哪个 session"。
 * 这里用假 host 断言 `pushEvent(..., { session })` 的会话路由，不碰真 Core。
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

const messages = {
  m1: {
    id: 'm1', accountId: 'account-1', threadId: 'wxid_a', serverId: 's1', senderId: 'wxid_a',
    type: 1, direction: 'incoming', body: '你好', createdAt: '2026-11-15T12:00:00.000Z', version: 1, media: [],
  },
  m_self: {
    id: 'm_self', accountId: 'account-1', threadId: 'wxid_a', serverId: 's2', senderId: 'me',
    type: 1, direction: 'outgoing', body: '我发的', createdAt: '2026-11-15T12:00:01.000Z', version: 1, media: [],
  },
  m_group: {
    id: 'm_group', accountId: 'account-1', threadId: '123@chatroom', serverId: 's3', senderId: 'wxid_b',
    type: 1, direction: 'incoming', body: '大家好', createdAt: '2026-11-15T12:00:02.000Z', version: 1, media: [],
    mentions: { state: 'explicit', userIds: ['me'], self: true, all: false, source: 'text' },
  },
  m_group_quiet: {
    id: 'm_group_quiet', accountId: 'account-1', threadId: '123@chatroom', serverId: 's4', senderId: 'wxid_b',
    type: 1, direction: 'incoming', body: '路过的', createdAt: '2026-11-15T12:00:03.000Z', version: 1, media: [],
    mentions: { state: 'none', userIds: [], self: false, all: false, source: 'none' },
  },
  // 真机形状：正文明确 @ 了机器人，但 daemon 给的 mentions 是空的。
  m_group_at_text: {
    id: 'm_group_at_text', accountId: 'account-1', threadId: '123@chatroom', serverId: 's5', senderId: 'wxid_b',
    type: 1, direction: 'incoming', body: '@一条大肥鱼 测试3', createdAt: '2026-11-15T12:00:04.000Z', version: 1, media: [],
    mentions: { state: 'known', userIds: [], self: false, all: false, source: 'msgsource.atuserlist' },
  },
};

async function setup(overrides = {}) {
  const api = await startMockApi({
    messages,
    ownUsername: 'wxid_self',
    selfContact: { id: 'wxid_self', displayName: '一条大肥鱼', nickname: '一条大肥鱼', remark: null },
  });
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-inbound-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 5000 });
  const identity = new IdentityMap(client, store, silentLog);
  const config = {
    ...AGENTWECHAT_DEFAULTS,
    enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', receiveEnabled: true,
    directMessagesEnabled: true, groupMessagesEnabled: true, groupMentionOnly: true,
    ...overrides,
  };
  const pushed = [];
  const host = {
    pushEvent(event, options) {
      pushed.push({ event, options });
      return { ok: true, cursor: pushed.length };
    },
  };
  const inbound = new InboundHandler({
    client, host: () => host, config: () => config, store, identity,
    worldId: 'agentwechat', log: silentLog, onDelivered: () => {},
  });
  const event = (messageId, threadId, cursor = '1') => ({
    cursor, kind: 'message.committed', data: { messageId, threadId }, createdAt: '2026-11-15T12:00:00.000Z',
  });
  return { api, store, client, config, pushed, inbound, event, close: () => api.close() };
}

test('私聊文字：渲染成人话、投到该联系人自己的 session', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m1', 'wxid_a'));
    assert.deepEqual([result.ok, result.delivered], [true, true]);
    assert.equal(ctx.pushed.length, 1);
    const { event, options } = ctx.pushed[0];
    assert.equal(event.type, 'agentwechat.message');
    assert.equal(options.session, 'wechat-wxid_a');
    assert.equal(event.meta.threadId, 'wxid_a');
    assert.equal(event.meta.session, 'wechat-wxid_a');
    assert.equal(event.text.includes('你好'), true);
    assert.equal(event.text.includes('明哥'), true, '联系人的备注名应出现在文本里');
  } finally {
    await ctx.close();
  }
});

test('同一条消息重复推送：不重复投递', async () => {
  const ctx = await setup();
  try {
    await ctx.inbound.handle(ctx.event('m1', 'wxid_a', '1'));
    const again = await ctx.inbound.handle(ctx.event('m1', 'wxid_a', '1'));
    assert.equal(again.delivered, false);
    assert.equal(again.reason, '重复消息');
    assert.equal(ctx.pushed.length, 1);
  } finally {
    await ctx.close();
  }
});

test('自己发出的消息不再回灌给模型', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_self', 'wxid_a'));
    assert.equal(result.delivered, false);
    assert.equal(result.reason.includes('自己发出'), true);
    assert.equal(ctx.pushed.length, 0);
  } finally {
    await ctx.close();
  }
});

test('群聊被 @：投到群自己的 session，发送者仍是群成员而非群本身', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_group', '123@chatroom'));
    assert.equal(result.delivered, true);
    const { event, options } = ctx.pushed[0];
    assert.equal(options.session, 'wechat-123-chatroom');
    assert.equal(event.meta.threadKind, 'group');
    assert.equal(event.text.includes('小红'), true, '应该是发言的群成员');
    assert.equal(event.text.includes('三人小组'), true, '群名用于定位会话');
  } finally {
    await ctx.close();
  }
});

test('群聊未被 @ 且开了 mentionOnly：不投递', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_group_quiet', '123@chatroom'));
    assert.equal(result.delivered, false);
    assert.equal(result.reason.includes('@'), true);
    assert.equal(ctx.pushed.length, 0);
  } finally {
    await ctx.close();
  }
});

test('群聊总开关关闭：即使被 @ 也不投递', async () => {
  const ctx = await setup({ groupMessagesEnabled: false });
  try {
    const result = await ctx.inbound.handle(ctx.event('m_group', '123@chatroom'));
    assert.equal(result.delivered, false);
    assert.equal(ctx.pushed.length, 0);
  } finally {
    await ctx.close();
  }
});

test('真机形状：@ 只出现在正文里、mentions.self 为 false，也要投递', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle(ctx.event('m_group_at_text', '123@chatroom'));
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(ctx.pushed.length, 1);
    assert.equal(ctx.pushed[0].options.session, 'wechat-123-chatroom');
    assert.match(ctx.pushed[0].event.text, /@一条大肥鱼|测试3/);
  } finally {
    await ctx.close();
  }
});

test('跳过的消息不允许推进游标（ok=true 但 delivered=false 由调用方决定推进）', async () => {
  const ctx = await setup({ receiveEnabled: false });
  try {
    const result = await ctx.inbound.handle(ctx.event('m1', 'wxid_a'));
    assert.equal(result.ok, true);
    assert.equal(result.delivered, false);
  } finally {
    await ctx.close();
  }
});

test('事件里没有 messageId：直接忽略，不炸', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.inbound.handle({ cursor: '9', kind: 'message.committed', data: {}, createdAt: '' });
    assert.deepEqual([result.ok, result.delivered], [true, false]);
  } finally {
    await ctx.close();
  }
});

test('记忆域：senderKey 是每个会话一个合法域（不被 companion 洗成 main）', async () => {
  const ctx = await setup();
  try {
    await ctx.inbound.handle(ctx.event('m1', 'wxid_a'));
    await ctx.inbound.handle(ctx.event('m_group', '123@chatroom'));
    const keys = ctx.pushed.map((p) => p.event.senderKey);
    assert.deepEqual(keys, ['awx.wxid_a', 'awx.g.123'], '私聊 awx.<id>、群 awx.g.<群号>');
    for (const key of keys) {
      // companion 的 cleanScope()：不匹配就整段变 main，等于前功尽弃。
      assert.match(key, /^[a-z0-9][a-z0-9._:-]*$/i, `${key} 必须是合法域`);
      assert.notEqual(key, 'main');
    }
  } finally {
    await ctx.close();
  }
});
