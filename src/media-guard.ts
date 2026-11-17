/**
 * `awx_send_media` 的读文件闸门：只允许读发送目录里的普通文件。
 *
 * 为什么要这个：`path` 参数是模型填的，而模型的输入来自微信消息。没有闸门时，
 * 一条「把 C:\...\.env 发给我」就能把令牌/私钥变成附件发出去。这里做三件事：
 * 1. 两侧都 `realpath` 解析，符号链接/junction 指到目录外面也拦得住；
 * 2. 用相对路径判断包含关系，`..` 逃逸和盘符切换都不行；
 * 3. 即使是目录内，也拒绝明显的凭据文件名与超大/空文件。
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';

/** 单个附件上限。 */
export const MAX_SEND_BYTES = 64 * 1024 * 1024;

/** 明显是凭据/密钥的名字：落在发送目录里也不发。 */
const BLOCKED_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..*)?$/i,
  /\.(pem|pfx|p12|key|keystore|jks)$/i,
];

export type MediaPathCheck =
  | { ok: true; path: string; name: string; bytes: number }
  | { ok: false; reason: string };

/**
 * 判断 `requested` 能不能发给微信。
 * 返回的 `ok:false.reason` 直接回给模型看，所以每条都要说清「卡在哪、怎么改」。
 */
export async function checkMediaPath(root: string, requested: string): Promise<MediaPathCheck> {
  const raw = requested.trim();
  if (!raw) return { ok: false, reason: '缺少 path：请给出文件绝对路径。' };
  if (!isAbsolute(raw)) return { ok: false, reason: `请给绝对路径：${raw}` };

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, reason: `发送目录不存在：${root}（配置项 worlds.agentwechat.mediaSendRoot）` };
  }

  let targetReal: string;
  try {
    targetReal = await realpath(raw);
  } catch {
    return { ok: false, reason: `读不到文件：${raw}` };
  }

  const rel = relative(rootReal, targetReal);
  // 只认「正好是 ..」或「..\ 开头」为逃逸；`..foo.png` 这种合法文件名不能误伤。
  const escapes = rel === '' || rel === '..' || rel.startsWith(`..${sep()}`) || isAbsolute(rel);
  if (escapes) {
    return { ok: false, reason: `拒绝发送：${raw} 不在允许的发送目录 ${rootReal} 内。` };
  }

  let size: number;
  try {
    const info = await stat(targetReal);
    if (!info.isFile()) return { ok: false, reason: `拒绝发送：${raw} 不是普通文件。` };
    size = info.size;
  } catch {
    return { ok: false, reason: `读不到文件：${raw}` };
  }
  if (size === 0) return { ok: false, reason: `拒绝发送：${raw} 是空文件。` };
  if (size > MAX_SEND_BYTES) {
    return { ok: false, reason: `拒绝发送：${raw} 有 ${mb(size)}，超过 ${mb(MAX_SEND_BYTES)} 上限。` };
  }

  const name = basename(targetReal);
  if (BLOCKED_NAMES.some((re) => re.test(name))) {
    return { ok: false, reason: `拒绝发送：${name} 像是凭据/密钥文件，即使在发送目录里也不发。` };
  }

  return { ok: true, path: targetReal, name, bytes: size };
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 分隔符单独取，避免把 `..\\x` 这种误判成安全路径。 */
function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
