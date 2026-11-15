/**
 * 配置：安全默认值、归一化、激活前校验，以及"配置组里的键必须真的存在默认值"。
 * 最后一条不是洁癖：Core 的 dry-mount 会按 schema 路径查 defaults，对不上就挂不起来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTWECHAT_DEFAULTS, AGENTWECHAT_ID, agentWechatConfigGroup, defaultVoiceModelDir, normalizeConfig, validateConfig,
} from '../src/config.ts';

test('默认值偏保守：只开私聊，群聊与媒体默认关，群聊默认只响应 @', () => {
  assert.equal(AGENTWECHAT_DEFAULTS.enabled, false, '装好不等于自动开');
  assert.equal(AGENTWECHAT_DEFAULTS.directMessagesEnabled, true);
  assert.equal(AGENTWECHAT_DEFAULTS.groupMessagesEnabled, false);
  assert.equal(AGENTWECHAT_DEFAULTS.groupMentionOnly, true);
  assert.equal(AGENTWECHAT_DEFAULTS.mediaEnabled, false);
  assert.deepEqual(AGENTWECHAT_DEFAULTS.allowedThreads, []);
});

test('归一化：去掉首尾空格、丢掉 allowedThreads 里的空值与非法项', () => {
  const cfg = normalizeConfig({
    baseUrl: '  https://192.168.32.2:7443/v1  ',
    accountId: '  account-1 ',
    allowedThreads: [' wxid_a ', '', '   ', 123, 'wxid_b'],
  });
  assert.equal(cfg.baseUrl, 'https://192.168.32.2:7443/v1');
  assert.equal(cfg.accountId, 'account-1');
  assert.deepEqual(cfg.allowedThreads, ['wxid_a', 'wxid_b']);
});

test('校验：必须是 https，越界超时被拒，缺地址不阻止挂载', () => {
  assert.throws(() => validateConfig(normalizeConfig({ baseUrl: 'http://192.168.32.2:7443/v1' })), /https/);
  assert.throws(() => validateConfig(normalizeConfig({ baseUrl: 'https://nas.local/v1', requestTimeoutMs: 500 })), /requestTimeoutMs/);
  assert.throws(() => validateConfig(normalizeConfig({ baseUrl: 'https://nas.local/v1', reconnectMaxMs: 9999999 })), /reconnectMaxMs/);
  assert.throws(() => validateConfig(normalizeConfig({ baseUrl: 'https://nas.local/v1', caCertFile: 'bad\npath' })), /caCertFile/);
  // 地址还空着时只算"未配置"，不能因为校验把 World 挡在门外
  assert.doesNotThrow(() => validateConfig(normalizeConfig({})));
  assert.equal(AGENTWECHAT_DEFAULTS.baseUrl, '');
});

test('配置组的每个键都能在默认值里找到，且不含令牌字段', () => {
  const group = agentWechatConfigGroup('zh');
  const prefix = `worlds.${AGENTWECHAT_ID}.`;
  const keys = Object.keys(group.schema.properties ?? {});
  assert.ok(keys.length >= 10, `配置项太少：${keys.length}`);
  for (const key of keys) {
    assert.ok(key.startsWith(prefix), `配置键不在 worlds.${AGENTWECHAT_ID} 下：${key}`);
    const field = key.slice(prefix.length);
    assert.ok(field in AGENTWECHAT_DEFAULTS, `默认值里没有 ${field}，dry-mount 会挂`);
  }
  assert.ok(!keys.some((key) => /token|secret/i.test(key)), '令牌不应该出现在配置组里');
});

test('语音模型目录：从 dataDir 往上找到真正的 models/desktop-pet，而不是按固定层数硬拼', () => {
  const home = mkdtempSync(join(tmpdir(), 'awx-home-'));
  const modelDir = join(home, 'models', 'desktop-pet', 'sensevoice-small-int8-2024-07-17');
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'model.int8.onnx'), 'x');
  writeFileSync(join(modelDir, 'tokens.txt'), 'x');
  // World 的 dataDir 是 <home>/companion/data，和模型目录差两层。
  const dataDir = join(home, 'companion', 'data');
  mkdirSync(dataDir, { recursive: true });
  const saved = process.env.CORTICO_HOME;
  delete process.env.CORTICO_HOME;
  try {
    assert.equal(defaultVoiceModelDir(dataDir), modelDir);
    // 版本号变了：同目录里第一份能用的模型也算数。
    const other = join(home, 'models', 'desktop-pet', 'sensevoice-2026-01-01');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'model.onnx'), 'x');
    writeFileSync(join(other, 'tokens.txt'), 'x');
    rmSync(modelDir, { recursive: true, force: true });
    assert.equal(defaultVoiceModelDir(dataDir), other);
    // CORTICO_HOME 指对了就不依赖 dataDir。
    rmSync(join(home, 'companion'), { recursive: true, force: true });
    process.env.CORTICO_HOME = home;
    assert.equal(defaultVoiceModelDir(join(tmpdir(), 'nonexistent-xyz')), other);
    // 一份都没有：给出最可能的路径，让报错指得到位置。
    delete process.env.CORTICO_HOME;
    rmSync(join(home, 'models'), { recursive: true, force: true });
    assert.equal(defaultVoiceModelDir(dataDir), join(home, 'models', 'desktop-pet', 'sensevoice-small-int8-2024-07-17'));
  } finally {
    if (saved === undefined) delete process.env.CORTICO_HOME; else process.env.CORTICO_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
