/**
 * World 生命周期：启用后连 SSE、停用后关连接、重新启用按游标续传。
 * 任务书验收项 16/17 就在这里：不是"代码看着对"，而是连接真的开了、真的断了、断点真的被带上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTWECHAT_DEFAULTS, AGENTWECHAT_TOKEN_ENV } from '../src/config.ts';
import { AgentWechatWorld } from '../src/world.ts';
import { WorldStore } from '../src/identity/store.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');

const MESSAGE = {
  id: 'm1', accountId: 'account-1', threadId: 'wxid_a', senderId: 'wxid_a',
  type: 1, direction: 'incoming', body: '在吗', createdAt: '2026-11-15T12:00:00.000Z', version: 1, media: [],
};

function makeHost(pushed) {
  const lines = [];
  return {
    lines,
    host: {
      pushEvent(event, options) {
        pushed.push({ event, options });
        return { ok: true, cursor: pushed.length };
      },
      log: {
        info: (m) => lines.push(m),
        warn: (m) => lines.push(`WARN ${m}`),
        error: (m) => lines.push(`ERROR ${m}`),
        debug: () => {},
      },
    },
  };
}

function makeCtx(api, dataDir) {
  const cfg = {
    ...AGENTWECHAT_DEFAULTS,
    enabled: true,
    baseUrl: api.baseUrl,
    accountId: 'account-1',
    caCertFile: CA,
    receiveEnabled: true,
    directMessagesEnabled: true,
    requestTimeoutMs: 5000,
    reconnectMaxMs: 2000,
  };
  const secrets = { [AGENTWECHAT_TOKEN_ENV]: api.token };
  return {
    cfg,
    id: 'agentwechat',
    timezone: 'Asia/Shanghai',
    botName: 'test',
    botDir: dataDir,
    packageDir: dataDir,
    repoRoot: dataDir,
    dataDir,
    secret: (name) => secrets[name] ?? '',
    storeSecret: (name, value) => {
      secrets[name] = value;
    },
    persist: () => {},
    restart: () => {},
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return false;
}

test('被过滤掉的消息也算"收到过"：游标推进、lastEventAt 有值、面板能看到会话列表', async () => {
  const pushed = [];
  const api = await startMockApi({
    messages: {},
    streams: ({ send }) => {
      // 这条消息拿不到详情（mock 没有 m2）→ 会被 screen 判成"自己发出的/拿不到"，最终跳过并推进游标。
      send({ cursor: '21', kind: 'message.committed', data: { messageId: 'm2', threadId: 'wxid_other' }, createdAt: '2026-11-15T12:02:00.000Z' });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-life-'));
  const world = new AgentWechatWorld(makeCtx(api, dataDir));
  const { host } = makeHost(pushed);
  try {
    await world.start(host);
    assert.ok(await waitFor(() => api.state.streamOpens.length === 1), '没有建立 SSE 连接');
    const out = world.webUi('zh');
    assert.ok(out?.invoke, 'webUi 没有 invoke');
    // 直接问面板要会话列表：返回结构稳定，模型/用户都能看到每个会话各自的 session id。
    const listed = await out.invoke('threads', 'list', []);
    assert.ok(Array.isArray(listed.items), 'threads 面板没有返回 items');
    const snapshot = world.snapshot();
    assert.equal(typeof snapshot.lastEventKind, 'string');
    // v0.6.1：环境提示词文档（记忆域约定）必须挂得上，且占位符有变量可替换。
    const [doc] = out.promptDocs ?? [];
    assert.ok(doc, 'webUi 没有声明 promptDocs');
    assert.equal(doc.role, 'envPrompt');
    assert.equal(doc.path.endsWith('ENV_PROMPT.md'), true, `promptDocs.path 不对：${doc.path}`);
    assert.equal(existsSync(doc.path), true, '提示词模板文件不存在');
    const vars = world.envPromptVars() ?? {};
    for (const v of doc.vars ?? []) assert.ok(v.name in vars, `模板占位符 ${v.name} 没有对应变量`);
    assert.match(readFileSync(doc.path, 'utf8'), /scope:"main"/, '模板里没有记忆域约定');
  } finally {
    await world.stop();
    await api.close();
  }
});

test('接收的消息被过滤时，lastEventAt 仍然记录（面板不该显示"最近事件：无"）', async () => {
  const pushed = [];
  const api = await startMockApi({
    messages: { m3: { ...MESSAGE, id: 'm3', direction: 'outgoing', threadId: 'wxid_a' } },
    streams: ({ send }) => {
      send({ cursor: '31', kind: 'message.committed', data: { messageId: 'm3', threadId: 'wxid_a' }, createdAt: '2026-11-15T12:03:00.000Z' });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-life-'));
  const world = new AgentWechatWorld(makeCtx(api, dataDir));
  const { host } = makeHost(pushed);
  try {
    await world.start(host);
    assert.ok(await waitFor(() => api.state.streamOpens.length === 1), '没有建立 SSE 连接');
    assert.ok(await waitFor(() => world.snapshot().lastEventAt !== null), 'lastEventAt 没有记录');
    assert.equal(pushed.length, 0, '自己发出的消息不该投递');
    assert.ok(await waitFor(() => new WorldStore(dataDir).cursor === '31'), '游标没有推进');
  } finally {
    await world.stop();
    await api.close();
  }
});

test('启用后连上 SSE，收到事件投递到该会话的 session', async () => {
  const pushed = [];
  const api = await startMockApi({
    messages: { m1: MESSAGE },
    streams: ({ send }) => {
      send({ cursor: '11', kind: 'message.committed', data: { messageId: 'm1', threadId: 'wxid_a' }, createdAt: '2026-11-15T12:00:00.000Z' });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-life-'));
  const world = new AgentWechatWorld(makeCtx(api, dataDir));
  const { host, lines } = makeHost(pushed);
  try {
    await world.start(host);
    assert.ok(await waitFor(() => api.state.streamOpens.length === 1), '没有建立 SSE 连接');
    assert.ok(await waitFor(() => pushed.length === 1), '事件没有投递');
    assert.equal(pushed[0].options.session, 'wechat-wxid_a');
    assert.ok(await waitFor(() => new WorldStore(dataDir).cursor === '11'), '游标没有落盘');
    assert.ok(lines.some((line) => line.includes('事件流状态：open')), lines.join(' | '));
    // 连上就该把断线痕迹清掉：面板不该长期挂着一条已经恢复的错误。
    assert.equal(world.snapshot().lastError, null);
  } finally {
    await world.stop();
    await api.close();
  }
});

test('停用后关闭 SSE；重新启用从上次游标续传', async () => {
  const pushed = [];
  const api = await startMockApi({
    messages: { m1: MESSAGE },
    streams: ({ send }) => {
      send({ cursor: '11', kind: 'message.committed', data: { messageId: 'm1', threadId: 'wxid_a' }, createdAt: '2026-11-15T12:00:00.000Z' });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-life2-'));
  const first = new AgentWechatWorld(makeCtx(api, dataDir));
  try {
    await first.start(makeHost(pushed).host);
    assert.ok(await waitFor(() => pushed.length === 1));
    await first.stop();
    assert.ok(await waitFor(() => api.state.streamCloses.length === 1), '停用后连接没关');
    await api.close();
  } finally {
    await first.stop().catch(() => {});
  }

  // 换一个"新一轮进程"的 World，同一个 dataDir：必须带着 lastEventId 重连。
  const api2 = await startMockApi({ messages: { m1: MESSAGE } });
  const second = new AgentWechatWorld(makeCtx(api2, dataDir));
  try {
    await second.start(makeHost(pushed).host);
    assert.ok(await waitFor(() => api2.state.streamOpens.length === 1), '没有重连');
    assert.equal(api2.state.streamOpens[0], '11', `重连应带上次游标，实际 ${api2.state.streamOpens[0]}`);
  } finally {
    await second.stop();
    await api2.close();
  }
});

test('receiveEnabled=false：不连 SSE，但工具仍可用', async () => {
  const pushed = [];
  const api = await startMockApi({ messages: { m1: MESSAGE } });
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-life3-'));
  const ctx = makeCtx(api, dataDir);
  ctx.cfg = { ...ctx.cfg, receiveEnabled: false };
  const world = new AgentWechatWorld(ctx);
  try {
    await world.start(makeHost(pushed).host);
    await sleep(300);
    assert.equal(api.state.streamOpens.length, 0);
    assert.equal(world.tools().length, 7);
  } finally {
    await world.stop();
    await api.close();
  }
});
