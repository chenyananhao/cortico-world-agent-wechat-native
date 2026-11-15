/**
 * 传输层：证书校验、认证失败、超时、以及"错误信息里不许出现令牌"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, Transport } from '../src/api/transport.ts';
import { startMockApi } from './helpers/mock-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CA = join(here, 'fixtures', 'test-ca.pem');
const PFX = { pfx: readFileSync(join(here, 'fixtures', 'test-server.pfx')), passphrase: 'awx-test' };

test('带 CA 时 TLS 校验通过，能读到 /health', async () => {
  const api = await startMockApi();
  const transport = new Transport({ baseUrl: api.baseUrl, token: api.token, caCertFile: CA, timeoutMs: 5000 });
  try {
    const body = await transport.requestJson('/health');
    assert.equal(body.ok, true);
  } finally {
    transport.destroy();
    await api.close();
  }
});

test('不带 CA 时自签证书被拒绝，错误是 tls 而不是静默放行', async () => {
  const api = await startMockApi();
  const transport = new Transport({ baseUrl: api.baseUrl, token: api.token, timeoutMs: 5000 });
  try {
    await assert.rejects(
      () => transport.requestJson('/health'),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, 'tls');
        assert.equal(error.needsOperator, true);
        return true;
      },
    );
  } finally {
    transport.destroy();
    await api.close();
  }
});

test('http:// 的 baseUrl 直接被拒，不会降级成明文', () => {
  assert.throws(
    () => new Transport({ baseUrl: 'http://127.0.0.1:7443/v1', token: 'x', timeoutMs: 1000 }),
    (error) => error instanceof ApiError && error.kind === 'tls',
  );
});

test('令牌错误 → 401 映射成 auth，且报错里不含令牌', async () => {
  const api = await startMockApi();
  const secret = 'super-secret-token-value';
  const transport = new Transport({ baseUrl: api.baseUrl, token: secret, caCertFile: CA, timeoutMs: 5000 });
  try {
    await assert.rejects(
      () => transport.requestJson('/accounts'),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, 'auth');
        assert.equal(error.status, 401);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  } finally {
    transport.destroy();
    await api.close();
  }
});

test('服务端不响应 → timeout，而不是一直挂着', async () => {
  const server = createServer(PFX, () => {
    /* 永不响应 */
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const transport = new Transport({ baseUrl: `https://127.0.0.1:${port}/v1`, token: 't', caCertFile: CA, timeoutMs: 300 });
  try {
    await assert.rejects(
      () => transport.requestJson('/accounts'),
      (error) => error instanceof ApiError && error.kind === 'timeout',
    );
  } finally {
    transport.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
