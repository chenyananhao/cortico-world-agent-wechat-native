/**
 * 浏览器端面板产物（Cortico WebUI 契约）。
 *
 * 契约：default 导出 `{ panels: { <panelId>: { mount(ctx) } } }`，panelId 与
 * `webUi()` 里声明的 `panels[].id` 对应；数据一律经 `ctx.invoke(method, args)`
 * 走服务端的 `WorldWebUiDecl.invoke(panel, method, args)`。
 *
 * 这里刻意写成不需要构建的原生 ESM：浏览器直接跑这份文件，改了不用编译，
 * 重启 Coopanion 后刷新页面即可。
 */

const zh = {
  statusTitle: 'NAS 微信状态',
  statusDesc: '连接、账号、事件流与最近一次错误；数据来自 World 侧快照。',
  threadsTitle: '微信会话',
  threadsDesc: '每个联系人/群聊各自一个独立会话，这里列出它们与最近的投递时间。',
  refresh: '刷新',
  refreshing: '读取中…',
  failed: '读取失败',
  api: 'API 连接',
  stream: '事件流',
  cursor: '事件游标',
  threads: '会话数',
  delivered: '本次投递',
  skipped: '跳过事件',
  voice: '语音转写',
  address: '地址',
  accountId: '账号 ID',
  lastEvent: '最近事件',
  lastError: '最后错误',
  lastSend: '最近发送',
  mediaRoot: '发送目录',
  tokenTitle: 'API Token',
  tokenDesc: '令牌只写入部署目录的 .env，不写 config.json，也不会回显。保存后会自动重连。',
  tokenPlaceholder: '粘贴 Bearer Token（不会显示原文）',
  save: '保存并重连',
  saved: '已写入 .env，正在重连…',
  online: '在线',
  offline: '离线',
  unknown: '未知',
  none: '（无）',
  empty: '还没有收到过消息。',
  colThread: '会话',
  colKind: '类型',
  colName: '名称',
  colSession: '独立会话 ID',
  colAt: '最近投递',
  group: '群聊',
  direct: '私聊',
};

function pickText(ctx) {
  const lang = String(ctx.language || 'zh');
  return lang.startsWith('zh') ? zh : { ...zh, statusTitle: 'NAS WeChat status' };
}

function stamp(t) {
  if (!t) return zh.none;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleString();
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/** 语音转写一行：不开 / 等载入 / 已就绪，外加模型与上次失败原因。 */
function voiceLine(v) {
  if (!v || v.enabled !== true) return '未启用';
  const state = v.ready ? '已就绪' : '等第一条语音时载入';
  const model = v.model || `${v.modelDir || '（未配置）'}（找不到模型文件）`;
  const done = typeof v.done === 'number' ? ` · 已转 ${v.done} 条` : '';
  const err = v.lastError ? ` · 上次失败：${v.lastError}` : '';
  return `${state}（${v.language || 'auto'} · ${model}${done}${err}）`;
}

export default {
  panels: {
    status: {
      mount(ctx) {
        const t = pickText(ctx);
        const sheet = ctx.ui.sheet({ title: t.statusTitle, desc: t.statusDesc });
        ctx.root.appendChild(sheet.el);

        const bar = ctx.ui.rowbar();
        const refreshBtn = ctx.ui.button(t.refresh, { variant: 'primary', size: 'sm' });
        const line = ctx.ui.msgline(t.refreshing);
        bar.appendChild(refreshBtn);
        bar.appendChild(line);
        sheet.body.appendChild(bar);

        const stats = ctx.ui.statgrid();
        sheet.body.appendChild(stats);

        const detail = ctx.ui.kv([]);
        sheet.body.appendChild(detail);

        const sendBox = ctx.ui.kv([]);
        sheet.body.appendChild(sendBox);

        const tokenCard = ctx.ui.sheet({ title: t.tokenTitle, desc: t.tokenDesc });
        ctx.root.appendChild(tokenCard.el);
        const tokenInput = ctx.ui.input({ type: 'password', placeholder: t.tokenPlaceholder, cls: 'mono' });
        const saveBtn = ctx.ui.button(t.save, { variant: 'primary', size: 'sm' });
        const tokenLine = ctx.ui.msgline();
        tokenCard.body.appendChild(ctx.ui.field(t.tokenTitle, tokenInput));
        tokenCard.body.appendChild(saveBtn);
        tokenCard.body.appendChild(tokenLine);

        const paint = (data) => {
          stats.textContent = '';
          const add = (k, v) => stats.appendChild(ctx.ui.stat({ k, v: String(v) }));
          add(t.api, data.accountOnline === true ? t.online : data.accountOnline === false ? t.offline : t.unknown);
          add(t.stream, data.sse ?? t.unknown);
          add(t.cursor, data.cursor ?? t.none);
          add(t.threads, data.threads ?? 0);
          add(t.delivered, data.delivered ?? 0);
          add(t.skipped, data.skipped ?? 0);

          detail.textContent = '';
          const rows = [
            [t.address, data.baseUrl || t.none],
            [t.accountId, data.accountId || t.none],
            [
              t.lastEvent,
              data.lastEventAt
                ? `${stamp(data.lastEventAt)}${data.lastEventKind ? ` · ${data.lastEventKind}` : ''}`
                : t.none,
            ],
            [t.lastError, data.lastError || t.none],
            [t.voice, voiceLine(data.voice)],
            [t.mediaRoot, data.mediaRoot || t.none],
          ];
          for (const [k, v] of rows) {
            const tr = document.createElement('tr');
            const td1 = document.createElement('td');
            td1.textContent = k;
            const td2 = document.createElement('td');
            td2.textContent = String(v);
            tr.append(td1, td2);
            detail.appendChild(tr);
          }

          sendBox.textContent = '';
          const send = data.lastSend;
          const text = send
            ? `${send.state ?? t.unknown}${send.sendId ? ` · sendId=${send.sendId}` : ''}${send.error ? ` · ${send.error}` : ''}`
            : t.none;
          const tr = document.createElement('tr');
          const td1 = document.createElement('td');
          td1.textContent = t.lastSend;
          const td2 = document.createElement('td');
          td2.textContent = text;
          tr.append(td1, td2);
          sendBox.appendChild(tr);
        };

        const load = async (quiet) => {
          if (!quiet) line.textContent = t.refreshing;
          try {
            const data = await ctx.invoke('snapshot');
            paint(data || {});
            line.textContent = '';
            line.classList.remove('bad');
          } catch (err) {
            line.textContent = `${t.failed}：${errorText(err)}`;
            line.classList.add('bad');
          }
        };

        refreshBtn.addEventListener(
          'click',
          () => {
            void load(false);
          },
          { signal: ctx.signal },
        );

        saveBtn.addEventListener(
          'click',
          async () => {
            const token = tokenInput.value.trim();
            if (!token) {
              tokenLine.textContent = '令牌不能为空';
              tokenLine.classList.add('bad');
              return;
            }
            tokenLine.textContent = t.refreshing;
            try {
              await ctx.invoke('setToken', [token]);
              tokenInput.value = '';
              tokenLine.textContent = t.saved;
              tokenLine.classList.remove('bad');
            } catch (err) {
              tokenLine.textContent = `${t.failed}：${errorText(err)}`;
              tokenLine.classList.add('bad');
            }
          },
          { signal: ctx.signal },
        );

        ctx.interval(() => {
          void load(true);
        }, 5000);
        void load(false);
      },
    },

    threads: {
      mount(ctx) {
        const t = pickText(ctx);
        const sheet = ctx.ui.sheet({ title: t.threadsTitle, desc: t.threadsDesc });
        ctx.root.appendChild(sheet.el);

        const bar = ctx.ui.rowbar();
        const refreshBtn = ctx.ui.button(t.refresh, { variant: 'primary', size: 'sm' });
        const line = ctx.ui.msgline(t.refreshing);
        bar.appendChild(refreshBtn);
        bar.appendChild(line);
        sheet.body.appendChild(bar);

        const table = ctx.ui.table({
          head: [t.colThread, t.colKind, t.colName, t.colSession, t.colAt],
        });
        sheet.body.appendChild(table.el);

        const load = async (quiet) => {
          if (!quiet) line.textContent = t.refreshing;
          try {
            const data = await ctx.invoke('list');
            const items = Array.isArray(data && data.items) ? data.items : [];
            if (items.length === 0) {
              table.clear(t.empty);
            } else {
              table.clear();
              for (const item of items) {
                const kind =
                  item.kind === 'group' ? t.group : item.kind === 'direct' ? t.direct : String(item.kind ?? t.unknown);
                table.addRow([
                  String(item.threadId ?? ''),
                  kind,
                  String(item.name ?? ''),
                  { text: String(item.session ?? ''), cls: 'mono' },
                  stamp(item.lastDeliveredAt),
                ]);
              }
            }
            line.textContent = '';
            line.classList.remove('bad');
          } catch (err) {
            line.textContent = `${t.failed}：${errorText(err)}`;
            line.classList.add('bad');
          }
        };

        refreshBtn.addEventListener(
          'click',
          () => {
            void load(false);
          },
          { signal: ctx.signal },
        );

        ctx.interval(() => {
          void load(true);
        }, 10_000);
        void load(false);
      },
    },
  },
};
