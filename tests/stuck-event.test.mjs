/**
 * 卡死保护：同一条消息一直处理不了时，不能让它把事件流永远堵在同一个游标上。
 *
 * 这里直接驱动 World 的事件消费逻辑（不经过真实 SSE），因为要测的是"失败累计到阈值之后怎么办"，
 * 而不是重连时序：SSE 重连由 `events.test.mjs` 和 `world-lifecycle.test.mjs` 负责。
 * 规则：连续失败 1..2 次 → 抛错（游标不动，重连后会再来）；第 3 次 → 记 error、推进游标、继续往下走。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTWECHAT_DEFAULTS } from '../src/config.ts';
import { AgentWechatWorld } from '../src/world.ts';
import { WorldStore } from '../src/identity/store.ts';

function makeWorld() {
  const dataDir = mkdtempSync(join(tmpdir(), 'awx-stuck-'));
  const ctx = {
    cfg: { ...AGENTWECHAT_DEFAULTS, enabled: true, accountId: 'account-1', baseUrl: 'https://127.0.0.1:1/v1' },
    id: 'agentwechat',
    timezone: 'Asia/Shanghai',
    botName: 'test',
    botDir: dataDir,
    packageDir: dataDir,
    repoRoot: dataDir,
    dataDir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: () => {},
  };
  const lines = [];
  const host = {
    pushEvent: () => ({ ok: true, cursor: 0 }),
    log: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
      debug: () => {},
    },
  };
  const world = new AgentWechatWorld(ctx);
  world.host = host;
  return { world, lines, dataDir };
}

const EVENT = (cursor, messageId) => ({
  cursor,
  kind: 'message.committed',
  data: { messageId, threadId: 'wxid_a' },
  createdAt: '2026-11-15T12:00:00.000Z',
});

const failing = { handle: async () => ({ ok: false, delivered: false, reason: '取消息详情失败：资源不存在（not_found）' }) };
const working = { handle: async () => ({ ok: true, delivered: true }) };

test('同一条消息连续失败三次：跳过并推进游标，不堵住后面的消息', async () => {
  const { world, lines, dataDir } = makeWorld();
  const consume = (event, inbound) => world.consume(event, inbound);

  await assert.rejects(() => consume(EVENT('20', 'm_bad'), failing), /资源不存在/, '第一次失败应抛错、游标不动');
  assert.equal(new WorldStore(dataDir).cursor, null);
  await assert.rejects(() => consume(EVENT('20', 'm_bad'), failing), /资源不存在/, '第二次仍然抛错');
  assert.equal(new WorldStore(dataDir).cursor, null);

  await consume(EVENT('20', 'm_bad'), failing); // 第三次：跳过
  assert.equal(new WorldStore(dataDir).cursor, '20', '跳过时要推进游标，否则永远卡在这里');
  assert.equal(world.snapshot().skipped, 1, '跳过条数要能看见');
  assert.ok(lines.some((line) => line.includes('跳过并推进游标')), `应记一条 error，实际：${lines.join(' | ')}`);

  // 后面的正常消息照常投递
  await consume(EVENT('21', 'm_good'), working);
  assert.equal(new WorldStore(dataDir).cursor, '21');
  assert.equal(world.snapshot().skipped, 1, '正常消息不该再累加跳过数');
});

test('偶尔失败一次不算卡死：换个消息重试从 1 开始，不会误跳过', async () => {
  const { world, dataDir } = makeWorld();
  await assert.rejects(() => world.consume(EVENT('30', 'm_flaky'), failing));
  // 同一轮里换了一条能处理的消息：失败计数清零，游标正常前进
  await world.consume(EVENT('31', 'm_good'), working);
  assert.equal(new WorldStore(dataDir).cursor, '31');
  assert.equal(world.snapshot().skipped, 0, '失败一次就跳过的消息等于丢消息');
});
