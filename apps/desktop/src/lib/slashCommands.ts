/**
 * Piggy 的内建斜杠指令（docs/04 §7.2）。
 *
 * ## 为什么需要这一层
 *
 * pi 的 `get_commands` RPC **只返回扩展 / prompt / skill 注册的命令**
 * （`rpc-mode.ts` 的 `get_commands`：extensionRunner + promptTemplates + skills），
 * pi 自己那 24 条**内建**命令（`core/slash-commands.ts` 的 `BUILTIN_SLASH_COMMANDS`）
 * 不在协议里——它们是 pi 的**交互模式**在本地解析的。
 *
 * 于是 Piggy 里 `/compact` 既不在补全列表里、敲下去还会被当成**普通消息发给模型**
 * （用户报的就是这个）。这一层把"GUI 里真的做得到"的那部分补上：命令名与 pi 内建
 * **同名同义**，动作走 Piggy 已有的代码路径（`pi_compact` / 新建标签 / 打开设置…），
 * 界面上明确标出「内建」。
 *
 * ## 三条纪律
 *
 * 1. **只收"Piggy 真的做得到"的命令**。做得到的才进 {@link BUILTIN_SLASH_COMMANDS}；
 *    pi 有、Piggy 暂时没有入口的（`/fork` `/clone` `/reload` …）进
 *    {@link UNSUPPORTED_PI_COMMANDS}，仍然在补全里**可见**，选中时给一句
 *    "为什么没有 + 去哪儿做"，**绝不静默**（静默正是 bug 的来源）。
 * 2. **`/` 开头的输入要拦在模型之前**：{@link dispatchSlashInput} 认出内建命令就
 *    就地执行并返回 `true`，调用方不得再发 `pi_prompt`——否则模型会收到字符串
 *    `/compact`（它只会当成一句话来回答）。
 * 3. 扩展 / prompt / skill 命令**照旧发给 pi**：那是 pi 的解析范围（`prompt` 里带
 *    `/name args`，pi 自己认）。Piggy 不重复实现一遍。
 */
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { windowEvents } from '@/lib/windowEvents';
import { newSessionTab } from '@/lib/appCommands';
import { openSettingsTab } from '@/features/workspace/EditorArea';
import { useMessages, type MessageView } from '@/stores/messages';
import { useSessions } from '@/stores/sessions';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';

/** 补全列表里的一行（内建与 pi 命令共用一个形状，`source` 区分）。 */
export interface SlashRow {
  name: string;
  description?: string;
  /** `builtin` = Piggy 内建；其余是 pi 的 `extension` / `prompt` / `skill` */
  source?: string;
  /** 参数提示（`<级别>`），有参数的命令才给 */
  argumentHint?: string;
  /** 选中后**只插入** `/name `（命令需要参数），不立即执行 */
  insertOnly?: boolean;
  /** pi 有、Piggy 暂无入口：选中只解释原因 */
  unsupported?: boolean;
}

/** 执行一条内建命令时的上下文。 */
export interface SlashContext {
  /** 当前会话标签；没有活动会话时为 null */
  tabId: string | null;
}

/** pi 的思考级别（`packages/agent/src/types.ts` 的 ThinkingLevel）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface BuiltinCommand extends SlashRow {
  source: 'builtin';
  run(args: string, ctx: SlashContext): void | Promise<void>;
}

/** 需要活动会话的内建命令统一走这里，避免每处各写一遍同样的报错。 */
function requireTab(ctx: SlashContext): string | null {
  if (!ctx.tabId) {
    toast.error('当前没有打开的会话');
    return null;
  }
  return ctx.tabId;
}

/** 取最后一条 assistant 消息的纯文本（`/copy` 用）。 */
function lastAssistantText(tabId: string): string {
  const tab = useMessages.getState().tabs[tabId];
  if (!tab) return '';
  for (let i = tab.ids.length - 1; i >= 0; i -= 1) {
    const row = tab.byId[tab.ids[i]!] as MessageView | undefined;
    if (!row || row.role !== 'assistant') continue;
    const c = (row.message as { content?: unknown }).content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((b) => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
        .join('');
    }
  }
  return '';
}

/**
 * Piggy 内建命令表。
 *
 * 顺序 = 补全列表里的顺序（常用在前）。命令名与 pi 内建严格同名——
 * 两边叫法不同的话，用户在 pi 里养成的肌肉记忆到了 GUI 就失效了。
 */
export const BUILTIN_SLASH_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: 'compact',
    description: '压缩上下文（可跟自定义指令，如 /compact 只保留结论）',
    source: 'builtin',
    argumentHint: '<指令>',
    async run(args, ctx) {
      const tabId = requireTab(ctx);
      if (!tabId) return;
      try {
        await cmd('pi_compact', { tabId, customInstructions: args.trim() || null });
        toast.success(args.trim() ? '已按指令压缩上下文' : '已压缩上下文');
      } catch (e) {
        toast.error(`压缩失败：${e}`);
      }
    },
  },
  {
    name: 'new',
    description: '新建会话',
    source: 'builtin',
    async run() {
      await newSessionTab();
    },
  },
  {
    name: 'model',
    description: '选择模型',
    source: 'builtin',
    argumentHint: '<provider/model>',
    run(_args, ctx) {
      if (!requireTab(ctx)) return;
      windowEvents.emit('open-model-picker');
    },
  },
  {
    name: 'thinking',
    description: `设置思考级别（不带参数则循环）；级别：${THINKING_LEVELS.join(' / ')}`,
    source: 'builtin',
    argumentHint: '<级别>',
    async run(args, ctx) {
      const tabId = requireTab(ctx);
      if (!tabId) return;
      const level = args.trim();
      try {
        if (!level) {
          const r = await cmd<{ level?: string; data?: { level?: string } }>('pi_cycle_thinking', { tabId });
          const next = r.level ?? r.data?.level ?? null;
          useTabs.getState().patch(tabId, { thinkingLevel: next });
          toast.success(`思考级别：${next ?? '(未知)'}`);
          return;
        }
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
          toast.error(`认不出的思考级别「${level}」，可用：${THINKING_LEVELS.join(' / ')}`);
          return;
        }
        await cmd('pi_set_thinking_level', { tabId, level });
        useTabs.getState().patch(tabId, { thinkingLevel: level });
        toast.success(`思考级别：${level}`);
      } catch (e) {
        toast.error(String(e));
      }
    },
  },
  {
    name: 'name',
    description: '设置会话显示名',
    source: 'builtin',
    argumentHint: '<名称>',
    insertOnly: true,
    async run(args, ctx) {
      const tabId = requireTab(ctx);
      if (!tabId) return;
      const name = args.trim();
      if (!name) {
        toast.info('用法：/name 会话名');
        return;
      }
      try {
        await cmd('pi_set_session_name', { tabId, name });
        useTabs.getState().patch(tabId, { sessionName: name });
        await useSessions.getState().load();
        toast.success(`会话已命名为「${name}」`);
      } catch (e) {
        toast.error(String(e));
      }
    },
  },
  {
    name: 'session',
    description: '会话信息与用量（打开右栏「统计」）',
    source: 'builtin',
    run() {
      windowEvents.emit('rightbar-view', 'stats');
    },
  },
  {
    name: 'tree',
    description: '会话树 / 分支（打开右栏「会话树」）',
    source: 'builtin',
    run() {
      windowEvents.emit('rightbar-view', 'tree');
    },
  },
  {
    name: 'export',
    description: '导出当前会话为 HTML',
    source: 'builtin',
    async run(_args, ctx) {
      const tabId = requireTab(ctx);
      if (!tabId) return;
      try {
        const d = await cmd<{ path?: string }>('pi_export_html', { tabId });
        toast.success(`已导出：${d.path ?? '(见工作目录)'}`);
      } catch (e) {
        toast.error(String(e));
      }
    },
  },
  {
    name: 'copy',
    description: '复制最后一条回答到剪贴板',
    source: 'builtin',
    async run(_args, ctx) {
      const tabId = requireTab(ctx);
      if (!tabId) return;
      const text = lastAssistantText(tabId);
      if (!text.trim()) {
        toast.info('当前会话还没有可复制的回答');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.success('已复制最后一条回答');
      } catch (e) {
        toast.error(`复制失败：${e}`);
      }
    },
  },
  {
    name: 'resume',
    description: '切换到其他会话（聚焦侧栏搜索）',
    source: 'builtin',
    run() {
      windowEvents.emit('focus-session-search');
    },
  },
  {
    name: 'settings',
    description: '打开设置',
    source: 'builtin',
    run() {
      openSettingsTab();
    },
  },
  {
    name: 'login',
    description: '配置服务商与 API Key（打开设置）',
    source: 'builtin',
    run() {
      openSettingsTab();
    },
  },
  {
    name: 'logout',
    description: '移除服务商凭据（打开设置）',
    source: 'builtin',
    run() {
      openSettingsTab();
    },
  },
  {
    name: 'hotkeys',
    description: '快捷键速查',
    source: 'builtin',
    run() {
      useUi.getState().setHelpOpen(true);
    },
  },
];

/**
 * pi 有、Piggy 暂无入口的内建命令。
 *
 * **故意仍然显示在补全里**：用户敲 `/fork` 时最需要知道的是"这里做不了、去哪儿做"，
 * 而不是"列表里什么都没有"（那正是这次报的 bug 的形态）。
 */
export const UNSUPPORTED_PI_COMMANDS: readonly SlashRow[] = [
  { name: 'fork', description: '从某条历史消息开分支：Piggy 暂无所选消息的分支选择器', source: 'pi 内建', unsupported: true },
  { name: 'clone', description: '复制当前会话：Piggy 暂无入口（会换会话文件，需先同步会话互斥表）', source: 'pi 内建', unsupported: true },
  { name: 'reload', description: '重载键位/扩展/skills/prompts：Piggy 重启对应标签即可', source: 'pi 内建', unsupported: true },
  { name: 'import', description: '从 JSONL 导入会话：把文件放进会话目录即可被扫到', source: 'pi 内建', unsupported: true },
  { name: 'scoped-models', description: '配置 Ctrl+P 循环的模型集合：Piggy 用模型选择器', source: 'pi 内建', unsupported: true },
  { name: 'share', description: '把会话分享成私密 gist：Piggy 未接入', source: 'pi 内建', unsupported: true },
  { name: 'bug', description: '向 pi 开发者报 bug：请到 pi 仓库提 issue', source: 'pi 内建', unsupported: true },
  { name: 'changelog', description: '查看更新日志：见 pi 仓库 CHANGELOG', source: 'pi 内建', unsupported: true },
  { name: 'trust', description: '保存项目信任决定：Piggy 在插件页管理项目信任', source: 'pi 内建', unsupported: true },
  { name: 'quit', description: '退出 pi：GUI 里直接关窗口', source: 'pi 内建', unsupported: true },
];

const BY_NAME = new Map(BUILTIN_SLASH_COMMANDS.map((c) => [c.name, c]));
const UNSUPPORTED_BY_NAME = new Map(UNSUPPORTED_PI_COMMANDS.map((c) => [c.name, c]));

/** 补全列表里的内建部分（按查询过滤，前缀优先）。 */
export function builtinRows(query: string): SlashRow[] {
  const q = query.toLowerCase();
  const all: SlashRow[] = [...BUILTIN_SLASH_COMMANDS, ...UNSUPPORTED_PI_COMMANDS];
  if (!q) return all;
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** 解析 `/name args`（整条输入必须就是一个命令）。 */
export function parseSlashInput(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return { name: (m[1] ?? '').toLowerCase(), args: (m[2] ?? '').trim() };
}

/**
 * 这条输入是不是**Piggy 认得的**指令（内建或"pi 有、Piggy 暂无入口"）。
 *
 * 提交路径（Enter / 发送按钮）用它做同步判断：只有认得的才拦下来，
 * 其余 `/...` 一律照旧当消息处理——用户真的可能发一条以 `/` 开头的路径。
 *
 * @param text - 输入框里的整条文本
 * @returns 认得 → true
 */
export function isKnownSlashCommand(text: string): boolean {
  const parsed = parseSlashInput(text);
  if (!parsed) return false;
  return BY_NAME.has(parsed.name) || UNSUPPORTED_BY_NAME.has(parsed.name);
}

/**
 * 把一条 `/...` 输入当作指令处理。
 *
 * @param text - 输入框里的整条文本
 * @param ctx - 当前会话上下文
 * @returns `true` = 已被当作指令消化（**不要再**发给模型）；`false` = 不是内建命令，
 *          调用方按普通消息处理（pi 自己的扩展/prompt/skill 命令就靠这条路）
 */
export async function dispatchSlashInput(text: string, ctx: SlashContext): Promise<boolean> {
  const parsed = parseSlashInput(text);
  if (!parsed) return false;
  const builtin = BY_NAME.get(parsed.name);
  if (builtin) {
    await builtin.run(parsed.args, ctx);
    return true;
  }
  const unsupported = UNSUPPORTED_BY_NAME.get(parsed.name);
  if (unsupported) {
    toast.info(`/${unsupported.name}：${unsupported.description ?? 'Piggy 暂无入口'}`);
    return true;
  }
  return false;
}
