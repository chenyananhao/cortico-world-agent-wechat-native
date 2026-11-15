/**
 * 从 `src/definition.ts` 生成 `describe.json`，避免两处手写走样。
 * 用法（在 Coopanion 的 app 目录下跑，借用它的 tsx）：
 *   node --import tsx <repo>/scripts/gen-describe.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { agentWechatDefinition } = await import(new URL('../src/definition.ts', import.meta.url).href);
const describe = agentWechatDefinition.describe;
const payload = {
  tools: describe.tools,
  events: describe.events,
  prompts: [],
};
writeFileSync(join(root, 'describe.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log('describe.json:', payload.tools.length, 'tools,', payload.events.length, 'events');
