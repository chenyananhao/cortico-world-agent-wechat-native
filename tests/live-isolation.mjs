/**
 * 会话隔离的端到端验收（需要 Coopanion 重启后补丁生效、World 已启用、至少两个不同会话各来过消息）。
 *
 * 检查的是"真实运行结果"，不是 mock：
 *   1. core-state.json 里出现按会话分开的游标（`lastDeliveredCursorBySession.wechat-*`）；
 *   2. dataDir 下出现 `session-wechat-*.jsonl`，且每个文件只包含它自己那个 thread 的消息；
 *   3. 没有 `wechat-*` 会话的内容混进 `session-main.jsonl`。
 *
 * 用法：node tests/live-isolation.mjs [--data <Coopanion data 目录>]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const argData = process.argv.indexOf('--data');
const dataRoot = argData > 0 ? process.argv[argData + 1] : defaultDataRoot();
if (!dataRoot) {
  console.error('找不到 Coopanion data 目录，用 --data 指定');
  process.exit(2);
}
const companion = join(dataRoot, 'home', 'companion');
const stateFile = join(companion, 'data', 'core-state.json');
const logDir = join(companion, 'data');

let stateCache = null;
const problems = [];
const ok = (message) => console.log(`✔ ${message}`);
const bad = (message) => {
  problems.push(message);
  console.log(`✖ ${message}`);
};

if (!existsSync(stateFile)) {
  console.error(`没有找到 ${stateFile}（Core 还没跑过？）`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const watermarks = state.lastDeliveredCursorBySession ?? {};
const isolated = Object.keys(watermarks).filter((id) => id.startsWith('wechat-'));

if (isolated.length === 0) {
  bad('还没有任何 wechat-* 会话游标：补丁未生效（未重启）或 World 没收到消息');
} else {
  ok(`${isolated.length} 个独立会话有游标：${isolated.join(', ')}`);
}

const files = existsSync(logDir) ? readdirSync(logDir).filter((name) => name.startsWith('session-wechat-') && name.endsWith('.jsonl')) : [];
if (files.length === 0) {
  bad('没有 session-wechat-*.jsonl：独立会话还没有落盘（没有消息进来过？）');
} else {
  ok(`独立会话日志 ${files.length} 个：${files.join(', ')}`);
}

// 每个独立会话的日志里，只允许出现它自己那一份"投递标记"。
// 判定用结构标记 `"session":"wechat-XXX"`（Core 写给每个事件的路由标签），不做裸字符串匹配 ——
// 群里聊到 `wechat-bridge-next.md` 这类文件名不是串台，写报告时提到会话名也不是串台。
// 投递正文的形状：我们渲染的气泡正文以「<说话人> 在私聊：」或「<说话人> 在群「群名」：」开头。
// 判定只认"事件投递正文的开头"，不认文中提到 —— 报告、工具输出里出现这些词不算串台。
const DELIVERY_BODY = /^[^\n[]{1,48} 在(私聊|群「)/;

function deliveryBodies(text) {
  const bodies = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"version"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const item = record.item;
    if (!item || item.type !== 'function_call_output' || typeof item.output !== 'string') continue;
    const cut = item.output.indexOf('\n');
    if (cut < 0) continue;
    bodies.push(item.output.slice(cut + 1));
  }
  return bodies;
}

for (const file of files) {
  const sessionId = file.replace(/^session-/, '').replace(/\.jsonl$/, '');
  const text = readFileSync(join(logDir, file), 'utf8');
  const foreign = new Set();
  for (const match of text.matchAll(/"session":"(wechat-[^"]+)"/g)) {
    if (match[1] !== sessionId) foreign.add(match[1]);
  }
  if (foreign.size > 0) bad(`${file} 里出现了别的会话的投递标记：${[...foreign].join(', ')}`);
  else ok(`${file} 只包含自己的会话内容（${(text.length / 1024).toFixed(1)} KB）`);

  const bodies = deliveryBodies(text);
  const own = bodies.filter((body) => DELIVERY_BODY.test(body)).length;
  if (own === 0) bad(`${file} 里没有一条微信投递正文：这条会话可能没真正收到消息`);
  else ok(`${file} 收到 ${own} 次微信投递`);

  // 群聊会话里不该出现"在私聊 ："，私聊会话里不该出现"在群「" —— 两者是不同会话的正文形状。
  const kind = threadKindFor(sessionId);
  if (kind === 'group') {
    const directLike = bodies.filter((body) => / 在私聊：/.test(body)).length;
    const groupLike = bodies.filter((body) => / 在群「/.test(body)).length;
    if (directLike > 0) bad(`${file} 是群会话，却出现了 ${directLike} 条私聊投递正文`);
    else if (groupLike === 0) bad(`${file} 是群会话，但没有群聊投递正文`);
    else ok(`${file} 只含群聊投递正文（${groupLike} 条），没有混入私聊`);
  } else if (kind === 'direct') {
    const groupLike = bodies.filter((body) => / 在群「/.test(body)).length;
    const directLike = bodies.filter((body) => / 在私聊：/.test(body)).length;
    if (groupLike > 0) bad(`${file} 是私聊会话，却出现了 ${groupLike} 条群聊投递正文`);
    else if (directLike === 0) bad(`${file} 是私聊会话，但没有私聊投递正文`);
    else ok(`${file} 只含私聊投递正文（${directLike} 条），没有混入群聊`);
  }
}

const mainFile = join(logDir, 'session-main.jsonl');
if (existsSync(mainFile) && files.length > 0) {
  const mainText = readFileSync(mainFile, 'utf8');
  const marked = new Set([...mainText.matchAll(/"session":"(wechat-[^"]+)"/g)].map((match) => match[1]));
  const leaked = deliveryBodies(mainText).filter((body) => DELIVERY_BODY.test(body));
  if (marked.size > 0) bad(`session-main.jsonl 里出现了微信会话的投递标记：${[...marked].join(', ')}`);
  else if (leaked.length > 0) bad(`session-main.jsonl 里出现了 ${leaked.length} 条微信投递正文（应当只进各自的会话）`);
  else ok('session-main.jsonl 没有被微信会话污染（无投递标记、无微信投递正文）');
} else if (files.length === 0) {
  ok('还没有独立会话，跳过 main 污染检查');
}

if (problems.length > 0) {
  console.error(`\n${problems.length} 项未通过`);
  process.exit(1);
}
console.log('\n会话隔离验收通过');
process.exit(0);

function threadKindFor(sessionId) {
  const statePath = join(companion, 'data', 'agentwechat-state.json');
  if (!stateCache) {
    try {
      stateCache = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      stateCache = {};
    }
  }
  const threads = stateCache.threads ?? {};
  for (const record of Object.values(threads)) {
    const threadId = String(record.threadId ?? '');
    if (threadId === '') continue;
    const candidates = [
      `wechat-${threadId.replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 120),
      `wechat-${threadId.replace(/[^A-Za-z0-9]+/g, '-')}`.slice(0, 120),
    ];
    if (candidates.includes(sessionId)) return record.threadType ?? 'unknown';
  }
  return 'unknown';
}

function defaultDataRoot() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'coopanion', 'data-location.json'),
    join(process.env.APPDATA ?? '', 'coopanion', 'data-location.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed.data === 'string' && existsSync(parsed.data)) return parsed.data;
    } catch {
      /* 坏文件就当没有 */
    }
  }
  return null;
}
