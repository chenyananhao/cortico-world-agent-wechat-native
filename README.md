# cortico-world-agent-wechat-native（NAS 微信）

把 NAS 上 `agent-wechat-native` 暴露的微信账号接入 Coopanion / Cortico，成为**一个 World**：微信私聊与群聊各自是一个独立会话，共用同一套模型、人格、Memory 和插件。

- World ID：`agentwechat`，显示名「NAS 微信」，配置路径 `worlds.agentwechat`
- 工具前缀 `awx_`，事件前缀 `agentwechat.`
- 主类 `AgentWechatWorld`，API 客户端 `AgentWechatApiClient`

## 前置条件（必须）

1. **Coopanion 已安装并能启动**（本 World 按 `cortico` api 6 编写；可选补丁按 0.2.20 的 Core 源码制作）。
2. NAS 上的 `agent-wechat-native` 在线，且 Coopanion 信任其 TLS 证书（把 CA 装进系统信任库，或在本 World 配置里填 `caCertFile`）。
3. 一个具备 `read` / `send` / `media` 权限的 API Token（不新建、不撤销，直接复用现有令牌）。

**不装 Core 补丁也能用**：消息照收、语音照转、附件照发，只是所有联系人和群共用 `main` 一个会话上下文，会串台。想要「每个微信会话各自独立」，再装下面这个可选补丁。

## 可选：Core 补丁（让每个联系人拥有独立会话）

**作用**：原版 Core 要求一个 Persona「恰好一个」接收事件的常驻 session，且全进程只有一份 `session-main.jsonl`。这个补丁把限制打开：每个微信会话（私聊某联系人、某个群）各占一个 session，各有自己的对话历史、轮次预算与投递水位，同时共用同一套模型、人格、Memory 和工具表。

- 代码与详细说明：<https://github.com/chenyananhao/cortico-world-agent-wechat-native/tree/main/core-patch>
- npm 包里**不含**它（`files` 只发 `src`/`assets`/`describe.json` 等）；它改的是 Coopanion 自己的 `resources\app`，必须在本机安装、并且每次 Coopanion 升级后重装。

安装（三步）：

```powershell
# 1. 取补丁（在仓库里，不在 npm 包里）
git clone https://github.com/chenyananhao/cortico-world-agent-wechat-native.git
cd cortico-world-agent-wechat-native\core-patch

# 2. 预览 + 实际安装（自动备份到 backups\<时间戳>\）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 3. 重启 Coopanion（Core 以 --import tsx 直接跑 .ts 源码，重启即生效）
```

**回滚**：把 `core-patch\backups\<时间戳>\` 里的文件按相对路径覆盖回 `...\resources\app\`，再重启。

**升级注意**：Coopanion 升级会覆盖这 5 个文件，补丁随之失效（表现为所有聊天又回到同一个上下文）；升级后重跑 `install.ps1`，并先比对新版源码再盖。

**验收**：重启后每个微信会话会出现自己的 `session-wechat-*.jsonl`，`core-state.json` 的 `lastDeliveredCursorBySession` 里有对应条目，`session-main.jsonl` 不被微信消息污染。

## 安装

扩展目录由 Coopanion 的 `data/extensions` 管理（pnpm workspace + `node_modules`）。

```powershell
# 一条命令装好（改 data 目录时传 -ExtensionsDir；先 -DryRun 看一眼）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionsDir '<Data>\extensions'
```

它只做三件事，且都留时间戳备份：在 `extensions/package.json` 的 `dependencies` 里加一条 `link:`（跨盘时用绝对路径，pnpm 也认）、在 `node_modules` 下建指向本仓库的 junction、在 `world-owners.json` 里登记 `agentwechat`。

手工等价步骤：

```powershell
$ext = '<Data>\extensions'
cmd /c mklink /J "$ext\node_modules\cortico-world-agent-wechat-native" "<本仓库路径>"
# 再往 $ext\package.json 的 dependencies 里加：
#   "cortico-world-agent-wechat-native": "link:<本仓库路径，跨盘用绝对路径>"
# 可选：$ext\world-owners.json 里加 { "agentwechat": "cortico-world-agent-wechat-native" }
```

然后重启 Coopanion，在「扩展 / Worlds」里启用「NAS 微信」。

> 也可以只把本仓库放进 `node_modules`（复制或 junction），只要 `package.json` 的 `dependencies` 里登记了包名即可，Core 是按 `extensions/package.json` 的依赖名 + `node_modules/<name>` 来发现扩展的。

## 配置（worlds.agentwechat）

| 键 | 说明 | 默认 |
|---|---|---|
| `baseUrl` | NAS API 根地址，必须 `https://` | 空 |
| `accountId` | 微信账号 ID（daemon 的 `GET /accounts` 里那个 `id`，形如 `account-…`） | 空 |
| `caCertFile` | 额外信任的 CA（PEM 路径）；留空则用系统信任库 | 空 |
| `receiveEnabled` | 是否订阅 SSE 收消息 | `true` |
| `sendEnabled` | 是否允许发送 | `true` |
| `directMessagesEnabled` | 处理私聊 | `true` |
| `groupMessagesEnabled` | 处理群聊 | `false` |
| `groupMentionOnly` | 群聊只响应明确 @ 我的消息 | `true` |
| `mediaEnabled` | 处理图片/文件/视频/语音 | `false` |
| `mediaSendRoot` | `awx_send_media` 唯一允许读取的目录（绝对路径）；目录外的文件、符号链接指出去的、`.env`/`*.pem`/`*.key` 这类凭据文件一律拒发 | 空 = `<dataDir>/outbox`（启用媒体时自动创建） |
| `voiceToTextEnabled` | 语音转文字（复用桌宠那套 SenseVoice） | `true` |
| `voiceModelDir` | 语音模型目录；留空则自动定位桌宠那份（从 `CORTICO_HOME` 和 World 的 dataDir 往上找 `models/desktop-pet/<版本>`，找到真正有 `.onnx`+`tokens.txt` 的那层；版本号变了就取同目录第一份能用的） | 空 |
| `voiceLanguage` | 语音识别语言：`auto` / `zh` / `en` / `ja` / `ko` / `yue` | `auto` |
| `voiceMaxSeconds` | 单条语音转写时长上限，`0` = 不限 | `120` |
| `allowedThreads` | 允许处理的会话白名单（`threadId`），空 = 不限制 | `[]` |
| `requestTimeoutMs` | 单次请求超时 | `20000` |
| `reconnectMaxMs` | SSE 重连退避上限 | `30000` |

**令牌不写进 `config.json`**：在配置面板调用 `setToken`（POST，只写 SecretStore），或设置环境变量 `CORTICO_AGENTWECHAT_TOKEN`。日志与错误信息里都不会出现令牌。

## 工具

| 工具 | tag | 作用 |
|---|---|---|
| `awx_status` | read | 连接/账号/SSE/游标/最近错误/最近发送 |
| `awx_threads` | read | 列出会话（私聊/群聊）与未读数 |
| `awx_messages` | read | 读某个会话最近的消息 |
| `awx_contacts` | read | 查联系人（可过滤） |
| `awx_send_text` | write | 给"当前会话"发文字，可引用回复、可 `mentions` 点名群成员；带幂等键 |
| `awx_send_status` | read | 按 `sendId` 或幂等键查真实发送状态（accepted/queued/failed/needs_review） |
| `awx_send_media` | write | 媒体发送：先上传拿 sourceId，再按 sourceId 发 |

`awx_send_text` 的目标会话来自**工具调用上下文里的 session**（`ctx.role`），不是模型嘴里说的 id —— 这样回复必然回到产生消息的那个微信会话。

## 运行状态监控（0.7.2）

状态面板分别监控以下项目：

- **NAS API**：accounts API 是否可访问。
- **微信登录**：读取账号的 `authenticated`，显示已登录/未登录/未知。
- **微信连接**：读取 `connection`，显示在线/离线/其他原始状态。
- **消息事件流**：独立显示 SSE 连接状态。
- **账号运行详情**：自动连接、联系人同步、接收传输方式、原生运行环境、待处理投影批次、Schema 兼容性和存储模式。
- **错误记录**：显示最近错误内容、来源和发生时间。

World 启动时立即检查一次账号状态，之后每 15 秒向 NAS 查询一次；网页仍按原有 5 秒周期刷新快照。监控只读，不会触发登录、退出、重连或清理 NAS 数据。

## 事件

| 事件 | trigger | 说明 |
|---|---|---|
| `agentwechat.message` | `debounce` | 一条可投递的微信消息，`meta` 带 `accountId/threadId/threadKind/session/messageId/senderId/senderName/threadName` |
| `agentwechat.receipt` | — | 发送结果回执 |
| `agentwechat.status` | — | 连接/账号/SSE 状态变化 |

## 会话与身份

- 主键 `accountId + threadId`（`threadKey()`），会话 id `wechat-<threadId>`（群 id 的 `@` 折成 `-`）。
- 持久化：`<world dataDir>/agentwechat-state.json`（原子写、坏文件改名保底），存会话记录、事件游标、已处理消息（去重窗口 400 条）、发送记录（200 条）。
- 群聊记录的是**群成员**（`senderId` + 成员名），不是"群"本身。
- 不复制聊天记录到第二套 Memory：Memory 仍是 Coopanion 原来那一套。
- **记忆分域（v0.6.1）**：事件的 `senderKey` 就是记忆域，私聊 `awx.<联系人 id>`、群 `awx.g.<群号>`（`memoryScopeOf()`）。private-companion 的事件域由 `senderKey` 经 `cleanScope()` 得出，而它的 `activeScope()` 取「最后一个说话的人」——旧键 `account-…|wxid_…` 带 `|` 不合法，会被整段洗成 `main`，于是微信和桌宠共用主人层、谁最后说话另一边就读谁。现在每个微信会话自成一域。
- **主人层约定（v0.6.1）**：`src/ENV_PROMPT.md` 通过 `webUi().promptDocs` 作为环境提示词注入，要求关于主人的事实/规则写 `scope:"main"`、检索默认 `scope:"*"`、会话内经历留本会话域、群聊内容不进 `main`。`people()`/`openThreads()` 本身不分域，属于天然共享。

## 可靠性

- SSE：`?after=<cursor>` + `Last-Event-ID` 双保险；断线指数退避重连；心跳注释不算事件。
- 去重：先按 `messageId` 判重再取详情；重复推送不重复交付。
- 游标：只有处理成功（含"有意跳过"）才前进；取详情失败就停在原地等重放。
- 卡死保护：同一条事件连续失败第 3 次就记 `error`、推进游标并继续（`snapshot().skipped` 计数），否则一条永远处理不了的坏消息会让每次重连都重放它、把后面所有消息堵死；失败 1～2 次仍然重放，不把偶发抖动当成坏消息丢掉。
- 发送：每次逻辑发送一个 `Idempotency-Key`；超时/断网先 `GET /accounts/{account}/sends/by-idempotency-key` 补查，再用**同一个键**重试；`needs_review` 照实返回"结果未知"。
- 发送状态：`POST /sends` 只返回 `queued` 时按 0.4s/0.9s/2s 退避查 `GET /accounts/{account}/sends/{id}`，`accepted` 才叫送达，一直排队就报"已入队未确认送达"。World 启动时还会补查上次留下的非终态发送并订正本地记录。
- 生命周期：World 停用 → `stop()` 中止 SSE、销毁连接与定时器；重新启用 → 从游标续传。
- **改代码后的生效方式**：`POST /api/worlds/restart` 只重新挂载 World，**不会**重新加载扩展模块（进程内 ESM 缓存）；改了 `src/` 必须整进程重启 Coopanion。

## 安全

- 只用 `node:https`，`rejectUnauthorized` 永远 `true`，没有任何开关可以关掉证书校验。
- Token 只在 `Authorization` 头里；错误信息与日志都脱敏。
- World 侧不写聊天全文到日志，只记 `messageId`/`threadId`/长度等必要字段。
- **发送目录闸门（v0.7.0，重要）**：`awx_send_media` 的 `path` 是模型填的、而模型的输入来自微信消息，所以不能让它读全盘。现在只允许读 `mediaSendRoot`（默认 `<dataDir>/outbox`）：两侧都 `realpath` 解析（符号链接/junction 指到目录外也算出去）、按相对路径判断包含关系（`..` 逃逸、换盘符都拒）、只接受普通文件、单文件 ≤ 64 MiB，并且连目录内的 `.env`/`*.pem`/`*.pfx`/`*.key`/`id_rsa*`/`credentials*` 这类凭据文件也拒发。被拒时模型会收到具体原因（哪个目录、为什么不许），不会静默失败。

## 未实现（v0.7.0）

- Core 自带的会话历史/`sessionInfo`/`contextGauge` 面板仍只展示 `main`（Core 补丁的 v1 限制）；本 World 的 `threads` 面板列出每个微信会话与其 session id、最近活动。
- 群成员 @ 的 `positions` 精确偏移未使用，只传 `userIds`（微信会自己按名字定位）。
- 语音已能转成文字进上下文（见下），但音频本身仍不作为可听附件交给模型；`mediaEnabled` 关掉时语音只写「（语音，媒体未启用）」。

## 已实现

- **v0.7.0 发送目录闸门**：`awx_send_media` 不再能读任意路径，只接受 `mediaSendRoot`（默认 `<dataDir>/outbox`）里的普通文件；`realpath` 双向解析防符号链接逃逸，拒 `.env`/`*.pem`/`*.key`/`id_rsa*`/`credentials*` 等凭据文件，拒空文件与 >64 MiB（`src/media-guard.ts`，7 项单测）。启用媒体时 World 启动会建好这个目录，`awx_status` 与状态面板都会显示当前路径。
- **v0.6.1 记忆分域**：`senderKey` 从 `account-…|wxid_…` 改成合法域 `awx.<联系人 id>` / `awx.g.<群号>`（`src/protocol.ts` 的 `memoryScopeOf()`），不再被 private-companion 的 `cleanScope()` 洗成 `main`；同时用 `src/ENV_PROMPT.md`（`webUi().promptDocs`，`role: 'envPrompt'`）把「主人事实写 `main`、检索用 `*`、群聊不进主人层」写进环境提示词。要生效得重启 Coopanion。
- **v0.6.0 语音转文字**：微信语音（daemon 已转 `audio/wav` 16 kHz 单声道 PCM16）用桌宠那套 `sherpa-onnx-node` + SenseVoiceSmall 转写，正文变成 `（语音）好的好的。`，`meta.transcript` 带原文，`awx_status` 与状态面板显示「语音转写：已就绪（auto · model.int8.onnx · 已转 N 条）」。真机实测：模型载入 889 ms、2.06 s 语音转写 995 ms。只取 `state:"available"` 的音轨（同一条消息常另有一条 `pending`，取内容会 409）；失败写具体原因并照常投递；按 `${messageId}|${assetId}` 缓存，SSE 重放不重跑。
- **v0.5.1 媒体发送不 400 了**：真机上 `POST /sends` 的媒体体多一个 `fileName` 就整单 `400 invalid_request`（A/B 实测：去掉即 202），现在只发 `kind + threadId + sourceId`；上传一直没问题（multipart 字段 `file`，中文文件名 26 KB webp 实测 201）。另外服务端只回错误码时，报错会带上原始响应体片段，方便下次定位。
- **v0.5.0 读历史有正文**：真实 daemon 的 `GET /threads/{threadId}/messages` 条目正文字段叫 `body`（官方文档里写的 `text` 在真机上没有），旧版读 `text` 所以每条都显示「（无文本）」。现在先读 `body`、再退回 `text`。
- **v0.5.0 微信会话能用全部 World 工具**：Core 补丁的 `CoopanionPersona.declareSession()` 原来只把 `awx_*` 给隔离会话，现在改成 `this.ioTools()` 全量，微信会话和主会话的工具表一致（`dsh_send`、`weather_*`、`learn_*`、`recall_*`、`emote_pic`、`qqbot_*`、`console_send`…都在）。要生效得重跑 `core-patch\install.ps1` 并重启 Coopanion。
- **v0.4.9 浏览器端面板产物**：新增 `src/webui.js`（原生 ESM，无需构建）并在 `package.json` 的 `cortico.webUiClient` 登记。Core 只把自定义面板交给 `{ panels: { id: { mount(ctx) } } }` 这样的浏览器 bundle 渲染，没有它面板会报「缺少面板构建产物」。现在「状态」面板显示 API 连接/账号/SSE/游标/会话数/投递/跳过/最近事件/最后错误/最近发送，可刷新、可填 Token；「会话」面板列出每个微信会话。
- **v0.4.8 群聊 @ 三级判定**：`mentions.self` → `userIds` 命中自己 wxid → 正文出现「@自己的显示名」。真实 daemon 对群里 @ 常给出 `self:false, userIds:[]`，只认 `self` 会把合法 @ 全丢掉。
- **v0.4.8 发送状态周期补查**：每 45 秒把本地 `queued`/`unknown` 的记录追到服务端终态，`stop()` 时清除。

- **v0.4.6 媒体判定修正（重要）**：真实 daemon 的图片/文件消息详情是 `{body: null, media: []}`，附件清单只在 `media/lookup` 里。旧版按 `message.media` 判断，导致纯媒体消息被判成「空消息」丢掉。现在按**消息类型**（3/34/43/47/49）放行并主动 lookup，正文补「（附件：图片）」。
- **v0.4.4**：`awx_send_status` 可查真实发送状态；`awx_send_text` 的 `mentions`/`mentionAll` 真的进发送体。
- **v0.4.0 媒体接收**：`mediaEnabled` 打开后取附件字节，作为事件 `blobs` 交给 Core（`{bytes, mime, name, fallbackText}`）；模型收该 MIME 就看到内容，否则只看到说明。单条最多 4 个附件、合计 48 MiB。type 49 带附件的消息（微信文件）现在也会进来。
- **v0.4.3 修路径**：接收侧媒体走真实 daemon 的账号分区路由 `POST /accounts/{account}/media/lookup`（响应 `{items:[{messageId,assets,error?}]}`）与 `GET /accounts/{account}/media/{id}/content`；文档里的全局 `/media/*` 在 2.4.0 上 404。会话分区形状：一条图片消息常带多个变体，逐条按清单取。
- **v0.3.0**：发送状态轮询与启动补查；发送路由改为按账号分区（`/accounts/{account}/sends/...`）。
- **v0.2.0 媒体发送**：`awx_send_media` 走官方两步——`POST /accounts/{account}/uploads`（multipart 字段 `file`，响应 `OwnedMediaSource`）拿 `sourceId`，再 `POST /sends` 带 `kind`+`sourceId`。受 `sendEnabled` 与 `mediaEnabled` 双重开关约束，上传失败不会产生半截发送。
- 上传组包在 `src/api/multipart.ts`：`filename="…"` 放原始 UTF-8 名称，另附 RFC 5987 的 `filename*` 兜底。

## 测试

```powershell
# 在 Coopanion 的 app 目录下跑（借它的 tsx；测试用真 HTTPS + 自签 CA 夹具）
node --import tsx --test <本仓库>/tests/*.test.mjs
```

覆盖：TLS 校验/证书拒绝/401/超时、SSE 解析与断线按游标续传、World 生命周期（启用连上 / 停用关连接 / 重新启用带游标）、私聊与群聊投递到各自 session、去重、自己发的消息不回灌、群聊 @ 过滤、媒体清单→内容→事件 blobs、发送幂等与超时补查、`needs_review`、媒体上传（multipart）与媒体发送。

面板自检（Coopanion 运行中）：`GET http://127.0.0.1:17788/api/webui/providers/world%3Aagentwechat/panels/status/snapshot` → 返回连接状态、SSE 状态、游标、最近错误、发送结果。

`describe.json` 由 `scripts/gen-describe.mjs` 从定义生成，必须带 tsx 跑（`node --import tsx scripts/gen-describe.mjs`）：源码是 `.ts`，裸 `node` 的 strip-only 模式不认参数属性。

**会话隔离的端到端验收**（`tests/live-isolation.mjs`）检查真实运行结果——`core-state.json` 里按会话分开的游标、`session-wechat-*.jsonl` 是否各归各（看 `"session":"wechat-…"` 投递标记，不裸匹配名字）、`session-main.jsonl` 是否被污染。已用两个真实会话（私聊 `wechat-chenyananhao` + 群 `wechat-39078316143-chatroom`）跑通；需要补丁生效（重启 Coopanion）且至少两个会话来过消息后才跑得过。

## 卸载

删掉 `node_modules\cortico-world-agent-wechat-native`（或 junction）、从 `extensions/package.json` 移除依赖、从 `world-owners.json` 移除条目，重启 Coopanion。
