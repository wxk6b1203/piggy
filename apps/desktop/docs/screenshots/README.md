# 配图与可复现命令

这些图由 `apps/desktop/scripts/shot.mjs` 在 **mock IPC**（浏览器 + 假后端）下生成：
不需要 pi、不碰真实会话，路径里的 `/Users/mock/proj` 之类都是**合成数据**。

| 图 | 命令 |
|---|---|
| `chat.png` | `node scripts/shot.mjs ../../docs/screenshots/chat.png --fresh --wait 2500 --click .pg-session-row --eval "document.querySelector('.pg-transcript').scrollTop = 0"` |
| `trajectory.png` | `node scripts/shot.mjs ../../docs/screenshots/trajectory.png --fresh --wait 2500 --click .pg-session-row --click ".pg-ws-tab:nth-of-type(2)" --wait 1200` |
| `settings-providers.png` | `node scripts/shot.mjs ../../docs/screenshots/settings-providers.png --fresh --wait 2500 --click .pg-sidebar-settings --wait 1500` |
| `todo.png` | 见下面的脚本（任务清单由插件提供，mock 默认没有这类行，要现造） |

前置：`pnpm dev`（Vite :5195）已在跑。

## `todo.png` 的复现脚本

```bash
cd apps/desktop
cat > /tmp/todo-shot.js <<'JS'
const stores = globalThis.__piggyStores;
const tabId = stores.useTabs.getState().activeTabId;
const rows = [
  { role: 'user', content: [{ type: 'text', text: '帮我把这次迁移做完：改 schema、跑回归、更新文档，最后验证一遍。' }] },
  { role: 'assistant', content: [
      { type: 'text', text: '好，先列个清单。' },
      { type: 'toolCall', id: 'td-1', name: 'todo_write', arguments: { todos: [
        { content: '迁移 schema 到 v2', status: 'in_progress' },
        { content: '跑回归测试', status: 'pending' },
        { content: '更新迁移文档', status: 'pending' },
        { content: '端到端验证一次', status: 'pending' },
      ] } },
    ] },
  { role: 'toolResult', toolName: 'todo_write', toolCallId: 'td-1', content: [{ type: 'text', text: 'Updated todo list: 3 pending, 1 in progress, 0 completed.' }] },
  { role: 'assistant', content: [
      { type: 'toolCall', id: 'td-2', name: 'todo_write', arguments: { todos: [
        { content: '迁移 schema 到 v2', status: 'completed' },
        { content: '跑回归测试', status: 'in_progress' },
        { content: '更新迁移文档', status: 'pending' },
        { content: '端到端验证一次', status: 'pending' },
      ] } },
    ] },
  { role: 'toolResult', toolName: 'todo_write', toolCallId: 'td-2', content: [{ type: 'text', text: 'Updated todo list: 2 pending, 1 in progress, 1 completed.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'schema 已迁移完成，正在跑回归测试。**进度**：1/4 已完成。' }] },
];
stores.useMessages.getState().hydrate(tabId, rows);
stores.useTodo.getState().noteCommit(tabId, { type: 'piggy:resync', entries: rows.map((m) => ({ type: 'message', message: m })) });
setTimeout(() => {
  const els = [...document.querySelectorAll('[data-todo-row]')];
  els[1]?.querySelector('[data-disclosure-row]')?.click();
  document.querySelector('[data-todo-panel-head]')?.click();
}, 300);
JS
node scripts/shot.mjs ../../docs/screenshots/todo.png --fresh --wait 1200 --size 1280x860 --eval "$(cat /tmp/todo-shot.js)"
```

两次 `todo_write` 是刻意的：第二行才能显示**差异**（`新增/更新/移除`）——
只写一次的话每行都是「首次记录」，那正是差异基线查错键时才会有的样子。
