/**
 * 语法闸门：用 Coopanion 自带的 esbuild 逐文件解析 TS（本机没有 tsc）。
 * 用法：node scripts/check-syntax.mjs [--esbuild <esbuild 可执行文件>]
 * 默认在 Coopanion 的 app 目录下找 node_modules/esbuild/bin/esbuild。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argIndex = process.argv.indexOf('--esbuild');
const esbuild =
  argIndex > 0
    ? process.argv[argIndex + 1]
    : [
        'D:/002Apps/Coopanion/resources/app/node_modules/esbuild/bin/esbuild',
        join(process.env.LOCALAPPDATA ?? '', 'Programs/coopanion/resources/app/node_modules/esbuild/bin/esbuild'),
      ].find((candidate) => existsSync(candidate));

if (!esbuild || !existsSync(esbuild)) {
  console.error('找不到 esbuild，用 --esbuild 指定');
  process.exit(2);
}

const files = [];
walk(join(root, 'src'));
if (files.length === 0) {
  console.error('src 下没有 TS 文件？');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  try {
    // 文件输入不能带 --loader=ts（esbuild 会报"loader without extension"）；输出到 stdout 即解析成功。
    execFileSync(process.execPath, [esbuild, file, '--target=node22'], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`✖ ${file.replace(root, '.')}\n${error.stderr?.toString() ?? error.message}`);
  }
}
console.log(`${files.length - failed}/${files.length} 个文件语法通过`);
process.exit(failed === 0 ? 0 : 1);

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) files.push(full);
  }
}
