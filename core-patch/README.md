# Coopanion 多会话（每会话独立上下文）补丁

给 Coopanion 0.2.20 自带的 Core / Persona 打的最小改动：让同一个 Persona、同一套模型与 Memory
可以同时拥有多个**互相独立上下文**的常驻会话，每个外部聊天（微信联系人、群聊）各占一个。

## 为什么需要

Coopanion 的公开 World 扩展接口（cortico api 6）**无法**做到按会话隔离：

- `Core` 只承认**恰好一个**接收事件投递的常驻 session（`core/core.ts` 构造期断言）。
- 全进程只有一个 `SessionLog`（`session-main.jsonl`），一份上下文。
- `senderKey` 只是事件过滤键，不切分上下文。
- `WorldHost` 没有“把这条事件投给哪个会话”的参数。

因此每个联系人的消息都会落进同一份对话历史，人格会串台。

## 改了什么（5 个文件）

| 文件 | 改动 |
|---|---|
| `build/cortico/src/core/types.ts` | `PushOptions.session`：World 推送事件时指定目标会话。新增可选 Persona 钩子 `declareSession(id)`。 |
| `build/cortico/src/core/state.ts` | 每会话投递水位 `lastDeliveredCursorBySession`；`main` 仍用旧的 `lastDeliveredCursor` 字段（旧状态文件可无缝读取）。 |
| `build/cortico/src/core/loop.ts` | `MainLoop` 按 `sessionId` 记水位、只走属于自己的事件（`isMine`）。 |
| `build/cortico/src/core/core.ts` | 允许多个接收会话：每个会话一套 `SessionLog` + `WakeBus` + `MainLoop`；`pushEvent` 按 `opts.session` 路由；启动/停止/系统前缀重建全部扇形展开；懒装配（首次投递到一个新 id 时向 Persona 要声明）。上限 32 个。 |
| `app/core/persona.ts` | `CoopanionPersona.declareSession()`：接受 `wechat-*` 的会话 id，给它与主会话相同的轮数上限、同一份 Memory/文件工具面，外加 `awx_` 前缀的 World 工具。 |

行为兼容：Persona 只声明一个会话时，行为和改动前完全一致（`main` 优先，否则第一个接收会话当主会话）。

隔离边界：

- 独立：对话历史（各自 `session-<id>.jsonl`）、轮数预算、投递水位、工具表（World 工具按前缀过滤）。
- 共享：模型、供应商、Persona 人格、Memory 目录与记忆工具、World 挂载表、用量统计。

已知限制（v1）：

- WebUI 的会话面板、`sessionInfo`、`contextGauge`、待处理事件队列、`inject*`、`llmStalls` 仍只看主会话。
- 独立会话没有 `outputTap`（World 的发言旁路只挂主会话），因此独立会话的回复走工具调用（`awx_send_*`），
  而不是像主会话那样由旁路直接外发。
- 独立会话的 system 前缀在装配时构建；World 挂载变化会触发全部会话重建前缀。

## 安装

```powershell
# 预览（不写文件）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
# 实际安装（自动备份到 backups\<时间戳>\）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

装完必须**重启 Coopanion**（Core 是 `--import tsx` 直接跑 `.ts` 源码，重启即生效，无需编译）。
PowerShell 若提示“禁止运行脚本”，用上面带 `-ExecutionPolicy Bypass` 的写法。

## 回滚

```powershell
Copy-Item -Recurse -Force .\backups\<时间戳>\* 'D:\002Apps\Coopanion\resources\app\'
```

然后重启 Coopanion。备份是按相对路径原样保存的。

## 升级 Coopanion 之后

应用升级会覆盖这 5 个文件，补丁随之丢失（表现为：所有聊天又回到同一个上下文）。
重新执行：用新版原文件替换 `files\` 下的副本（先对比差异），再把上面的 5 处改动重新应用一遍，
或直接跑 `install.ps1`（若新版源码未变则等于还原这些文件）。升级后请先 `git diff` 式的比对，
不要把旧版补丁硬盖到新版 Core 上。

## 验证

```powershell
# 语法门（无 tsc 可用）
node 'D:\002Apps\Coopanion\resources\app\node_modules\esbuild\bin\esbuild' files\build\cortico\src\core\core.ts --target=node22
# 运行时装载（走真实 cortico/* 解析器）
node --import tsx tests\state-watermark.mjs
```

`tests\state-watermark.mjs` 覆盖：新老水位共存、保存/重载、`clear()` 保留水位、旧状态文件迁移、脏数据丢弃。14 项断言全绿。

## 目录

```
files\       改动后的完整文件（按安装后的相对路径）
backups\     每次安装前的原文件备份
tests\       水位与状态文件测试
install.ps1  安装脚本（ASCII，带 -DryRun）
```
