/**
 * 发送目录闸门：`awx_send_media` 只能读 `mediaSendRoot` 里的普通文件。
 * 这些用例全部不联网，只测路径判定。
 */
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_SEND_BYTES, checkMediaPath } from '../src/media-guard.ts';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'awx-guard-'));
  const root = join(base, 'outbox');
  const outside = join(base, 'elsewhere');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { base, root, outside };
}

test('目录内的普通文件通过，并回传真实路径与大小', async () => {
  const { root } = sandbox();
  const file = join(root, '猫.png');
  writeFileSync(file, Buffer.from([1, 2, 3, 4]));

  const out = await checkMediaPath(root, file);
  assert.equal(out.ok, true);
  assert.equal(out.name, '猫.png');
  assert.equal(out.bytes, 4);
  // 临时目录可能同时存在 8.3 短名与长名，路径拼写不做等值断言，只看是否落在 outbox 里。
  assert.match(out.path, /outbox/i);
  assert.equal(out.path.endsWith('猫.png'), true);
});

test('`..` 逃逸被拒绝', async () => {
  const { root, outside } = sandbox();
  const file = join(outside, 'secret.txt');
  writeFileSync(file, 'x');

  const out = await checkMediaPath(root, join(root, '..', 'elsewhere', 'secret.txt'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /不在允许的发送目录/);
});

test('符号链接/junction 指到目录外也拒绝（按 realpath 判定）', async () => {
  const { root, outside } = sandbox();
  writeFileSync(join(outside, 'leak.txt'), 'leak');
  const link = join(root, 'linkdir');
  try {
    symlinkSync(outside, link, 'junction');
  } catch (error) {
    // 某些环境不允许建链接：跳过而不是误判成通过。
    assert.ok(error instanceof Error);
    return;
  }

  const out = await checkMediaPath(root, join(link, 'leak.txt'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /不在允许的发送目录/);
});

test('目录本身不是可发送的文件', async () => {
  const { root } = sandbox();
  const dir = join(root, '子目录');
  mkdirSync(dir);

  const out = await checkMediaPath(root, dir);
  assert.equal(out.ok, false);
  assert.match(out.reason, /不是普通文件/);
});

test('发送目录不存在时给出配置提示', async () => {
  const { base } = sandbox();
  const out = await checkMediaPath(join(base, '没有这个目录'), join(base, 'x.txt'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /发送目录不存在/);
  assert.match(out.reason, /mediaSendRoot/);
});

test('凭据文件即使在目录里也不发', async () => {
  const { root } = sandbox();
  const env = join(root, '.env');
  writeFileSync(env, 'CORTICO_AGENTWECHAT_TOKEN=secret');
  const pem = join(root, 'server.pem');
  writeFileSync(pem, '-----BEGIN CERTIFICATE-----');

  for (const file of [env, pem]) {
    const out = await checkMediaPath(root, file);
    assert.equal(out.ok, false);
    assert.match(out.reason, /凭据/);
  }
});

test('空文件与超过上限的文件都拒绝', async () => {
  const { root } = sandbox();
  const empty = join(root, 'empty.txt');
  writeFileSync(empty, '');
  const huge = join(root, 'huge.bin');
  const fd = openSync(huge, 'w');
  ftruncateSync(fd, MAX_SEND_BYTES + 1); // 稀疏文件，不真占 64 MB
  closeSync(fd);

  const a = await checkMediaPath(root, empty);
  assert.equal(a.ok, false);
  assert.match(a.reason, /空文件/);

  const b = await checkMediaPath(root, huge);
  assert.equal(b.ok, false);
  assert.match(b.reason, /超过 64\.0 MB 上限/);
});
