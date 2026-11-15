/**
 * 媒体：上传（multipart → sourceId）与媒体发送。
 * 传输层永远是 https + 证书校验，这里连的是真 HTTPS 假服务。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentWechatApiClient } from '../src/api/client.ts';
import { Outbound } from '../src/messaging/outbound.ts';
import { WorldStore } from '../src/identity/store.ts';
import { AGENTWECHAT_DEFAULTS } from '../src/config.ts';
import { join } from 'node:path';
import { FIXTURES, startMockApi } from './helpers/mock-api.mjs';

/** Transport 只吃 PEM（DER 的 .cer 读成 UTF-8 就成了乱码）。 */
const CA_PEM = join(FIXTURES, 'test-ca.pem');

const BYTES = Buffer.from('hello media 你好', 'utf8');

async function harness(configPatch = {}, sendScenario) {
  const api = await startMockApi({ sendScenario });
  const client = new AgentWechatApiClient({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA_PEM, timeoutMs: 5000 });
  const store = new WorldStore(await mkdtempDir());
  const config = { ...AGENTWECHAT_DEFAULTS, enabled: true, baseUrl: api.baseUrl, accountId: 'account-1', mediaEnabled: true, ...configPatch };
  const outbound = new Outbound({ client, store, config: () => config, log: { info() {}, warn() {} } });
  return {
    api,
    client,
    store,
    outbound,
    async close() {
      client.destroy();
      await api.close();
      await store.close?.();
    },
  };
}

async function mkdtempDir() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'awx-media-'));
}

test('上传走 multipart，响应里的 id 就是 sourceId', async () => {
  const h = await harness();
  try {
    const uploaded = await h.client.upload('account-1', { bytes: BYTES, fileName: '报告 2026.pdf', mimeType: 'application/pdf' });
    assert.match(uploaded.sourceId, /^src-/);
    assert.equal(uploaded.byteLength, BYTES.byteLength);
    assert.equal(h.api.state.uploads.length, 1);
    const record = h.api.state.uploads[0];
    assert.equal(record.boundaryOk, true, '必须是带 boundary 的 multipart');
    assert.equal(record.multipart, true);
    assert.equal(record.source.name, '报告 2026.pdf', '文件名要原样送达');
    assert.equal(record.source.byteLength, BYTES.byteLength, '字节数要对得上');
  } finally {
    await h.close();
  }
});

test('发媒体：先上传再按 sourceId 发送，请求体是 kind + sourceId', async () => {
  const h = await harness();
  try {
    const uploaded = await h.client.upload('account-1', { bytes: BYTES, fileName: 'report.pdf', mimeType: 'application/pdf' });
    const result = await h.outbound.sendMedia({ threadId: 'wxid_a', kind: 'file', sourceId: uploaded.sourceId, fileName: 'report.pdf' });
    assert.equal(result.ok, true);
    assert.equal(h.api.state.sends.length, 1);
    assert.equal(h.api.state.sends[0].body.kind, 'file');
    assert.equal(h.api.state.sends[0].body.sourceId, uploaded.sourceId);
    assert.equal(h.api.state.sends[0].body.threadId, 'wxid_a');
    assert.match(h.api.state.sends[0].key, /^awx-/);
  } finally {
    await h.close();
  }
});

test('媒体未启用时不上传也不发送', async () => {
  const h = await harness({ mediaEnabled: false });
  try {
    const result = await h.outbound.sendMedia({ threadId: 'wxid_a', kind: 'image', sourceId: 'src-1' });
    assert.equal(result.ok, false);
    assert.match(result.error, /mediaEnabled/);
    assert.equal(h.api.state.sends.length, 0);
  } finally {
    await h.close();
  }
});

test('媒体发送重复用同一幂等键只产生一条发送记录', async () => {
  const h = await harness();
  try {
    const first = await h.outbound.sendMedia({ threadId: 'wxid_a', kind: 'file', sourceId: 'src-1', idempotencyKey: 'awx-fixed-media' });
    const second = await h.outbound.sendMedia({ threadId: 'wxid_a', kind: 'file', sourceId: 'src-1', idempotencyKey: 'awx-fixed-media' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true, '已接受过的键直接复用结果');
    assert.equal(h.api.state.sends.length, 1);
  } finally {
    await h.close();
  }
});
