# 发布到 Coopanion 扩展市场

市场不是往 `Pal-AI-Lab/Coopanion` 提 PR：**包发在 npm，官方索引仓 `Pal-AI-Lab/cortico-extensions` 由 Action 每 30 分钟扫 npm 生成 `catalog.json`**。Coopanion 的扩展页直接查 npm（`text=keywords:cortico-world`，条目 `keywords` 里必须精确含 `cortico-world`），索引仓负责展示名/简介/标签/发布说明/图标截图/评分/讨论帖。

## 0. 发布前只剩这一处要你自己填

`package.json` 里三个 `<你的 GitHub 用户>`（`homepage` / `repository` / `bugs`）和 `author.name` 是占位符，换成你的 GitHub 用户名与署名。仓库建不建都不影响安装，但市场详情页会显示这些链接。

其余已经就位：`private` 已去掉；`publishConfig.access: public`；`cortico.describe` → `describe.json`；`webUiClient` → `src/webui.js`；`cortico.locales` 中英；`LICENSE`（AGPL-3.0-or-later 全文，已加进 `files`）；`CHANGELOG.md` 有 `## 0.6.2` 段落（市场从这段取发布说明）。

## 1. 发布到 npm

```bash
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\cortico-world-agent-wechat-native

# 本机 PowerShell 禁止跑 npm.ps1，用 npm.cmd
npm.cmd login                     # 浏览器里登录 + 2FA
npm.cmd publish --access public   # 包里跑，不要加 --dry-run 后再忘掉
npm.cmd view cortico-world-agent-wechat-native version
```

- 名字 `cortico-world-agent-wechat-native` **在 npm 上还空着**（查过 registry，404）。
- 之后每次改动：改 `package.json` 的 `version` + 在 `CHANGELOG.md` 加同名 `## <version>` 段落，再 `npm.cmd publish`。市场只认版本号更高、`CHANGELOG` 里有对应段落的那种。

## 2. 让市场立刻收录

自动扫描最多等 30 分钟；想马上进，开一张同步 issue（标题前缀 `[sync]`，正文可空）：

```bash
gh issue create -R Pal-AI-Lab/cortico-extensions --title "[sync] cortico-world-agent-wechat-native" --body ""
```

没有 `gh` 就在网页上开：<https://github.com/Pal-AI-Lab/cortico-extensions/issues/new>，标题写 `[sync] cortico-world-agent-wechat-native`，正文留空。Action 会回帖说明结果（收录的版本、找不到包、没有扩展关键字、被拉黑…）然后关掉。

> 本机当前没有 `gh`，npm 也被执行策略挡着（`.ps1` 不让跑），所以第 1、2 步的命令请用 `npm.cmd` 与网页。

## 3. 标签（作者能自己改）

已在 `cortico.tags` 里声明，取自官方词表（`TAGS.md`）：

| 标签 | 为什么 |
|---|---|
| `im` | 接即时通讯平台 |
| `voice` | 能把语音转成文字 |
| `local` | 语音模型在本机跑（`sherpa-onnx-node` + SenseVoiceSmall） |
| `external-setup` | 装包不够，得先有 NAS 上的 `agent-wechat` 守护进程与 Token |
| `unofficial-api` | 用自己账号走非官方微信接口，账号有被限制的风险 |
| `injection-risk` | 第三方写的聊天正文会进模型上下文 |
| `experimental` | 还在演进 |

`wechat`、`self-hosted` 不在词表里，写了会被忽略并给 warning，已删掉。官方标签（`pal-ai-world`、`corti`、`coopanion`）只有维护者能加，作者声明无效。

## 4. 认证（可选，且当前大概率过不了）

`[certify]` 是官方人工审核，要求全部满足：没有错误标签；版本稳定；World 不依赖其他 `cortico-world-*`；至少有过一次后续更新；Action 自动核对项（≥2 个已发布版本、简介非空、`dependencies` 里没有别的 `cortico-world-*`、无警示标签、未被拉黑）。

我们带了 `unofficial-api` 与 `injection-risk` 两个警示标签（这是实话，别为认证撒谎），所以认证要等这两个标签不再适用再申请。想撤自己声明的警示标签：开 `[tags] 包名` issue 说明理由。

## 5. 发布前自检

```bash
node scripts/check-syntax.mjs                                   # 17 个源文件 esbuild 解析
node --import tsx --test tests\*.test.mjs                       # 需要 Coopanion 的 app 目录提供 tsx
```

`pnpm check:extension` 是 Cortico 仓内的脚本，装好的 Coopanion 里没有；等价检查我们已经用 dry-mount 语义做过：`ConfigGroup` 每个键都在 `defaults()` 里、`promptDocs` 的占位符都有变量、`describe.json` 与定义一致。

## 6. 装到别人机器上的两个前置

1. **Core 补丁**：包本身不修改 Coopanion。没有补丁时微信消息全部落 `main` 会话（能收发，但联系人之间串上下文）。补丁在本仓库 `core-patch/`（AGPL-3.0，与 Coopanion 同许可），`install.ps1` 一条命令装，Coopanion 升级后要重跑。
2. **Token**：写进部署的 `.env`（`CORTICO_AGENTWECHAT_TOKEN=…`）或配置面板的 Token 输入框；不会进 `config.json`，也不会出现在日志里。
