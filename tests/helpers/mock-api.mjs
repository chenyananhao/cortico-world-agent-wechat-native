/**
 * 测试用的假 agent-wechat 服务：https + 真证书（自签，测试用 CA 在校验白名单里）。
 * 只实现被测代码真的会打的那几条路由，行为按官方 API 的形状返回。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', 'fixtures');

/** DER → PEM：Node 的 `ca` 认 PEM，证书文件本身是 DER。 */
export function caPem() {
  const der = readFileSync(join(FIXTURES, 'test-ca.cer'));
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export const CA_FILE = join(FIXTURES, 'test-ca.cer');

export async function startMockApi(options = {}) {
  const token = options.token ?? 'test-token';
  const state = {
    /** 收到的发送请求：`{ key, body }`，用来断言幂等与重复发送。 */
    sends: [],
    acks: [],
    /** GET /sends/{id} 把哪条发送推进过状态：`{id, state}`。 */
    settles: [],
    /** 上传过的暂存文件：`{ source, boundaryOk, multipart }`。 */
    uploads: [],
    /** 接收侧媒体清单请求：每次 `media/lookup` 的 messageIds。 */
    mediaLookups: [],
    /** SSE 每次建连的 `after` 参数，以及每次断开；用来断言"停用关连接、重启按游标续传"。 */
    streamOpens: [],
    streamCloses: [],
    /** 已存在但"响应丢了"的发送记录，用于超时补查。 */
    lost: new Map(),
    /** 每条连接上要推的 SSE 脚本：函数 `(send) => void`，可用 after 决定推什么。 */
    streams: options.streams ?? null,
    requests: [],
  };

  const server = createServer(
    { pfx: readFileSync(join(FIXTURES, 'test-server.pfx')), passphrase: 'awx-test' },
    (req, res) => {
      const url = new URL(req.url, 'https://127.0.0.1');
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/v1/health') return json(200, { ok: true });
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) return json(401, { error: { code: 'unauthorized', message: 'bad token' } });

      const p = url.pathname;
      if (p === '/v1/accounts') {
        return json(200, {
          items: [{ id: 'account-1', state: 'online', displayName: '测试账号', ownUsername: options.ownUsername ?? 'wxid_self' }],
          nextCursor: null,
        });
      }
      if (/^\/v1\/accounts\/[^/]+\/threads$/.test(p)) {
        return json(200, {
          items: [
            { id: 'wxid_a', accountId: 'account-1', peerId: 'wxid_a', kind: 'direct', displayName: '小明', unreadCount: 2, readStateVersion: 1 },
            { id: '123@chatroom', accountId: 'account-1', peerId: '123@chatroom', kind: 'group', displayName: '三人小组', unreadCount: 0, readStateVersion: 1 },
          ],
          nextCursor: null,
        });
      }
      if (/^\/v1\/accounts\/[^/]+\/threads\/[^/]+\/messages$/.test(p)) {
        return json(200, {
          items: [{ id: 'm-old', senderId: 'wxid_a', senderName: '小明', direction: 'incoming', type: 1, text: '在吗', createdAt: '2026-11-15T12:00:00.000Z' }],
          nextCursor: null,
        });
      }
      if (/^\/v1\/accounts\/[^/]+\/messages\/[^/]+$/.test(p)) {
        const id = decodeURIComponent(p.split('/').pop());
        const message = (options.messages ?? {})[id];
        if (!message) return json(404, { error: { code: 'not_found' } });
        return json(200, message);
      }
      if (/^\/v1\/accounts\/[^/]+\/contacts$/.test(p)) {
        const items = [
          { id: 'wxid_a', displayName: '小明', nickname: 'Ming', remark: '明哥' },
          ...(options.selfContact ? [options.selfContact] : []),
        ];
        return json(200, { items, nextCursor: null });
      }
      if (/^\/v1\/accounts\/[^/]+\/groups$/.test(p)) {
        return json(200, { items: [{ id: '123@chatroom', roomId: '123@chatroom', displayName: '三人小组', ownerId: 'wxid_a' }], nextCursor: null });
      }
      if (/^\/v1\/accounts\/[^/]+\/groups\/[^/]+\/members$/.test(p)) {
        return json(200, { items: [{ id: 'wxid_b', displayName: '小红' }], nextCursor: null });
      }
      // 发送记录按账号分区：真实 daemon 上 /v1/sends/by-idempotency-key 是 404，必须带账号段。
      if (/^\/v1\/accounts\/[^/]+\/sends\/by-idempotency-key$/.test(p)) {
        const key = url.searchParams.get('key');
        const lost = state.lost.get(key);
        if (!lost) return json(404, { error: { code: 'not_found' } });
        return json(200, lost);
      }
      if (/^\/v1\/accounts\/[^/]+\/uploads$/.test(p) && req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const raw = Buffer.concat(chunks);
          const type = String(req.headers['content-type'] ?? '');
          const boundary = /boundary=(.+)$/.exec(type)?.[1] ?? '';
          const text = raw.toString('latin1');
          // RFC 5987 的 filename* 优先；没有才退回 filename="…"（按 UTF-8 解字节）。
          const extended = /filename\*=UTF-8''([^;\r\n]+)/i.exec(text)?.[1];
          const plain = /filename="([^"]*)"/.exec(text)?.[1];
          const fileName = extended ? decodeURIComponent(extended) : plain ? Buffer.from(plain, 'latin1').toString('utf8') : 'unnamed';
          const headEnd = text.indexOf('\r\n\r\n');
          const tailStart = text.lastIndexOf(`\r\n--${boundary}--`);
          const bytes = headEnd >= 0 && tailStart > headEnd ? raw.subarray(headEnd + 4, tailStart) : Buffer.alloc(0);
          const source = {
            id: `src-${state.uploads.length + 1}`,
            name: fileName,
            mediaType: /content-type:\s*([^\r\n]+)/i.exec(text)?.[1] ?? 'application/octet-stream',
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            createdAt: new Date().toISOString(),
          };
          state.uploads.push({ source, boundaryOk: boundary !== '', multipart: type.startsWith('multipart/form-data') });
          return json(201, source);
        });
        return;
      }
      if (/^\/v1\/accounts\/[^/]+\/sends\/[^/]+$/.test(p) && req.method === 'GET') {
        const id = p.split('/').pop();
        const record = state.sends.find((item) => item.send.id === id);
        if (!record) return json(404, { error: { code: 'not_found' } });
        // settleScenario 让测试演"先 queued 后 accepted"这种非终态到终态的过渡。
        const settled = options.settleScenario?.(record, state);
        if (settled) {
          record.send = { ...record.send, ...settled };
          state.settles.push({ id, state: record.send.state });
        }
        return json(200, record.send);
      }
      if (/^\/v1\/accounts\/[^/]+\/sends$/.test(p) && req.method === 'POST') {
        return readJson(req, (body) => {
          const key = req.headers['idempotency-key'];
          // 真机校验：media 发送体不接受 fileName，带上它整单 400。
          if (body.fileName !== undefined) return json(400, { error: { code: 'invalid_request' } });
          const existing = state.sends.find((item) => item.key === key);
          if (existing) return json(200, existing.send);
          const scenario = options.sendScenario?.(body, key, state) ?? { state: 'accepted' };
          const send = {
            id: `send-${state.sends.length + 1}`,
            accountId: 'account-1',
            destination: body.threadId,
            state: scenario.state,
            clientId: key ?? null,
            serverId: scenario.state === 'accepted' ? 'server-1' : null,
            errorCode: scenario.errorCode ?? null,
            localMessageId: scenario.state === 'accepted' ? 'local-1' : null,
            createdAt: '2026-11-15T12:00:01.000Z',
          };
          state.sends.push({ key, body, send });
          if (scenario.loseResponse) {
            state.lost.set(key, send);
            // 模拟"服务端收了但连接断了"：不写响应。
            setTimeout(() => req.destroy(), 5);
            return;
          }
          return json(201, send);
        });
      }
      // 接收侧媒体：清单 + 原始内容。真实 daemon 是账号分区路径：
      // POST /v1/accounts/{account}/media/lookup → {items:[{messageId, assets, error?}]}
      // GET  /v1/accounts/{account}/media/{assetId}/content
      if (/^\/v1\/accounts\/[^/]+\/media\/lookup$/.test(p) && req.method === 'POST') {
        return readJson(req, (body) => {
          const ids = Array.isArray(body.messageIds) ? body.messageIds : [];
          const items = ids.map((messageId) => ({ messageId, assets: (options.media ?? {})[messageId] ?? [] }));
          state.mediaLookups.push(ids);
          return json(200, { items });
        });
      }
      if (/^\/v1\/accounts\/[^/]+\/media\/[^/]+\/content$/.test(p)) {
        const id = decodeURIComponent(p.split('/')[5]);
        const asset = (options.mediaContent ?? {})[id];
        if (!asset) return json(404, { error: { code: 'not_found' } });
        const bytes = Buffer.from(asset.bytes);
        res.writeHead(200, { 'content-type': asset.mime, 'content-length': String(bytes.byteLength) });
        res.end(bytes);
        return;
      }
      if (/\/v1\/accounts\/[^/]+\/events\/stream$/.test(p)) {
        const after = url.searchParams.get('after');
        state.streamOpens.push(after);
        req.on('close', () => state.streamCloses.push(after));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': heartbeat\n\n');
        const script = state.streams;
        if (!script) {
          res.end();
          return;
        }
        script({ after, send: (event) => res.write(`id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`), end: () => res.end() });
        return;
      }
      if (/^\/v1\/accounts\/[^/]+\/consumers\/[^/]+\/ack$/.test(p) && req.method === 'POST') {
        return readJson(req, (body) => {
          state.acks.push(body.cursor);
          return json(200, { ok: true });
        });
      }
      return json(404, { error: { code: 'not_found', message: p } });
    },
  );

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `https://127.0.0.1:${port}/v1`,
    state,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readJson(req, done) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    done(text ? JSON.parse(text) : {});
  });
}
