/**
 * SSE：解析规范帧、收到事件、断线后带着游标重连（不重复、不丢）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventPump, readSse } from '../src/api/events.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');

const silentLog = { info() {}, warn() {}, debug() {} };

test('readSse 解析注释心跳、event/data/id 字段', async () => {
  const { Readable } = await import('node:stream');
  const stream = Readable.from([
    ': heartbeat\n\n',
    'id: 7\nevent: message.committed\ndata: {"cursor":"7","kind":"message.committed"}\n\n',
    'data: {"cursor":"8","kind":"group.updated"}\n\n',
  ]);
  const frames = [];
  for await (const frame of readSse(stream)) frames.push(frame);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, '7');
  assert.equal(frames[0].event, 'message.committed');
  assert.equal(JSON.parse(frames[1].data).cursor, '8');
});

test('EventPump 收事件 → 断线后带最后游标重连，且不重复处理', async () => {
  const seen = [];
  const connections = [];
  const api = await startMockApi({
    streams: ({ after, send, end }) => {
      connections.push(after);
      if (after === null) {
        send({ cursor: '1', kind: 'message.committed', data: { messageId: 'm1' }, createdAt: '2026-11-15T12:00:00.000Z' });
        send({ cursor: '2', kind: 'message.committed', data: { messageId: 'm2' }, createdAt: '2026-11-15T12:00:01.000Z' });
        end();
        return;
      }
      send({ cursor: '3', kind: 'message.committed', data: { messageId: 'm3' }, createdAt: '2026-11-15T12:00:02.000Z' });
      end();
    },
  });

  let cursor = null;
  const controller = new AbortController();
  const pump = new EventPump({
    open: async (after, signal) => {
      const transport = await openStream(api, after, signal);
      return transport;
    },
    onEvent: (event) => {
      seen.push(event.cursor);
      cursor = event.cursor;
      if (seen.length >= 3) pump.stop();
    },
    cursor: () => cursor,
    onState: () => {},
    log: silentLog,
    reconnectMs: 20,
    maxReconnectMs: 100,
    signal: controller.signal,
  });

  const running = pump.run();
  const deadline = Date.now() + 5000;
  while (seen.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  pump.stop();
  await running;
  await api.close();

  assert.deepEqual(seen, ['1', '2', '3']);
  assert.deepEqual(connections, [null, '2']);
});

/** 用 mock 服务真正的 https 连接开一条 SSE。 */
async function openStream(api, after, signal) {
  const { Agent, request } = await import('node:https');
  const { readFileSync } = await import('node:fs');
  const url = new URL(`${api.baseUrl}/accounts/account-1/events/stream${after ? `?after=${after}` : ''}`);
  const agent = new Agent({ keepAlive: false, ca: [readFileSync(CA, 'utf8')] });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { authorization: `Bearer ${api.token}`, accept: 'text/event-stream', ...(after ? { 'last-event-id': after } : {}) },
        agent,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
    signal.addEventListener('abort', () => req.destroy(), { once: true });
  });
}
