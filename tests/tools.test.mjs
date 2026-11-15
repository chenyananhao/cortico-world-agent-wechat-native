/**
 * 工具层：群聊 @ 成员要真的进发送体；发送状态要能按 sendId / 幂等键查回真实状态。
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
import { Outbound } from '../src/messaging/outbound.ts';
import { buildTools } from '../src/tools.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');
const silentLog = { info() {}, warn() {}, debug() {} };

function toolOf(tools, name) {
  const found = tools.find((tool) => (tool.schema?.name ?? tool.name) === name);
  assert.ok(found, `没有找到工具 ${name}`);
  return found;
}

async function setup(overrides = {}) {
  const api = await startMockApi();
  const store = new WorldStore(mkdtempSync(join(tmpdir(), 'awx-tools-')));
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 3000 });
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', sendEnabled: true, ...overrides };
  const outbound = new Outbound({ client, store, config: () => config, log: silentLog });
  const tools = buildTools({
    client: () => client,
    outbound: () => outbound,
    store,
    config: () => config,
    status: () => 'ok',
    log: silentLog,
  });
  return { api, store, client, config, tools, close: () => api.close() };
}

test('群聊 @ 成员：mentions 真的写进发送体，不是只在文字里加个名字', async () => {
  const ctx = await setup();
  try {
    const sendText = toolOf(ctx.tools, 'awx_send_text');
    const reply = await sendText.handler({ text: '收到', threadId: '123@chatroom', mentions: ['wxid_b', ' '], mentionAll: false }, {
      role: 'wechat-123-chatroom',
    });
    assert.match(reply, /已发送/);
    const body = ctx.api.state.sends[0].body;
    assert.equal(body.kind, 'text');
    assert.deepEqual(body.mentions, { userIds: ['wxid_b'] });
  } finally {
    await ctx.close();
  }
});

test('@所有人：mentionAll 变成 mentions.all', async () => {
  const ctx = await setup();
  try {
    const sendText = toolOf(ctx.tools, 'awx_send_text');
    await sendText.handler({ text: '开会', threadId: '123@chatroom', mentionAll: true }, { role: 'wechat-123-chatroom' });
    assert.deepEqual(ctx.api.state.sends[0].body.mentions, { all: true });
  } finally {
    await ctx.close();
  }
});

test('发送状态：按 sendId 查回 daemon 的真实状态', async () => {
  const ctx = await setup();
  try {
    const sendText = toolOf(ctx.tools, 'awx_send_text');
    const reply = await sendText.handler({ text: '在', threadId: 'wxid_a' }, { role: 'wechat-wxid_a' });
    const sendId = /sendId=([^）)]+)/.exec(reply)?.[1];
    assert.ok(sendId, `回复里没有 sendId：${reply}`);

    const sendStatus = toolOf(ctx.tools, 'awx_send_status');
    const status = await sendStatus.handler({ sendId }, { role: 'wechat-wxid_a' });
    assert.match(status, /状态：accepted/);
  } finally {
    await ctx.close();
  }
});

test('发送状态：幂等键查不到时如实说没有，不假装成功', async () => {
  const ctx = await setup();
  try {
    const sendStatus = toolOf(ctx.tools, 'awx_send_status');
    const status = await sendStatus.handler({ idempotencyKey: 'awx-not-there' }, { role: 'wechat-wxid_a' });
    assert.match(status, /没有这条幂等键的发送记录/);
  } finally {
    await ctx.close();
  }
});
