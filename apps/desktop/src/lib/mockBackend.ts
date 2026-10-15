/**
 * 浏览器 Mock IPC（docs/08 §5 UI E2E 底座）：
 * 非 Tauri 环境（无 __TAURI_INTERNALS__，如 Playwright 驱动的 Chrome）自动启用。
 * 提供静态数据 + 脚本化流式演示（prompt → agent_start → delta… → settled），
 * 事件走同一通道名，前端零改动。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';

type Handler = (payload: unknown) => void;
const bus = new Map<string, Set<Handler>>();

function emit(channel: string, payload: unknown) {
  bus.get(channel)?.forEach((h) => h(payload));
}

const now = () => Date.now();
const TAB = 'mock-tab-1';

const state = {
  model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash', provider: 'mock-glm' },
  thinkingLevel: 'medium',
  sessionId: 'mock-sid-1',
  sessionFile: '/Users/mock/.pi/agent/sessions/--mock--/2026-09-22_mock.jsonl',
  sessionName: 'Mock 会话',
  permission: 'workspace' as 'read-only' | 'workspace' | 'full',
};

/** Piggy 应用配置的 mock 副本（对应 ~/.piggy/config.json）。写入必须真的记住。 */
const appCfg: {
  max_workers: number;
  idle_timeout_min: number;
  permission_mode: string;
  pi_source: string;
  pi_path: string | null;
  subagent_delegation: boolean;
} = {
  max_workers: 8,
  idle_timeout_min: 10,
  permission_mode: 'workspace',
  pi_source: 'system',
  pi_path: null,
  subagent_delegation: false,
};

let mockTabSeq = 0;

/** `open_in_app_open` 的调用记录（门禁读它来核对参数；真机上这对应"真的启动了哪个应用"）。 */
export const openCalls: { id: string; path: string }[] = [];

/** `open_path_open` 的调用记录（门禁据此核对"默认应用 / 指定应用 / 显示位置"三条路）。 */
export const pathCalls: { path: string; action: string; application: string | null }[] = [];

/**
 * 所有 `provider_*` 调用的记录（门禁据此核对"检测送出了什么""保存先写配置还是先写密钥"）。
 * 在 `mockInvoke` 里**统一**记，避免将来加了新命令却忘了记 —— 那样门禁会静默变成空转。
 */
export const providerOps: { name: string; args: Record<string, unknown> }[] = [];

/** mock 里"捆绑插件开着吗"（`perf_config_save` 会真的改它，界面据此显示注入/跳过）。 */
function mockBundledEnabled(): boolean {
  return mockTitleCfg.bundled.includes('pi-ask');
}

/** `ui_reply` 的记录（门禁第 27 段核对提问卡的答案真的送回去了）。 */
export const uiReplies: Array<{ id: string; value: unknown; cancelled: boolean }> = [];

/** 外部链接的打开记录（门禁核对"markdown 里的链接点击真的交给宿主了"）。 */
export const externalOpenCalls: string[] = [];

/** 被 `pi_abort` 打断过的 tab（假流式的循环会看它 —— 否则"停止"按钮在 mock 下没有反应）。 */
const abortedTabs = new Set<string>();

/**
 * 排队中的消息（真机就是 pi 的那两个字符串数组）。
 *
 * ⚠️ 为什么 mock 必须有这个：真机的 `pi_prompt` 在**流式中**不带 `streamingBehavior`
 * 会直接报错，带了就**只入队、立刻返回**（`agent-session.ts:2097-2111`）。老 mock 无视
 * 这个字段、每次都从头流一遍 —— 于是"流式中发消息"在浏览器里表现得像新开了一轮，
 * 队列 UI 永远测不到东西（规矩 4：mock 比真机宽松 = 藏真机 bug）。
 */
const mockQueues = new Map<string, { steering: string[]; followUp: string[] }>();

/** 哪些 tab 的假流式正在跑（决定 `pi_prompt` 是"入队"还是"起一轮"）。 */
const mockStreamingTabs = new Set<string>();

function queueOf(tabId: string): { steering: string[]; followUp: string[] } {
  let q = mockQueues.get(tabId);
  if (!q) {
    q = { steering: [], followUp: [] };
    mockQueues.set(tabId, q);
  }
  return q;
}

/** 推一次 `queue_update`（pi 每改一次队列都推，含清空）。 */
function emitQueue(tabId: string): void {
  const q = queueOf(tabId);
  emit(`pi:commit:${tabId}`, {
    type: 'queue_update',
    steering: [...q.steering],
    followUp: [...q.followUp],
  });
}

/** 内嵌登录终端的假 PTY 序号。 */
let nextMockPtyId = 1;

/** 提供商配置的 mock 副本：形状与 `provider_overview` 的一行一致，写入要真的记住。 */
interface MockProvider {
  provider: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  keySource?: string;
  keyMasked?: string | null;
  hasInlineKey?: boolean;
  models?: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
}
const mockProviders: Record<string, MockProvider> = {
  'cc-switch-zhipu-glm': {
    provider: 'cc-switch-zhipu-glm',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    api: 'anthropic-messages',
    keySource: 'models_json',
    keyMasked: 'sk-mock…glm1',
    hasInlineKey: true,
    models: [
      { id: 'glm-5.3', name: 'glm-5.3', reasoning: true, contextWindow: 1000000, maxTokens: 128000 },
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash', reasoning: true, contextWindow: 1000000, maxTokens: 128000 },
    ],
  },
  'cc-switch-deep-seek': {
    provider: 'cc-switch-deep-seek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    keySource: 'models_json',
    keyMasked: 'sk-mock…dsk1',
    hasInlineKey: true,
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', reasoning: true, contextWindow: 1000000, maxTokens: 384000 },
    ],
  },
};

/** 目录子集（真实目录有 41 条，由 `scripts/gen-provider-catalog.mjs` 从 pi 源码生成）。 */
const CATALOG_SUBSET = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', envVar: 'DEEPSEEK_API_KEY', apis: ['openai-completions'] },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', envVar: 'ANTHROPIC_API_KEY', apis: ['anthropic-messages'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', envVar: 'OPENAI_API_KEY', apis: ['openai-responses'] },
  { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', envVar: 'GEMINI_API_KEY', apis: ['google-generative-ai'] },
  { id: 'zai', name: 'Z.AI', baseUrl: 'https://api.z.ai/api/coding/paas/v4', api: 'openai-completions', envVar: 'ZAI_API_KEY', apis: ['openai-completions'] },
  { id: 'moonshotai', name: 'Moonshot AI', baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', envVar: 'MOONSHOT_API_KEY', apis: ['openai-completions'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', envVar: 'OPENROUTER_API_KEY', apis: ['anthropic-messages', 'openai-completions'] },
  { id: 'github-copilot', name: 'GitHub Copilot', baseUrl: 'https://api.individual.githubcopilot.com', api: '', envVar: 'COPILOT_GITHUB_TOKEN', apis: [] },
];

/** 把 mock 的写入投影成 `provider_overview` 的行（顺序与 Rust 一致：目录项在前）。 */
function providerRows() {
  const order = CATALOG_SUBSET.map((c) => c.id);
  return Object.values(mockProviders)
    .map((p) => {
      const cat = CATALOG_SUBSET.find((c) => c.id === p.provider);
      return {
        provider: p.provider,
        name: p.name ?? cat?.name ?? p.provider,
        declared: !!cat,
        baseUrl: p.baseUrl ?? cat?.baseUrl ?? '',
        baseUrlSource: p.baseUrl ? 'models_json' : cat ? 'catalog' : 'none',
        api: p.api ?? cat?.api ?? '',
        apiSource: p.api ? 'models_json' : cat ? 'catalog' : 'none',
        apis: cat?.apis ?? [],
        envVar: cat?.envVar ?? '',
        keySource: p.keySource ?? 'none',
        keyMasked: p.keyMasked ?? null,
        keyKind: p.keySource === 'none' ? '' : 'api_key',
        hasInlineKey: !!p.hasInlineKey,
        models: p.models ?? [],
        cachedModels: 0,
        // 与 defaults.provider 对齐（真机来自 settings.json 的 defaultProvider）
        isDefault: p.provider === 'cc-switch-zhipu-glm',
      };
    })
    .sort((a, b) => {
      const ia = order.indexOf(a.provider);
      const ib = order.indexOf(b.provider);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
}


/** 1×1 透明 PNG：把"图标真的走 <img> 渲染"这条路径在 mock 下也走通。 */
const MOCK_APP_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * 模拟 Rust registry 里"这个 tab 还在不在"（真机行为见 registry.rs::ensure_worker
 * 与 commands.rs::worker_of —— 不存在就 `Err("tab 不存在: <uuid>")`）。
 *
 * 以前 mock 对任何 tabId 都照常回答，于是**"界面显示着这个标签、registry 里却已经没有它"**
 * 这类 bug 在 mock 里完全测不出来：真机上的表现是这个标签下所有命令一起报
 * 「tab 不存在: <uuid>」（模型列表空白、转写空白、发送无响应），
 * 而 mock 里一切正常、看着像前端没问题。本项目已经因为 mock 与真后端形状不一致
 * 踩过坑（fs_list_dir 的 OsString），所以这里把存在性也模拟出来。
 */
const liveTabs = new Set<string>(readPersistedTabs());

/** 真机里 registry 活在 **Rust 进程**中，webview 重载（HMR/刷新）不会清空它；
 *  mock 的模块状态却会随之重置。用 sessionStorage 把这份状态跨重载带过去，
 *  否则「上一上下文的 tab 还在 registry 里」这个前提在 mock 里根本不存在，
 *  boot_reset 的收割逻辑也就永远测不到。 */
function readPersistedTabs(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem('pg.mockLiveTabs') ?? '[]') as string[];
  } catch {
    return [];
  }
}

function persistTabs(): void {
  try {
    sessionStorage.setItem('pg.mockLiveTabs', JSON.stringify([...liveTabs]));
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/**
 * tab 快照（形状 = Rust `TabSnapshot`，`sessions/registry.rs`）。
 *
 * `session_name` 显式写成 `string | null`：真机那是 `Option<String>` ——
 * 打开一个**没名字**的会话时它就是 `null`（前端据此退回第一条用户消息）。
 * 类型收紧成 `string` 会让 mock 只能编一个名字出来，那正是"mock 比真机宽松"的老毛病。
 */
interface MockTabSnapshot {
  tab_id: string;
  cwd: string;
  session_id: string;
  session_file: string;
  session_name: string | null;
  worker_state: string;
  permission: typeof state.permission;
  state: { model: typeof state.model; thinkingLevel: string; isStreaming: boolean; sessionName?: string | null };
}

function snapshot(): MockTabSnapshot {
  return {
    // 每次 tab_create 给一个新的 tab_id：以前恒为 'mock-tab-1'，
    // 于是连点「新会话」不会产生第二个标签（dockview 面板 id 相同会去重），
    // 多标签 / 标签溢出这些 UI 在浏览器里根本没法复现。
    tab_id: mockTabSeq++ === 0 ? TAB : `${TAB}-${mockTabSeq}`,
    cwd: '/Users/mock/proj',
    session_id: state.sessionId,
    session_file: state.sessionFile,
    session_name: state.sessionName,
    worker_state: 'ready',
    permission: state.permission,
    state: { model: state.model, thinkingLevel: state.thinkingLevel, isStreaming: false },
  };
}

/**
 * mock 的压缩条目（真机形状）。
 *
 * 门禁与单测都用它核对"压缩细节能被看见"：摘要、压缩前 token、**保留边界**
 * （`firstKeptEntryId`）、涉及文件（`details`）、摘要调用用量（`usage`）、`fromHook`。
 * 换回 `{type:'compaction'}` 三个字段就等于关掉这条核对（红检方式写在 docs/15）。
 */
export const MOCK_COMPACTION_SUMMARY =
  '## Goal\n构建 Piggy 的轨迹视图。\n\n## Progress\n- 分页与刻度梯已完成\n- 压缩行缺少细节（用户报）';
export const MOCK_COMPACTION_ENTRY = {
  type: 'compaction',
  id: 'e5',
  parentId: 'e3',
  timestamp: new Date(now() - 46_000).toISOString(),
  summary: MOCK_COMPACTION_SUMMARY,
  firstKeptEntryId: 'e4',
  tokensBefore: 561_660,
  usage: { input: 475_045, output: 3_494, totalTokens: 478_539, cost: { total: 0.1234 } },
  details: {
    readFiles: ['docs/03-module-design.md', 'docs/04-frontend-design.md'],
    modifiedFiles: ['apps/desktop/src/stores/trajectory.ts'],
  },
  fromHook: false,
};

/**
 * mock 的一次 `edit`：参数、结果与 pi 的 `details.patch`（门禁按这几个常量核对 diff）。
 *
 * patch 是**真的统一 diff 文本**（`createTwoFilesPatch` 的输出：`---`/`+++` 加两个
 * `@@` 块），不是编一个形状像的字符串 —— 解析器要是把 `---` 当成删除行、
 * 或者把第二个 hunk 吞掉，门禁里的行数与行内容立刻对不上。
 * 第二个 hunk 让整块 diff 到 13 行，**超过行内折叠阈值（9）**，
 * 于是"展开剩下的 N 行"这条交互也被真的走到。
 */
export const MOCK_EDIT_PATH = 'src/lib/live.ts';
export const MOCK_EDIT_CALL_ID = 'call_mock_edit';
export const MOCK_EDIT_PATCH = [
  '===================================================================',
  `--- ${MOCK_EDIT_PATH}`,
  `+++ ${MOCK_EDIT_PATH}`,
  '@@ -1,5 +1,6 @@',
  ' // 实时引擎的注册表',
  ' export function liveFor(tabId: string): LiveEngine {',
  '-  return engines.get(tabId) ?? create(tabId);',
  '+  const engine = engines.get(tabId);',
  '+  return engine ?? create(tabId);',
  ' }',
  '@@ -20,3 +21,4 @@',
  ' export function drop(tabId: string): void {',
  '   engines.delete(tabId);',
  '+  listeners.delete(tabId);',
  ' }',
  '',
].join('\n');
export const MOCK_EDIT_DIFF = [
  '+   3   const engine = engines.get(tabId);',
  '+   4   return engine ?? create(tabId);',
  '-   3   return engines.get(tabId) ?? create(tabId);',
  '+  23   listeners.delete(tabId);',
].join('\n');

const messages = [
  { role: 'user', content: '帮我看看这个项目的流式渲染管线', timestamp: now() - 60_000 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '用户想验证 mock 管线。' },
      { type: 'text', text: '这是一条 mock 助手消息：**流式渲染**分两层——协议合帧（Rust）与渲染分帧（前端瞬态直写）。' },
      /* ⚠️ 参数按 **pi 的真实 schema** 写（`dist/core/tools/edit.d.ts`）：
         `{ path, edits: [{ oldText, newText }] }`。这里曾经是 Claude Code 的形状
         （`file_path` / `old_string` / `new_string`）—— mock 比真机宽松，
         于是"参数键名不对"这类错在浏览器门禁里永远看不见。 */
      { type: 'toolCall', id: MOCK_EDIT_CALL_ID, name: 'edit', arguments: { path: MOCK_EDIT_PATH, edits: [{ oldText: 'return engines.get(tabId) ?? create(tabId);', newText: 'const engine = engines.get(tabId);\n  return engine ?? create(tabId);' }] } },
      { type: 'toolCall', id: 'call_mock_write', name: 'write', arguments: { path: 'src/features/chat/Transcript.tsx', content: '…' } },
      { type: 'toolCall', id: 'call_mock_edit2', name: 'edit', arguments: { path: 'src/styles.css', edits: [{ oldText: 'a', newText: 'b' }] } },
    ],
    timestamp: now() - 59_000,
  },
  /* 第一条 edit 的结果：带 `details.patch` —— 界面上的 diff 与 `+N −M` 全从它来。
     第二条 edit（styles.css）**故意不给结果**：门禁据此核对"拿不到 patch 的文件
     只显示路径、不显示行数"（不臆造 `+0 −0`）。 */
  {
    role: 'toolResult',
    toolCallId: MOCK_EDIT_CALL_ID,
    toolName: 'edit',
    content: [{ type: 'text', text: `Applied 1 edit to ${MOCK_EDIT_PATH}` }],
    details: { diff: MOCK_EDIT_DIFF, patch: MOCK_EDIT_PATCH, firstChangedLine: 2 },
    isError: false,
    timestamp: now() - 58_500,
  },
  {
    role: 'toolResult',
    toolCallId: 'call_mock_1',
    toolName: 'read',
    content: [{ type: 'text', text: 'export function liveFor(tabId: string): LiveEngine { ... }' }],
    isError: false,
    timestamp: now() - 58_000,
  },
  /* 预览滚动条（docs/04 §2.6）的核对需要**多轮**会话：刻度梯至少要两条刻度才画，
     而且要够长才能滚起来。补的这几轮内容是刻意的"问在标题、答在正文"，
     门禁据此核对预览框的标题取自用户消息、正文取自回答。 */
  ...Array.from({ length: 7 }, (_, i) => [
    {
      role: 'user',
      content: `第 ${i + 2} 轮：模块 ${i + 1} 的边界条件是怎么处理的？`,
      timestamp: now() - (50_000 - i * 6_000),
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          // 第 3 轮故意写长：预览框是 3 行封顶的（docs/04 §2.6），
          // 门禁要用一段真的会溢出的文字核对"截断 + 省略号"，短文本永远测不出这条。
          text:
            i === 1
              ? `第 ${i + 2} 轮的回答：模块 ${i + 1} 的边界条件一共有三处需要处理。` +
                '第一处是空数组——此时不应抛错，而要返回一个明确的空结果，并把"未找到任何条目"这个事实写进返回值里，' +
                '而不是让调用方自己去猜 0 与 null 的区别；第二处是重复 id——我们的做法是保留首次出现的那条，' +
                '并把重复项收集到一个 warnings 列表里交回上层，这样调用方既能继续跑，又不会丢掉数据质量问题的线索；' +
                '第三处是并发写入——两个请求同时改同一条记录时，用版本号做乐观锁，冲突的一方拿到 409 并附带当前版本，' +
                '由调用方决定重试还是放弃。这三处都补了测试，覆盖空、重、并发三种输入。'
              : `第 ${i + 2} 轮的回答：模块 ${i + 1} 的边界是空数组与重复 id，两处都补了测试。`,
        },
      ],
      timestamp: now() - (49_000 - i * 6_000),
    },
  ]).flat(),
];

/**
 * mock 的"会话文件内容"（转录分页用，docs/03 §2.19）。
 *
 * 真机上这是 pi 写的 JSONL，`session_page` 从**文件尾**按字节倒着读；
 * mock 里只保留"一页 = 若干行"这一层语义（游标对前端是不透明的）。
 * 浏览器门禁可以调 {@link mockSetTranscriptRows} 灌一段长会话，
 * 用来核对"打开即贴底 / 加载更早不跳"这两条真几何行为。
 */
let mockTranscript: Array<{ role: string; message: unknown }> = (() => {
  /* ⚠️ 初值可以从 localStorage 读：门禁第 26 段要模拟"重启"（重载页面）来核对
     跨重启记阅读位置，而那一套 init script 每次导航都会清 localStorage ——
     它把这一段长会话重新播一遍（真机上这份数据在 pi 写的 JSONL 里，不需要这一手）。 */
  try {
    const raw = localStorage.getItem('piggy:mock:transcript');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Array<{ role: string; message: unknown }>;
      }
    }
  } catch {
    /* 没有 localStorage / JSON 坏了：用内置演示会话 */
  }
  return messages.map((m) => ({
    role: String((m as { role?: string }).role ?? ''),
    message: m,
  }));
})();

/** 灌入 mock 转录（门禁用：长会话的滚动手感只有真布局能量）。 */
export function mockSetTranscriptRows(rows: Array<{ role: string; message: unknown }>): void {
  mockTranscript = rows;
}


/**
 * 把 mock 转录**放回内置的演示会话**。
 *
 * 门禁里的段落会各自灌自己那段数据（长会话、超长思考…），而 `mockTranscript` 是
 * 模块级状态、**跨段落留着**。于是"打开侧栏第一个会话"这种动作读到的是**上一段灌的**
 * 东西 —— 后面那一段想核对内置演示会话里的行（例如 `edit` 的 diff）就什么都找不到，
 * 而失败信息只会说"没找到那一行"，看不出是数据没换回来（实测踩过）。
 */
export function mockResetTranscript(): void {
  mockTranscript = messages.map((m) => ({
    role: String((m as { role?: string }).role ?? ''),
    message: m,
  }));
}

/** 造 n 轮（user + assistant）mock 转录；门禁与单测共用一套形状。 */
/** 会话文件里压缩行的**投影形状**（与 Rust `transcript::compaction_row` 逐字段对齐）。 */
export function mockCompactionRow(): { role: string; message: unknown } {
  const e = MOCK_COMPACTION_ENTRY;
  return {
    role: 'compaction',
    message: {
      role: 'compaction',
      summary: e.summary,
      tokensBefore: e.tokensBefore,
      firstKeptEntryId: e.firstKeptEntryId,
      details: e.details,
      usage: e.usage,
      fromHook: e.fromHook,
      timestamp: e.timestamp,
    },
  };
}

export function mockBuildTranscript(
  turns: number,
  opts: { compactionAfterTurn?: number } = {},
): Array<{ role: string; message: unknown }> {
  const out: Array<{ role: string; message: unknown }> = [];
  for (let i = 1; i <= turns; i += 1) {
    out.push({
      role: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `第 ${i} 轮的问题` }], timestamp: 1_700_000_000_000 + i * 1000 },
    });
    out.push({
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${i} 轮的回答：这里是一段用来撑出行高的正文。`.repeat(3) }],
        timestamp: 1_700_000_000_500 + i * 1000,
      },
    });
    /* 压缩行：**默认灌进尾页覆盖的那一段**（尾页 = 50 行且 5 轮 ≈ 最后 25 轮），
       这样"对话里的压缩细节"在门禁里不用额外翻页就能量到。
       它是 role='compaction'，不占轮次（mock 的 outline 按 user 行分轮）。 */
    if (opts.compactionAfterTurn !== undefined && i === opts.compactionAfterTurn) {
      out.push(mockCompactionRow());
    }
  }
  return out;
}

/**
 * 会话 meta 的 mock。`createdMins` 与 `mtimeMins` **刻意分开**：
 * 侧栏按创建时间排序，若 mock 里两者一致就测不出"顺序随写入跳动"这个问题。
 */
const sessionMeta = (
  cwd: string,
  name: string,
  mtimeMins: number,
  first: string,
  createdMins = mtimeMins,
) => ({
  path: `/Users/mock/.pi/agent/sessions/--${cwd.replace(/\//g, '-')}--/2026-09-22_${name}.jsonl`,
  file_name: `2026-09-22_${name}.jsonl`,
  session_id: `sid-${name}`,
  cwd,
  name: null,
  first_message: first,
  mtime_ms: now() - mtimeMins * 60_000,
  created_ms: now() - createdMins * 60_000,
  size: 12_345,
});

/**
 * 需要 registry 里"这个 tab 真的存在"的命令 —— 逐一对应 Rust 侧走
 * `worker_of()` 的那些（commands.rs）。任何新增的 tab 级命令都要加进来，
 * 否则 mock 又会比真机宽松，把这类 bug 放过去。
 */
const TAB_SCOPED = new Set([
  'pi_prompt',
  'pi_steer',
  'pi_follow_up',
  'pi_abort',
  'pi_clear_queue',
  'pi_get_state',
  'pi_get_messages',
  'pi_get_entries',
  'pi_get_tree',
  'pi_get_fork_messages',
  'pi_fork',
  'pi_clone_session',
  'pi_set_model',
  'pi_set_thinking_level',
  'pi_get_available_models',
  'pi_get_available_thinking_levels',
  'pi_get_commands',
  'pi_get_session_stats',
  'pi_set_permission_mode',
  'pi_compact',
  'pi_bash',
  'pi_abort_bash',
  'tab_sleep',
]);


/* ---------------- 会话标题生成的 mock 状态（docs/03 §2.16） ---------------- */

/** 门禁用来核对"失败时保留原名字"：置 1 后下一次生成抛错。 */
export let mockTitleFail = false;
export function setMockTitleFail(v: boolean) {
  mockTitleFail = v;
}
/** 生成出来的标题按 20 字上限截断（与真机同一条规则），每次换一个以便看出"重新生成"生效了。 */
let mockTitleSeq = 0;
let mockTitleNext = '插件管理页的标题生成';
/** 标题配置。`perf_config_save` 会真的改它，`perf_config_load` 会真的读它——
    否则设置页在 mock 下"改了不生效"，门禁也就核对不了"选完模型到底写进去了什么"。 */
export const mockTitleCfg = {
  maxChars: 20,
  source: 'both' as string,
  model: '' as string,
  thinking: '' as string,
  /** 预览滚动条位置（与 Rust `PerfConfig.transcript_rail` 同义，默认右） */
  rail: 'right' as string,
  /** 注入哪些捆绑插件（与 Rust `PerfConfig.bundled_plugins` 同义，默认全开）。 */
  bundled: ['pi-ask'] as string[],
  /* 工作步骤展示档位（与 Rust `PerfConfig.transcript_detail` 同义，默认 standard）。
     ⚠️ 初值从 localStorage 读：浏览器门禁的**行级**核对（工具行、清单行、分页锚点…）
     需要关掉折叠才能量到行，而门禁中间会重载页面 —— 只改内存里的值会在重载后丢。
     键名与 `piggy:mock:todo-capability` 同一套（门禁的 init script 里写）。 */
  detail: (() => {
    try {
      return localStorage.getItem('piggy:mock:transcript-detail') ?? 'standard';
    } catch {
      return 'standard';
    }
  })() as string,
};
/**
 * `title_model_options` 的假数据（= `pi --list-models` 的解析结果）。
 *
 * 三条各自代表一类界面分支，缺一条就有一整块渲染没人核对：
 *   · 同一 provider 两个模型 → 分组是不是真的生效；
 *   · 另一个 provider → 组标题是不是各自的 provider 名；
 *   · `reasoning: false` → "思考强度"那个下拉应当**禁用并说明原因**。
 */
export const mockTitleModels = [
  { provider: 'mock-glm', id: 'glm-5.3-flash', reasoning: true },
  { provider: 'mock-glm', id: 'glm-5.3', reasoning: true },
  { provider: 'mock-plain', id: 'no-think-model', reasoning: false },
];
export const mockTitleSource = {
  first: '给 Piggy 加一个根据消息生成会话标题的功能',
  recent: ['再加一个右键菜单', '要支持重新生成'],
};
/** 会话 path → 生成出来的名字（真机是 pi 写进会话文件的 session_info）。 */
const mockSessionNames = new Map<string, string>();

/* ---------------- 关于与许可的 mock（docs/03 §2.17） ----------------
   真机的 `legal_notices` 由 Rust 侧 `include_str!("…/LICENSE")` 提供（gnu.org 原文全文，
   674 行 / 35149 字节）。mock 里**故意只放开头并写明"这是节选"**——
   在 mock 里塞一份假全文，等于让"界面显示的是不是原文"这件事永远测不出来；
   留足够的行数让限高滚动区能被真实地量到就够了。 */

/** 与 Rust `legal::THIRD_PARTY` 对应的那份清单（两侧都与 THIRD_PARTY_NOTICES.md 对拍）。 */
export const mockThirdParty = [
  { name: 'pi', license: 'MIT', holder: 'Copyright (c) 2025 Mario Zechner', usage: '驱动会话的编码代理；full SKU 随安装包分发' },
  { name: 'DeepSeek Harness', license: 'MIT', holder: 'Copyright (c) 2026 DeepSeek', usage: '设计 token 数值与交互规格的参照' },
  { name: '@vscode/codicons', license: 'CC-BY-4.0（图标字形）/ MIT（构建代码）', holder: 'Microsoft Corporation', usage: 'UI 图标字体' },
  { name: 'seti-ui', license: 'MIT', holder: 'Copyright (c) 2014 Jesse Weed', usage: '文件类型图标（WOFF 字体）' },
  { name: 'Monaco Editor', license: 'MIT', holder: 'Microsoft Corporation', usage: '编辑器与预览基座' },
  { name: 'VS Code 内置主题', license: 'MIT', holder: 'Microsoft Corporation', usage: 'Monaco 的语法着色规则（只有 tokenColors）' },
];

export const mockGplExcerpt = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

                            Preamble

  The GNU General Public License is a free, copyleft license for
software and other kinds of works.

  The licenses for most software and other practical works are designed
to take away your freedom to share and change the works.  By contrast,
the GNU General Public License is intended to guarantee your freedom to
share and change all versions of a program--to make sure it remains free
software for all its users.  We, the Free Software Foundation, use the
GNU General Public License for most of our software; it applies also to
any other work released this way by its authors.  You can apply it to
your programs, too.

  When we speak of free software, we are referring to freedom, not
price.  Our General Public Licenses are designed to make sure that you
have the freedom to distribute copies of free software (and charge for
them if you wish), that you receive source code or can get it if you
want it, that you can change the software or use pieces of it in new
free programs, and that you know you can do these things.

  To protect your rights, we need to prevent others from denying you
these rights or asking you to surrender the rights.  Therefore, you have
certain responsibilities if you distribute copies of the software, or if
you modify it: responsibilities to respect the freedom of others.

  For example, if you distribute copies of such a program, whether
gratis or for a fee, you must pass on to the recipients the same
freedoms that you received.  You must make sure that they, too, receive
or can get the source code.  And you must show them these terms so they
know their rights.

                       TERMS AND CONDITIONS

  0. Definitions.

  "This License" refers to version 3 of the GNU General Public License.

  "Copyright" also means copyright-like laws that apply to other kinds of
works, such as semiconductor masks.

── 以上是 mock 的节选：真机这里返回的是仓库根 LICENSE 的全文（674 行） ──`;

/* ---------------- 插件页的 mock 状态（docs/04 §2.3） ----------------
   mock 的职责不是"像真的 pi 一样加载扩展"，而是让**门禁能驱动整条交互链**：
   点开关必须真的改状态、点安装必须真的产生一个任务与输出、点删除必须真的把行去掉。
   所以这里维护一份可变状态，写入就改它。

   数据覆盖**四种来源各一条 + 一条缺失**——门禁据此核对"类型徽标/启用状态/
   缺失标记"是不是按来源分别渲染的。 */

/** 门禁据此核对"点了开关之后后端收到了什么、界面有没有跟着变"。 */
export const pluginOps: { name: string; args: Record<string, unknown> }[] = [];

/** 门禁据此核对"点生成标题有没有真的发出命令"。 */
export const sessionTitleOps: { name: string; args: Record<string, unknown> }[] = [];

interface MockPluginRow {
  key: string; name: string; kind: string; kindLabel: string;
  sourceKind: string; sourceKindLabel: string; scope: string; scopeLabel: string;
  source: string; path: string; exists: boolean; enabled: boolean; enabledBy: string;
  version: string | null; description: string | null; entries: string[];
  removable: boolean; updatable: boolean; replaceable: boolean; loadRank: number;
}

/** 四种来源各一条，外加一条"声明了但没装上"。 */
const mockPluginRows: MockPluginRow[] = [
  {
    key: 'project:discovered:/mock/project/.pi/extensions/local.ts',
    name: 'local.ts', kind: 'discovered', kindLabel: '发现目录',
    sourceKind: 'discovered', sourceKindLabel: '发现目录',
    scope: 'project', scopeLabel: '本项目',
    source: '/mock/project/.pi/extensions/local.ts',
    path: '/mock/project/.pi/extensions/local.ts',
    exists: true, enabled: true, enabledBy: '默认加载（没有任何规则排除它）',
    version: null, description: null,
    entries: ['/mock/project/.pi/extensions/local.ts'],
    removable: true, updatable: false, replaceable: false, loadRank: 1,
  },
  {
    key: 'global:package:npm:pi-guardrails',
    name: 'pi-guardrails', kind: 'package', kindLabel: '插件包',
    sourceKind: 'npm', sourceKindLabel: 'npm 包',
    scope: 'global', scopeLabel: '全局',
    source: 'npm:pi-guardrails',
    path: '/mock/home/.pi/agent/npm/node_modules/pi-guardrails',
    exists: true, enabled: true,
    enabledBy: '这条包在 settings.json 的 packages 里没有过滤规则 → pi 加载它提供的全部资源',
    version: '0.1.0', description: 'pi extension: read-before-write guard',
    entries: ['/mock/home/.pi/agent/npm/node_modules/pi-guardrails/index.ts'],
    removable: true, updatable: true, replaceable: false, loadRank: 4,
  },
  {
    key: 'global:package:npm:@me/never-installed',
    name: '@me/never-installed', kind: 'package', kindLabel: '插件包',
    sourceKind: 'npm', sourceKindLabel: 'npm 包',
    scope: 'global', scopeLabel: '全局',
    source: 'npm:@me/never-installed',
    path: '/mock/home/.pi/agent/npm/node_modules/@me/never-installed',
    exists: false, enabled: true,
    enabledBy: '这条包在 settings.json 的 packages 里没有过滤规则 → pi 加载它提供的全部资源',
    version: null, description: null, entries: [],
    removable: true, updatable: true, replaceable: false, loadRank: 4,
  },
  {
    key: 'global:discovered:/mock/home/.pi/agent/extensions/quiet.ts',
    name: 'quiet.ts', kind: 'discovered', kindLabel: '发现目录',
    sourceKind: 'discovered', sourceKindLabel: '发现目录',
    scope: 'global', scopeLabel: '全局',
    source: '/mock/home/.pi/agent/extensions/quiet.ts',
    path: '/mock/home/.pi/agent/extensions/quiet.ts',
    exists: true, enabled: false,
    enabledBy: '被 /mock/home/.pi/agent/settings.json 的 - 规则强制排除',
    version: null, description: null,
    entries: ['/mock/home/.pi/agent/extensions/quiet.ts'],
    removable: true, updatable: false, replaceable: false, loadRank: 3,
  },
  {
    key: 'builtin:builtin:llama.cpp',
    name: 'llama.cpp', kind: 'builtin', kindLabel: 'pi 内置',
    sourceKind: 'builtin', sourceKindLabel: '内置',
    scope: 'builtin', scopeLabel: 'pi 内置',
    source: 'llama.cpp', path: '(pi 内置：packages/coding-agent/src/extensions/llama)',
    exists: true, enabled: true,
    // pi 1.1.0 起内置扩展可以停用（写全局 settings 的 -builtin:<name>），
    // 也可以被别的扩展顶替；只有 llama.cpp 两边都不行（replaceable=false）
    enabledBy: 'pi 内置扩展：随 pi 发布；可以用设置里的 -builtin:llama.cpp 关掉',
    version: null, description: null, entries: [],
    removable: false, updatable: false, replaceable: false, loadRank: -1,
  },
];

const mockPluginJobs = new Map<string, {
  id: string; action: string; target: string; command: string; cwd: string;
  running: boolean; exitCode: number | null; lines: string[]; truncated: boolean;
  error: string | null; startedMs: number;
}>();
let mockJobSeq = 0;

function emitPlugin(channel: string, payload: unknown) {
  const set = bus.get(channel);
  if (!set) return;
  for (const h of set) h(payload);
}

/* ---------------- 任务清单能力与投影（docs/03 §2.20） ---------------- */

/**
 * mock 的 todo 能力状态。默认**探测到且已启用**（门禁要能量到 todo 界面），
 * 浏览器里可以调 {@link mockSetTodoCapability} 把它关掉，
 * 用来核对"没插件 ⇒ 界面一点都不出现"这条闸门。
 */
const TODO_FLAG_KEY = 'piggy:mock:todo-capability';

// 存在 localStorage 里（而不是只放模块变量）：门禁要**重载页面**才能重新走一遍启动探测，
// 模块级变量一重载就没了，"没插件时界面不出现"这条就永远测不到。
let mockTodoSupported = (() => {
  try {
    return globalThis.localStorage?.getItem(TODO_FLAG_KEY) !== 'off';
  } catch {
    return true;
  }
})();

/** 门禁用：切换 mock 的 todo 能力探测结果（会写 localStorage，重载后仍生效）。 */
export function mockSetTodoCapability(supported: boolean): void {
  mockTodoSupported = supported;
  try {
    globalThis.localStorage?.setItem(TODO_FLAG_KEY, supported ? 'on' : 'off');
  } catch {
    /* 无 localStorage：只影响本次会话 */
  }
}

/** `plugin_capability` 的返回（字段名与 Rust `plugin::capabilities::status` 一致）。 */
function mockPluginCapability(capability: string) {
  const enabled = mockTodoSupported;
  const plugin = {
    name: 'pi-todo',
    key: 'global:discovered:/mock/home/.pi/agent/extensions/pi-todo',
    kind: 'discovered',
    scope: 'global',
    scopeLabel: '全局',
    source: '/mock/home/.pi/agent/extensions/pi-todo',
    path: '/mock/home/.pi/agent/extensions/pi-todo',
    version: '0.1.0',
    entries: ['/mock/home/.pi/agent/extensions/pi-todo/index.ts'],
    enabled: true,
    enabledBy: '默认加载（没有任何规则排除它）',
    evidence: 'package.json 声明 pi.piggy.capabilities 含 "todo"',
    probes: [],
  };
  return {
    capability: capability || 'todo',
    label: '任务清单',
    markers: ['todo_write'],
    detected: true,
    supported: enabled,
    enabled,
    plugin: enabled ? plugin : null,
    disabled: enabled ? [] : [{ ...plugin, enabled: false, enabledBy: '-extensions/pi-todo' }],
    considered: 6,
    problems: [],
  };
}

/** 从 mock 转录里折出清单（与 Rust 同规则：last-write-wins + 新一轮清空）。 */
function mockTodoProjection() {
  let current: Array<{ content: string; status: string }> | null = null;
  let source: 'event' | 'call' | null = null;
  let cleared = false;
  const readList = (value: unknown): Array<{ content: string; status: string }> | null => {
    if (!Array.isArray(value)) return null;
    const out: Array<{ content: string; status: string }> = [];
    for (const raw of value) {
      const item = raw as { content?: unknown; status?: unknown };
      if (typeof item?.content !== 'string') return null;
      if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return null;
      out.push({ content: item.content, status: item.status });
    }
    return out;
  };
  for (const row of mockTranscript) {
    const msg = row.message as { role?: string; content?: unknown; customType?: string; data?: unknown };
    if (msg.customType === 'todo/write') {
      const list = readList((msg.data as { todos?: unknown } | undefined)?.todos);
      if (list) {
        current = list;
        source = 'event';
        cleared = false;
      }
      continue;
    }
    if (msg.role === 'user') {
      if (current !== null) cleared = true;
      continue;
    }
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as { type?: string; name?: string; arguments?: { todos?: unknown } };
      if (b?.type !== 'toolCall' || b.name !== 'todo_write') continue;
      const list = readList(b.arguments?.todos);
      if (list) {
        current = list;
        source = 'call';
        cleared = false;
      }
    }
  }
  return {
    todos: cleared ? null : current,
    source,
    offset: null,
    branchy: false,
    scannedBytes: 0,
    parsedLines: 0,
  };
}

function mockPluginOverview() {
  const groups = [
    { id: 'project', label: '本项目', dir: '/mock/project/.pi', settingsPath: '/mock/project/.pi/settings.json' },
    { id: 'global', label: '全局', dir: '/mock/home/.pi/agent', settingsPath: '/mock/home/.pi/agent/settings.json' },
    { id: 'builtin', label: 'pi 内置', dir: '（随 pi 发布）', settingsPath: null },
  ].map((g) => {
    const plugins = mockPluginRows.filter((r) => r.scope === g.id);
    return { ...g, count: plugins.length, plugins };
  });
  const enabled = mockPluginRows.filter((r) => r.enabled).length;
  return {
    agentDir: '/mock/home/.pi/agent',
    agentDirFromEnv: false,
    projectDir: '/mock/project',
    groups,
    warnings: [],
    counts: {
      total: mockPluginRows.length,
      enabled,
      disabled: mockPluginRows.length - enabled,
      missing: mockPluginRows.filter((r) => !r.exists).length,
      updatable: mockPluginRows.filter((r) => r.updatable).length,
    },
  };
}

/** 与 Rust 的 `plugin_check_source` 同一条规则：裸包名要被指出来。 */
function mockCheckSource(source: string) {
  const s = source.trim();
  if (!s) return { ok: false, problem: '请填写来源', hint: '', sourceKind: 'local', sourceKindLabel: '本地路径' };
  if (s.startsWith('npm:')) {
    return { ok: true, problem: null, hint: '', sourceKind: 'npm', sourceKindLabel: 'npm 包' };
  }
  if (['git:', 'github:', 'http:', 'https:', 'ssh://', 'git://'].some((p) => s.startsWith(p))) {
    return { ok: true, problem: null, hint: '', sourceKind: 'git', sourceKindLabel: 'git 仓库' };
  }
  const bare = /^@[^/]+\/[^/]+$/.test(s) || (!s.includes('/') && /^[a-z0-9][a-z0-9._~-]*$/.test(s));
  if (bare) {
    return {
      ok: false,
      problem: 'pi 会把裸名字当本地路径，而不是 npm 包名',
      hint: `想装 npm 包请写成 npm:${s}`,
      sourceKind: 'local',
      sourceKindLabel: '本地路径',
    };
  }
  return { ok: true, problem: null, hint: '', sourceKind: 'local', sourceKindLabel: '本地路径' };
}

/**
 * mock 的上下文用量：**故意**用 pi 那种 f64 商，不留整数值。
 *
 * `15400 / 75800 × 100 = 20.316622691292876` —— 界面上任何一处忘记过
 * `formatPercent` 就会把这个尾巴印出来（用户 2026-09-23 报的
 * `上下文占用 20.316000000000003%` 就是这么来的）。门禁据此断言"百分比是
 * 整数或最多 3 位小数"，同时核对这个原始值本身**确实超过 3 位小数**，
 * 否则那条断言是空转（改回整数就会失去复现能力）。
 */
export const MOCK_CONTEXT_TOKENS = 15_400;
export const MOCK_CONTEXT_WINDOW = 75_800;
export const MOCK_CONTEXT_PERCENT = (MOCK_CONTEXT_TOKENS / MOCK_CONTEXT_WINDOW) * 100;

/**
 * 真机上**必填**的 IPC 参数（Tauri 会按 Rust 签名校验，缺了直接报
 * `invalid args \`x\` for command \`y\`: missing required key x`）。
 *
 * 为什么 mock 也要校验：2026-10-13 用户实测 —— 设置页里关掉「结构化提问」报
 * `command perf_config_save missing required key maxWorkers`。那条路在浏览器门禁里
 * **一次都没报过**，因为 mock 对缺参是宽容的（`Number(a.maxWorkers ?? appCfg.…)`），
 * 于是"前端忘了带必填字段"这件事只有真机才看得见 —— 又一条"mock 比真机宽松"
 * （docs/14 §6 记过这一类结构性风险）。
 *
 * 维护：Rust 侧把某个参数从 `Option<T>` 改成裸 `T` 时，这里要同步加进来。
 * 判据：**mock 的宽容度必须 ≤ 真机** —— 宽松的 mock 会把真机的报错藏起来。
 */
const REQUIRED_ARGS: Record<string, string[]> = {
  perf_config_save: ['maxWorkers', 'idleTimeoutMin'],
};

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  boot_reset: () => {
    // 与真机一致：收割上一 JS 上下文遗留的全部 tab（registry 清空）。
    // 这正是「boot_reset 与布局恢复抢时序」那个 bug 的另一半——
    // mock 以前是空实现，所以浏览器里永远复现不出「tab 不存在」。
    liveTabs.clear();
    persistTabs();
  },
  pi_discover: () => ({
    path: '/mock/bin/pi',
    version: '0.87.0',
    source: 'system',
    via: 'PATH',
    fromEnv: false,
  }),
  /* 形状必须与 src-tauri/src/pi/discovery.rs 的 PiSource / pi_source_options 一致。
     默认 source=system —— "默认使用系统 pi" 是明确要求，mock 不该给别的默认。 */
  pi_source_options: () => ({
    source: appCfg.pi_source,
    customPath: appCfg.pi_path,
    builtinAvailable: true,
    builtinPath: '/mock/App.app/Contents/Resources/resources/pi/pi',
    current: { path: '/mock/bin/pi', version: '0.87.0', source: 'system', via: 'PATH', fromEnv: false },
    options: [
      { id: 'system', label: '系统 pi', available: true },
      { id: 'bundled', label: '捆绑 pi', available: true },
      { id: 'custom', label: '自定义路径', available: true },
    ],
  }),
  pi_set_default_permission: (a) => {
    appCfg.permission_mode = String(a.mode);
    return { defaultPermission: appCfg.permission_mode };
  },
  pick_directory: () => null, // 浏览器 mock 无系统目录框：视为取消
  pick_pi_binary: () => '/mock/bin/pi', // mock 直接给一个路径，便于验证切档流程
  /* **有状态**的 config mock。
     以前这里是硬编码常量：点「完全权限」→ 保存成功 → reload 读回 'workspace'
     → 选中状态弹回原样，看起来就是"按钮点了没反应"。
     mock 不记录写入会让调试得出错误结论，所以必须真的存下来。 */
  /* 真机的 `perf_config_load` 返回的是 Rust `PerfConfig` —— **snake_case**
     （`title_max_chars` / `title_source` / …），前端读的也是 snake_case。
     这一份刻意保持同样的键名：mock 换成 camelCase 的话，"两边一致"这条
     就成了 mock 自己编出来的假象。 */
  perf_config_load: () => ({
    ...appCfg,
    title_max_chars: mockTitleCfg.maxChars,
    title_source: mockTitleCfg.source,
    title_model: mockTitleCfg.model || null,
    title_thinking: mockTitleCfg.thinking || null,
    transcript_rail: mockTitleCfg.rail,
    transcript_detail: mockTitleCfg.detail,
    bundled_plugins: [...mockTitleCfg.bundled],
  }),
  perf_config_save: (a) => {
    appCfg.max_workers = Number(a.maxWorkers ?? appCfg.max_workers);
    appCfg.idle_timeout_min = Number(a.idleTimeoutMin ?? appCfg.idle_timeout_min);
    if (a.piSource) appCfg.pi_source = String(a.piSource);
    if (a.piPath !== undefined) appCfg.pi_path = a.piPath === null ? null : String(a.piPath);
    // 不传 = 保持既有值（与真机 perf_config_save 的读-改-写语义一致）
    if (a.subagentDelegation !== undefined) {
      appCfg.subagent_delegation = Boolean(a.subagentDelegation);
    }
    // 标题那几项**真的写进去**：以前 mock 把这一段整个丢掉了，于是设置页在 mock 下
    // "改完再读回来还是默认值"——门禁也就永远核对不了"选完模型到底存了什么"。
    if (a.titleMaxChars !== undefined) mockTitleCfg.maxChars = Number(a.titleMaxChars);
    if (a.titleSource !== undefined) mockTitleCfg.source = String(a.titleSource);
    if (a.titleModel !== undefined) mockTitleCfg.model = String(a.titleModel ?? '');
    if (a.titleThinking !== undefined) mockTitleCfg.thinking = String(a.titleThinking ?? '');
    if (a.transcriptRail !== undefined) mockTitleCfg.rail = String(a.transcriptRail);
    if (Array.isArray(a.bundledPlugins)) mockTitleCfg.bundled = a.bundledPlugins.map(String);
    if (a.transcriptDetail !== undefined) {
      mockTitleCfg.detail = String(a.transcriptDetail);
      // 存一份：门禁切档之后重载页面还要是这一档（见 `mockTitleCfg.detail` 的注释）
      try {
        localStorage.setItem('piggy:mock:transcript-detail', mockTitleCfg.detail);
      } catch {
        /* 无 localStorage：门禁那条核对会失去意义，不影响真机 */
      }
    }
    return null;
  },
  tab_sleep: () => null,
  tab_sleep_idlest: () => ({ tabId: 'mock-tab-1' }),
  /* 真机这里要 spawn pi 进程 + `get_state` 握手（实测几百毫秒到 1 秒），
     是**恢复布局期间最慢的一步**。mock 以前几乎瞬时返回，时序与真机差一个量级——
     凡是"快慢决定结论"的 bug 在这里都会得出错误结论（本项目已因此误判过一次）。
     给一个量级相当的延迟，让 mock 的时序与真机同形。 */
  tab_create: async (a) => {
    await new Promise((r) => setTimeout(r, 250));
    const s = snapshot();
    const path = a?.sessionPath ?? a?.session_path;
    if (path) {
      s.session_file = String(path);
      /* 会话名**照抄宿主**：真机这里是 Rust 的 `session_name_of`
         （`sessions/registry.rs`）—— 调用方没给名字时取 pi 的 `get_state.sessionName`，
         而 pi 是从会话文件最新一条 `session_info` 读出来的（`session-manager.js:926-935`）。
         mock 里"文件里的名字"就是这张覆盖表（`session_title_generate` / `session_rename`
         往里写）。以前这里硬写 `'恢复的会话'`，**比真机宽松**：真机打开一个没名字的会话
         拿到的是 null（上方标题退回第一条用户消息），mock 却给了一个名字 ——
         于是"打开已命名会话，上方标题对不对"这条在 mock 下永远看不出来。 */
      const name = mockSessionNames.get(String(path)) ?? null;
      s.session_name = name;
      s.state = { ...s.state, sessionName: name };
    }
    if (a?.permission) s.permission = String(a.permission) as typeof s.permission;
    liveTabs.add(s.tab_id);
    persistTabs();
    return s;
  },
  /* 权限档位矩阵：**必须与 src-tauri/src/pi/permission.rs 的 PermissionMode 一致**。
     mock 与真实后端各自独立定义，一旦漂移就会藏住真机问题（本项目已经踩过一次：
     fs_list_dir 的 OsString 在 mock 里是字符串，真机才炸）。 */
  permission_modes: () => ({
    modes: [
      { id: 'read-only', label: '仅可查看', tools: 'read,grep,find,ls', unrestricted: false, pathGuard: false },
      {
        id: 'workspace',
        label: '工作区内修改',
        tools: 'read,grep,find,ls,write,edit',
        unrestricted: false,
        pathGuard: true,
      },
      { id: 'full', label: '完全权限', tools: null, unrestricted: true, pathGuard: false },
    ],
  }),
  pi_set_permission_mode: (a) => ({
    tabId: a.tabId,
    permission: a.mode,
    workerState: 'ready',
  }),
  tab_close: (a) => {
    liveTabs.delete(String(a?.tabId ?? a?.tab_id ?? ''));
    persistTabs();
  },
  pi_get_state: () => ({
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    isStreaming: false,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    sessionName: state.sessionName,
  }),
  pi_get_messages: () => ({ messages }),
  /**
   * 转录分页（docs/03 §2.19）：从 mock 转录的尾部往回给一页。
   *
   * 游标语义与真机一致（"已载入的第一行之前的边界"），只是 mock 用**行下标**
   * 而不是字节偏移——对前端它是不透明值，只有 Rust 那个实现需要关心单位。
   * 每页默认 50 行，与 Rust `DEFAULT_LIMIT` 对齐，否则门禁量到的分页行为和真机不一样。
   */
  session_page: (a) => {
    const total = mockTranscript.length;
    // 向下续页：`after` 优先（与 Rust `session_page` 同序）
    if (typeof a.after === 'number') {
      const from = Math.max(0, Math.min(a.after, total));
      const limit2 = typeof a.limit === 'number' && a.limit > 0 ? Math.min(a.limit, 500) : 50;
      let end = from;
      let rows2 = 0;
      let users2 = 0;
      for (let i = from; i < total; i += 1) {
        rows2 += 1;
        if (mockTranscript[i]?.role === 'user') users2 += 1;
        end = i + 1;
        // 与 Rust 一致：行数下限 + 轮数下限，**在轮边界收尾**（最后一条不是 user 行）
        if ((rows2 >= limit2 && users2 >= 5 && mockTranscript[i]?.role !== 'user') || rows2 >= 300) break;
      }
      return {
        rows: mockTranscript.slice(from, end).map((row, i) => ({ ...row, offset: from + i })),
        startOffset: from,
        endOffset: end,
        hasMore: from > 0,
        hasNewer: end < total,
        branchy: false,
      };
    }
    const before = typeof a.before === 'number' ? Math.min(a.before, total) : total;
    const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(a.limit, 500) : 50;
    // 与 Rust `collect_back` 同一条收页规则：**行数下限 + 轮数下限**，并有行数上限。
    // 只按行数会在工具密集的会话里一页只装一轮（用户实测 30 轮 / 1028 步 → 打开只看得到一轮，
    // 刻度梯 28/30 条是"未载入"）。mock 不跟上的话，门禁量到的分页行为和真机就是两回事。
    const MIN_TURNS = 5;
    const MAX_ROWS = 300;
    let start = Math.max(0, before - limit);
    let rows = 0;
    let users = 0;
    for (let i = before - 1; i >= 0; i -= 1) {
      rows += 1;
      if (mockTranscript[i]?.role === 'user') users += 1;
      start = i;
      if ((rows >= limit && users >= MIN_TURNS) || rows >= MAX_ROWS) break;
    }
    return {
      rows: mockTranscript
        .slice(start, before)
        .map((row, i) => ({ ...row, offset: start + i })),
      startOffset: start,
      endOffset: before,
      hasMore: start > 0,
      hasNewer: before < total,
      branchy: false,
    };
  },
  /**
   * 轮次轮廓（docs/03 §2.19）：整段 mock 转录的全部轮次。
   * 真机是 Rust 扫会话文件；mock 用行下标当偏移（对前端不透明），
   * 规则与真机一致：**每个 user 行开启新的一轮**，其后的 assistant 文本归这一轮。
   */
  /**
   * 会话的任务清单投影（Rust `transcript::todo_projection` 的 mock 版）。
   *
   * 规则必须与 Rust 侧**逐条一致**（否则门禁量到的是 mock 的行为，不是真机的）：
   * 最后一次整表写入赢（`todo/write` 条目优先，工具调用参数兜底），
   * 之后若出现用户消息（新一轮）则清空。
   */
  session_todo: () => mockTodoProjection(),
  session_outline: () => {
    const turns: Array<{ turn: number; start: number; end: number; prompt: string; response: string }> = [];
    const text = (m: unknown): string => {
      const c = (m as { content?: unknown })?.content;
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return '';
      return c
        .map((b) => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
        .join('\n');
    };
    mockTranscript.forEach((row, i) => {
      const msg = row.message as { role?: string; content?: unknown };
      if (row.role === 'user') {
        turns.push({ turn: turns.length + 1, start: i, end: i + 1, prompt: text(msg), response: '' });
      } else if (row.role === 'assistant') {
        const last = turns.at(-1);
        if (last && !last.response && text(msg).trim()) last.response = text(msg);
      }
    });
    // `end` = 这一轮内容的结束（= 下一轮用户行的起点，最后一轮 = 文件尾），
    // 与 Rust `outline` 的收尾规则一致：跳转落在"这一轮回答读完"的位置
    turns.forEach((t, i) => {
      t.end = turns[i + 1]?.start ?? mockTranscript.length;
    });
    return { turns, totalBytes: mockTranscript.length };
  },
  pi_get_session_stats: () => ({
    tokens: { input: 12_000, output: 3_400, total: 15_400, cacheRead: 9_000 },
    cost: 0.0321,
    contextUsage: {
      tokens: MOCK_CONTEXT_TOKENS,
      contextWindow: MOCK_CONTEXT_WINDOW,
      percent: MOCK_CONTEXT_PERCENT,
    },
    userMessages: 3,
    assistantMessages: 3,
    toolCalls: 5,
  }),
  pi_get_available_models: () => ({
    models: [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'mock-glm', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'mock-anthropic', contextWindow: 200_000 },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex', provider: 'mock-openai', contextWindow: 400_000 },
    ],
  }),
  pi_set_model: (a) => {
    const id = String(a.modelId ?? a.model_id ?? 'model');
    state.model = { id, name: id, provider: String(a.provider ?? 'mock') };
    return state.model;
  },
  pi_get_available_thinking_levels: () => ({ levels: ['off', 'minimal', 'low', 'medium', 'high'] }),
  pi_set_thinking_level: (a) => {
    state.thinkingLevel = String(a.level ?? 'medium');
    return { level: state.thinkingLevel };
  },
  pi_cycle_thinking: () => {
    const order = ['off', 'minimal', 'medium', 'high'];
    const i = order.indexOf(state.thinkingLevel);
    state.thinkingLevel = order[(i + 1) % order.length] ?? 'medium';
    return { level: state.thinkingLevel };
  },
  /* 命令条数与真机同量级：真 pi + pi-subagents + pi-web-access 实测 **54 条**（docs/18 §4 那次核对）。
   * 只给 3 条会让"补全列表能不能滚"这类问题在 mock 里直接消失——mock 撒谎比 mock 缺失更危险。 */
  pi_get_commands: () => ({
    commands: [
      { name: 'piggy:status', description: '把会话内子代理舰队快照同步到 Fleet 面板', source: 'extension' },
      { name: 'piggy:spawn', description: '派发一个会话内子代理：/piggy:spawn <agent> <任务>', source: 'extension' },
      { name: 'piggy:steer', description: '给运行中的子代理追加指令', source: 'extension' },
      { name: 'piggy:interrupt', description: '中断子代理当前回合', source: 'extension' },
      { name: 'piggy:stop', description: '停止后台子代理运行', source: 'extension' },
      { name: 'piggy:resume', description: '续跑已停止的子代理', source: 'extension' },
      { name: 'piggy:cost', description: '子代理成本/用量报告', source: 'extension' },
      { name: 'piggy:fleet-refresh', description: '刷新舰队快照', source: 'extension' },
      { name: 'review-pr', description: '评审当前 PR', source: 'prompt' },
      { name: 'fix-tests', description: '修复失败的测试', source: 'prompt' },
      { name: 'changelog', description: '生成变更日志', source: 'prompt' },
      { name: 'skill:brave-search', description: '联网搜索', source: 'skill' },
      { name: 'skill:pdf', description: '读取 PDF', source: 'skill' },
      { name: 'skill:docx', description: '读写 Word 文档', source: 'skill' },
      // 凑到 52 条，逼近真机规模
      ...Array.from({ length: 38 }, (_, i) => ({
        name: `pkg-cmd-${String(i + 1).padStart(2, '0')}`,
        description: `来自第三方包的第 ${i + 1} 条命令（用于凑满真机量级的补全列表）`,
        source: 'extension',
      })),
    ],
  }),
  // 生成标题后由 session_title_generate 往 mockSessionNames 里写一条覆盖，
  // 这里读出来——"生成完侧栏就变"这条链在 mock 里也是真的。
  session_list: () =>
    [
      // streaming-fix：创建最早（180 分钟前）但刚被写过（2 分钟前）
      // layout-wp1  ：创建更晚（40 分钟前）、写入也早
      // 按 mtime 排会把 streaming-fix 顶到最前；按创建时间排应该是 layout-wp1 在前。
      sessionMeta('/Users/mock/proj', 'streaming-fix', 2, '帮我看看这个项目的流式渲染管线', 180),
      sessionMeta('/Users/mock/proj', 'layout-wp1', 40, '工作区布局 v1 落地', 40),
      sessionMeta('/Users/mock/testpilot', 'nightly-audit', 3_000, '审核夜间构建', 5_000),
    ].map((m) => (mockSessionNames.has(m.path) ? { ...m, name: mockSessionNames.get(m.path)! } : m)),
  /* ── 下面这几条是「前端真的会调、mock 从前没有」的补齐（由
     `ipc-mock-coverage.test.ts` 扫出来的）：兜底分支静默返回 `{}` 时，界面表现是
     "点了没反应"而门禁全绿 —— 与 docs/14 §6 记的那类风险同源。 ── */

  /** 外部链接：真机交系统浏览器（Rust 侧再校验 scheme）。mock 记一笔并成功。 */
  open_external_url: (a) => {
    externalOpenCalls.push(String(a.url ?? ''));
    return null;
  },
  /**
   * 中断：把这一轮正在跑的假流式停掉（`streamFor` 的循环会看这个标记）。
   *
   * ⚠️ **不动队列** —— 真机的 `abort` 只管中止运行，队列里的消息会留到下一次 run
   * （`docs/rpc-commands.md`：「abort continues queued messages when they remain in the
   * session」）。老前端把"中断 + clear_queue"绑成 Esc，那是客户端行为，不是协议行为。
   */
  pi_abort: (a) => {
    abortedTabs.add(String(a.tabId ?? a.tab_id ?? TAB));
    return null;
  },
  /**
   * 清空排队消息。真机 `clear_queue` 是**破坏性读**：清空并**返回被清掉的那批**
   * （`agent-session.ts:2427-2435`），调用方靠它做"取回暂存"。mock 必须同形，
   * 否则队列 dock 的取回逻辑在浏览器里永远拿到空数组、静默什么都不做。
   */
  pi_clear_queue: (a) => {
    const tabId = String(a.tabId ?? a.tab_id ?? TAB);
    const q = queueOf(tabId);
    const cleared = { steering: [...q.steering], followUp: [...q.followUp] };
    q.steering = [];
    q.followUp = [];
    emitQueue(tabId);
    return cleared;
  },
  /**
   * 扩展 UI 应答（DialogRouter 与提问卡用的就是它）。
   *
   * mock 除了回一个"收到"，还把内容记进 {@link uiReplies} —— 门禁要核对
   * "提问卡的答案真的按契约送回去了"（`{id, value}` 里 value 是回答 JSON）。
   */
  /**
   * 随包带的插件（真机由 Rust 读清单；mock 里照抄真实返回的形状）。
   *
   * 三条形状都要有样本，否则界面的分支在门禁里看不见：
   *   · 正常注入的一行（`source_tree`/`resource_dir` 之外的普通情形）；
   *   · **目录缺失**的一行（`dir: null` + skipped 说明"随包分发不完整"）；
   *   · origin 是 `resource_dir`（打包后的正式落点）。
   * 参数里的 `projectDir` 在 mock 里不影响结果（真机用它查项目级同名扩展）。
   */
  plugin_bundled: () => ({
    plugins: [
      {
        name: 'pi-ask',
        title: '结构化提问',
        description: '让模型用一张卡问你 1–6 个问题（选项/多选/自由文本），并带 /plan 计划模式。',
        license: 'GPL-3.0-or-later',
        tools: ['ask_user_question', 'exit_plan_mode'],
        commands: ['plan', 'plan-off'],
        dir: '/mock/resources/pi-plugins/pi-ask',
        origin: '随包分发',
        originKind: 'resource_dir',
        bundled: true,
        enabled: mockBundledEnabled(),
        inject: mockBundledEnabled(),
        skipped: mockBundledEnabled() ? null : '设置里关掉了',
      },
      {
        name: 'pi-guardrails',
        title: '写前校验护栏',
        description: '拦「改已存在但没读过的文件」、锁内 CAS、原子发布、空响应兜底。',
        license: 'MIT',
        tools: ['write', 'edit'],
        commands: [],
        dir: '/mock/resources/pi-plugins/pi-guardrails',
        origin: '随包分发',
        originKind: 'resource_dir',
        bundled: true,
        enabled: true,
        inject: true,
        skipped: null,
      },
      {
        name: 'pi-todo',
        title: '任务清单（DSH 风格）',
        description: '随 Piggy 分发的第三方 pi 插件。',
        license: 'MIT',
        tools: ['todo_enable', 'todo_write'],
        commands: ['todos'],
        dir: null,
        origin: null,
        originKind: null,
        bundled: true,
        // 配置里**默认只开 pi-ask** → 这一行的勾选框是关的（缺目录是另一件事，两句话分开说）
        enabled: false,
        inject: false,
        skipped: '这一份安装里没有这个目录（随包分发不完整：bundle.resources 没登记 resources/pi-plugins）',
      },
    ],
  }),
  ui_reply: (a) => {
    const r = (a.response ?? {}) as Record<string, unknown>;
    uiReplies.push({
      id: String(r.id ?? ''),
      value: r.value,
      cancelled: r.cancelled === true,
    });
    return null;
  },
  /**
   * 会话改名（`pi_set_session_name`）。
   *
   * ⚠️ 与 `session_rename`（Piggy 自己扫文件目录那条路）**不是一回事**：前者改的是
   * pi 会话文件里的 `session_info.name`，后者改的是文件名/元数据。mock 里两者都写进
   * 同一张覆盖表 `mockSessionNames`，于是"改完侧栏就变"这条链在 mock 下也是真的。
   */
  pi_set_session_name: (a) => {
    const key = String(a.sessionFile ?? a.path ?? a.tabId ?? '');
    const name = String(a.name ?? '');
    if (key) mockSessionNames.set(key, name);
    return null;
  },
  /** 内嵌登录终端的 PTY：mock 没有真 PTY，给一个 id 让界面进入"已连接"形态。 */
  pty_open: () => ({ id: `mock-pty-${nextMockPtyId++}` }),
  session_delete: () => {},
  session_rename: (args) => {
    // 重命名也走同一张覆盖表：不然门禁里"重命名之后列表变了"会与生成标题不一致
    mockSessionNames.set(String(args.path ?? ''), String(args.name ?? ''));
  },
  layout_load: () => {
    try {
      return JSON.parse(localStorage.getItem('pg.mockLayout') ?? '{}');
    } catch {
      return {};
    }
  },
  layout_save: (a) => {
    localStorage.setItem('pg.mockLayout', JSON.stringify(a.value));
    return null;
  },
  pi_get_tree: () => ({
    tree: [
      {
        id: 'root-1',
        entry: null,
        children: [
          { id: 'n-user', entry: { role: 'user' }, children: [] },
          { id: 'n-asst', entry: { role: 'assistant' }, children: [{ id: 'n-tool', entry: { role: 'toolResult' }, children: [] }] },
        ],
      },
    ],
  }),
  pi_get_fork_messages: () => ({ messages: [{ entryId: 'm1', text: 'fork 点一' }] }),
  fs_list_dir: (a) => {
    // mock 目录树：够验证懒加载/展开/打开预览，不追求像真实项目
    const path = String(a.path);
    const base = path.split('/').filter(Boolean).at(-1) ?? 'proj';
    return {
      entries: [
        { name: 'src', isDir: true, size: 0 },
        { name: 'docs', isDir: true, size: 0 },
        { name: 'README.md', isDir: false, size: 2048 },
        { name: `${base}.json`, isDir: false, size: 512 },
      ],
    };
  },
  /* ---------------- 「打开方式」（open_in_app_*）：模拟宿主的解析/图标/启动 ----------------
   * 三个命令的形状与 Rust 侧一致（list 返回 id 数组、icon 返回 data URL 或 null、
   * open 返回空）。`openCalls` 记下每次启动的实参，门禁据此断言"点的到底是哪个应用、哪个目录"。
   */
  open_in_app_list: () => ['finder', 'vscode', 'goland', 'iterm', 'terminal'],
  open_in_app_icon: (a) => {
    const id = String(a.id ?? '');
    // 两个给真图（走 <img> 路径）、其余不给（走通用图标路径）——两条渲染路径都要被走到
    if (id !== 'vscode' && id !== 'goland') return null;
    return MOCK_APP_ICON;
  },
  open_in_app_open: (a) => {
    openCalls.push({ id: String(a.id ?? ''), path: String(a.path ?? '') });
    return null;
  },
  /* ---------------- 文件级（open_path_*）：模拟操作系统的文件关联 ----------------
   * 真机上这一档由 `osascript`/`gio` 查出来；mock 给两个处理器 + 一个默认项，
   * 让"默认应用 / 指定应用 / 显示文件位置"三条路都能在浏览器里被走到。
   */
  open_path_available: () => true,
  open_path_applications: (a) => {
    void a;
    return [
      { id: '/Applications/Typora.app', name: 'Typora.app', default: true, icon: MOCK_APP_ICON },
      { id: '/Applications/Visual Studio Code.app', name: 'Visual Studio Code.app', default: false, icon: null },
    ];
  },
  open_path_open: (a) => {
    pathCalls.push({
      path: String(a.path ?? ''),
      action: String(a.action ?? 'open'),
      application: a.application === undefined || a.application === null ? null : String(a.application),
    });
    return null;
  },
  fs_preview_read: (a) => {
    // 内容随扩展名变化：这样语法高亮/行号/换行等渲染路径在 mock 下也**真的被走到**，
    // 而不是所有文件都吐同一段文本（那会让高亮相关的回归悄无声息地漏掉）。
    const path = String(a.path);
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const samples: Record<string, string> = {
      ts: `// mock 预览内容\nexport interface Live {\n  tabId: string;\n}\n\nexport function liveFor(tabId: string): Live {\n  return { tabId };\n}\n`,
      tsx: `import { useState } from 'react';\n\nexport function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}\n`,
      json: `{\n  "name": "piggy",\n  "version": "0.1.0",\n  "private": true,\n  "count": 42,\n  "ok": false\n}\n`,
      md: `# Piggy\n\n**pi 的图形驾驶舱**：以 pi 为引擎、Tauri 2 为壳。\n\n- 流式渲染\n- 工具调用卡片\n- 行内 code：\u0060tabId\u0060\n`,

      css: `:root {\n  --pg-bg-app: rgb(21, 21, 23);\n}\n\n.pg-app {\n  display: flex;\n  height: 100vh;\n}\n`,
      // 每种 token 都来一点（注释/关键字/字符串/数字/标识符）：ui:startup 第 5 节要断言
      // "预览里真的出现了不止一种 token 颜色"，样本太单调的话断言等于没断言
      // .rs 只在新语言表里（原来的本地表认不出它）—— ui:startup 第 9 段用它证明
      // "语言表存在 ≠ 预览真的用了它"：样本要含多种 token，否则断言等于没断言
      rs: `// mock 预览内容
use std::collections::HashMap;

pub const VERSION: &str = "0.1.0";

pub fn main() {
    let mut seen: HashMap<String, u32> = HashMap::new();
    seen.insert("a".to_string(), 1);
    if seen.len() > 0 {
        println!("{} {:?}", VERSION, seen);
    }
}
`,
      go: `// mock 预览内容\npackage main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nconst version = "0.1.0"\n\nfunc main() {\n\tif len(os.Args) < 2 {\n\t\tfmt.Println("usage: demo <name>")\n\t\tos.Exit(1)\n\t}\n\tfmt.Printf("hello %s\\n", os.Args[1])\n}\n`,
    };
    const content = samples[ext] ?? `// ${path}\n`;
    return {
      path,
      size: content.length,
      lines: content.split('\n').length,
      content,
    };
  },
  pi_stderr_tail: () => [],
  session_dir_effective: () => ({ dir: '/Users/mock/.pi/agent/sessions', isCustom: false, raw: null, source: 'default' }),
  auth_list: () => ({
    providers: [
      { provider: 'mock-anthropic', kind: 'api_key', masked: 'sk-ant…Xk2f' },
      { provider: 'mock-glm', kind: 'api_key', masked: 'gl-8888…ZZZZ' },
    ],
  }),
  auth_set_key: () => null,
  auth_remove: () => null,
  /* ---- 提供商配置（docs/04 §3.4） ----
     mock 的形状**照抄真机**：两台 models.json 自定义路由（内联密钥，其中一个带模型目录），
     auth.json 空着——这是本机 `~/.pi/agent` 的真实样子（用户用 cc-switch 那类工具写的）。
     以前这里只给 auth.json 的假条目，于是"配置页看不到自己真正的提供商"这件事
     在 mock 下永远复现不出来。 */
  /* ---------------- 会话标题生成（docs/03 §2.16） ----------------
     mock 里不调模型（那会联网），只把**往返形状**做出来：门禁据此核对
     "右键菜单能唤出、点了会发命令、标题真的写回会话名、失败有提示"。

     `titleFail` 是给门禁用的开关：设成 1 之后第一次调用抛错，
     用来核对"失败时保留原来的名字、且用户看得见原因"。 */
  session_title_source: (args) => {
    const path = String(args.path ?? '');
    return {
      cwd: '/mock/project',
      provider: 'mock-glm',
      modelId: 'glm-5.3-flash',
      // 「会用哪个模型」跟**实际生效**的那个走（真机同一条规则）：
      // 设置里有覆盖就用覆盖，否则会话自己的
      modelUsed: mockTitleCfg.model || 'mock-glm/glm-5.3-flash',
      modelSource: mockTitleCfg.model ? 'override' : 'session',
      modelError: null,
      thinking: mockTitleCfg.thinking || null,
      firstMessage: mockTitleSource.first,
      recentMessages: mockTitleSource.recent,
      userMessageCount: mockTitleSource.recent.length + 1,
      messageCount: 12,
      currentName: mockSessionNames.get(path) ?? null,
      strategy: mockTitleCfg.source,
      maxChars: mockTitleCfg.maxChars,
      promptChars: 180,
    };
  },
  /* 「标题模型」下拉的数据源。真机这里是起一个一次性 pi 跑 `--list-models`（0.6s），
     mock 里直接给三行（含一个不支持推理的模型，用来核对"档位禁用+说明原因"）。 */
  title_model_options: () => ({
    models: mockTitleModels,
    note: null,
    piBin: '/mock/bin/pi',
    elapsedMs: 612,
  }),
  session_title_generate: (args) => {
    const path = String(args.path ?? '');
    const apply = args.apply !== false;
    if (mockTitleFail) {
      mockTitleFail = false;
      throw new Error(
        '模型没有给出可用的标题（原样输出：""）——已保留原来的名字',
      );
    }
    const raw = `  「${mockTitleNext}」  `;
    const title = mockTitleNext;
    mockTitleSeq += 1;
    mockTitleNext = mockTitleSeq % 2 === 0 ? '插件管理页的标题生成' : '会话标题：重新生成';
    if (apply) {
      // 真机是 pi 往会话文件里追加一条 session_info；mock 里用一层覆盖表体现，
      // 由 session_list 读出来——这样"生成完重新 load 就能看到新名字"这条链是真的。
      mockSessionNames.set(path, title);
    }
    return {
      title,
      raw,
      provider: 'mock-glm',
      modelId: 'glm-5.3-flash',
      modelUsed: mockTitleCfg.model || 'mock-glm/glm-5.3-flash',
      // 与真机同一条规则：报的是**请求值**（pi 会按模型能力静默降级，客户端拿不到降级后的值）
      thinkingUsed: mockTitleCfg.thinking || null,
      elapsedMs: 812,
      promptChars: 180,
      applied: apply,
      source: {
        cwd: '/mock/project',
        provider: 'mock-glm',
        modelId: 'glm-5.3-flash',
        modelUsed: mockTitleCfg.model || 'mock-glm/glm-5.3-flash',
        modelSource: mockTitleCfg.model ? 'override' : 'session',
        modelError: null,
        thinking: mockTitleCfg.thinking || null,
        firstMessage: mockTitleSource.first,
        recentMessages: mockTitleSource.recent,
        userMessageCount: 3,
        messageCount: 12,
        currentName: null,
        strategy: mockTitleCfg.source,
        maxChars: mockTitleCfg.maxChars,
        promptChars: 180,
      },
    };
  },
  /* ---------------- 关于与许可（docs/03 §2.17） ----------------
     形状与真机一致（camelCase），文本是**节选并写明节选**（见上面的说明）。 */
  legal_notices: () => ({
    name: 'Piggy',
    version: '0.1.0',
    copyright: 'Copyright (C) 2026 wxk6b1203',
    spdx: 'GPL-3.0-or-later',
    licenseName: 'GNU General Public License v3.0 or later',
    warranty:
      '本程序是自由软件：你可以按自由软件基金会发布的 GNU 通用公共许可证（第 3 版，' +
      '或你选择的任何更新版本）重新分发和/或修改它。本程序的分发是希望它有用，' +
      '但没有任何担保，甚至没有适销性或特定用途适用性的默示担保。',
    licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
    gplText: mockGplExcerpt,
    thirdParty: mockThirdParty,
  }),
  /* ---------------- 插件页（docs/04 §2.3） ---------------- */
  plugin_overview: () => mockPluginOverview(),
  plugin_capability: (a) => mockPluginCapability(String(a.capability ?? '')),
  plugin_jobs: () => ({ jobs: [...mockPluginJobs.values()] }),
  plugin_job_cancel: (args) => {
    const id = String(args.jobId ?? '');
    const job = mockPluginJobs.get(id);
    if (job) {
      job.running = false;
      job.exitCode = -1;
      job.error = '已取消';
      emitPlugin(`plugin:done:${id}`, { id, exitCode: -1, error: '已取消', ok: false });
    }
    return {};
  },
  plugin_project_trust: () => ({
    trusted: true,
    matched: '/mock/project',
    dir: '/mock/project',
    trustFile: '/mock/home/.pi/agent/trust.json',
  }),
  plugin_check_source: (args) => mockCheckSource(String(args.source ?? '')),
  plugin_set_enabled: (args) => {
    const key = String(args.key ?? '');
    const row = mockPluginRows.find((r) => r.key === key);
    if (!row) throw new Error(`找不到插件 ${key}`);
    row.enabled = args.enabled === true;
    row.enabledBy = row.enabled
      ? row.kind === 'builtin'
        ? 'pi 内置扩展：随 pi 发布；可以用设置里的 -builtin:… 关掉'
        : '默认加载（没有任何规则排除它）'
      : row.kind === 'builtin'
        ? '全局 settings.json 里被 -builtin:… 关掉'
        : '被 /mock/home/.pi/agent/settings.json 的 - 规则强制排除';
    return { ok: true };
  },
  plugin_delete_discovered: (args) => {
    const key = String(args.key ?? '');
    const i = mockPluginRows.findIndex((r) => r.key === key);
    if (i < 0) throw new Error(`找不到插件 ${key}`);
    mockPluginRows.splice(i, 1);
    return { ok: true };
  },
  plugin_remove_path: () => ({ ok: true }),
  plugin_add_path: () => ({ ok: true }),
  plugin_run: (args) => {
    const action = String(args.action ?? 'install');
    const source = String(args.source ?? '(全部)');
    const id = `job-${++mockJobSeq}`;
    const job = {
      id,
      action,
      target: source,
      command: `/mock/bin/pi ${action} ${source}`,
      cwd: '/mock/project',
      running: true,
      exitCode: null as number | null,
      lines: [`> pi ${action} ${source}`, 'added 1 package in 0.4s'],
      truncated: false,
      error: null as string | null,
      startedMs: Date.now(),
    };
    mockPluginJobs.set(id, job);
    // 真机是流式的；mock 里异步收尾，好让"运行中 → 已完成"这条状态转换也能被门禁看到
    setTimeout(() => {
      job.running = false;
      job.exitCode = 0;
      emitPlugin(`plugin:log:${id}`, { id, stream: 'stdout', line: 'done' });
      emitPlugin(`plugin:done:${id}`, { id, exitCode: 0, error: null, ok: true });
    }, 120);
    return { jobId: id };
  },
  provider_overview: () => ({
    providers: providerRows(),
    catalog: CATALOG_SUBSET,
    apiOptions: [
      'openai-completions',
      'mistral-conversations',
      'openai-responses',
      'azure-openai-responses',
      'openai-codex-responses',
      'anthropic-messages',
      'bedrock-converse-stream',
      'google-generative-ai',
      'google-vertex',
      'pi-messages',
    ],
    defaults: { provider: 'cc-switch-zhipu-glm', model: 'glm-5.3-flash' },
    paths: {
      agent: '/Users/mock/.pi/agent',
      auth: '/Users/mock/.pi/agent/auth.json',
      models: '/Users/mock/.pi/agent/models.json',
      settings: '/Users/mock/.pi/agent/settings.json',
    },
  }),
  provider_save: (a) => {
    const id = String(a.provider);
    const patch = (a.patch ?? {}) as Record<string, unknown>;
    const cur = mockProviders[id] ?? { provider: id, keySource: 'none', hasInlineKey: false };
    const next = { ...cur };
    // 空串 = 删键（回落到 pi 目录默认值），与 Rust provider_save 的语义一致
    for (const key of ['name', 'baseUrl', 'api'] as const) {
      if (key in patch) {
        const v = String(patch[key] ?? '').trim();
        if (v) next[key] = v;
        else delete next[key];
      }
    }
    if ('models' in patch) {
      const rows = (patch.models ?? []) as { id: string }[];
      if (rows.length) next.models = rows as never;
      else delete next.models;
    }
    mockProviders[id] = next;
    return next;
  },
  provider_set_key: (a) => {
    const id = String(a.provider);
    const prev = mockProviders[id] ?? { provider: id };
    mockProviders[id] = {
      ...prev,
      keySource: a.store === 'models' ? 'models_json' : 'auth',
      keyMasked: 'sk-mock…cdef',
      hasInlineKey: a.store === 'models' ? true : (prev.hasInlineKey ?? false),
    };
    return null;
  },
  provider_remove_key: (a) => {
    const id = String(a.provider);
    const cur = mockProviders[id];
    if (cur) {
      const store = String(a.store ?? 'both');
      if (store === 'both') {
        mockProviders[id] = { ...cur, keySource: 'none', keyMasked: null, hasInlineKey: false };
      } else if (store === 'models') {
        mockProviders[id] = { ...cur, hasInlineKey: false };
      } else {
        mockProviders[id] = { ...cur, keySource: cur.hasInlineKey ? 'models_json' : 'none', keyMasked: null };
      }
    }
    return null;
  },
  provider_remove: (a) => {
    delete mockProviders[String(a.provider)];
    return null;
  },
  /** 「检测 / 获取可用模型」：形状与 Rust `provider_discover` 一致。 */
  provider_discover: (a) => {
    const base = String(a.baseUrl ?? '').replace(/\/+$/, '');
    const anthropicStyle = String(a.api ?? '') === 'anthropic-messages';
    return {
      source: 'network',
      url: anthropicStyle ? `${base.replace(/\/v1$/, '')}/v1/models?limit=1000` : `${base}/models`,
      keySource: a.apiKey ? 'typed' : 'models_json',
      models: [
        { id: 'mock-flash', name: 'Mock Flash', contextWindow: 128000, maxTokens: 32000 },
        { id: 'mock-pro', name: 'Mock Pro', contextWindow: 1000000, maxTokens: 384000 },
      ],
    };
  },
  models_read: () => ({
    providers: {
      'mock-ollama': {
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        apiKey: 'ollama',
        models: [{ id: 'qwen3:8b' }],
      },
    },
  }),
  models_write: () => null,
  settings_read: () => ({ defaultThinkingLevel: 'medium', compaction: { enabled: true } }),
  settings_write: () => null,
  /* 轨迹数据刻意复刻**真机会话的顺序**：标记 → 用户 → 系统 → 助手。
     系统条目带 `sections` → 产生可展开行；且它不是本轮第一行，所以会渲染成正文行
     （本轮第一行会被渲染成轮次头，那条路径看不到 <details>）。
     2026-09-23：正是这个形状暴露了"展开后行与行重叠"的 bug。 */
  pi_get_entries: () => ({
    entries: [
      { type: 'session_info', id: 'e0', timestamp: new Date(now() - 51_000).toISOString(), name: '轨迹演示' },
      {
        type: 'message',
        id: 'e1',
        timestamp: new Date(now() - 50_000).toISOString(),
        message: {
          role: 'user',
          content: '你好！How are you today? I can read and edit files, work with documents (Word, PDF, Excel, PowerPoint), and answer questions about the code in this workspace.',
        },
      },
      {
        type: 'message',
        id: 'e2',
        timestamp: new Date(now() - 49_500).toISOString(),
        message: {
          role: 'system',
          content: '',
          sections: {
            docs: 'pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI)\n\n- Main documentation: /Users/mock/.nvm/versions/node/v24/lib/node_modules/@earendil-works/pi-coding-agent/README.md\n- Additional docs: /Users/mock/.nvm/versions/node/v24/lib/node_modules/@earendil-works/pi-coding-agent/docs\n- Examples: /Users/mock/.nvm/versions/node/v24/lib/node_modules/@earendil-works/pi-coding-agent/examples',
            tools: '<tools>\n- read: Read file contents\n- bash: Execute bash commands\n- edit: Make precise file edits\n</tools>',
            cwd: '<cwd>\n/Users/mock/proj\n</cwd>',
          },
        },
      },
      {
        type: 'message',
        id: 'e3',
        timestamp: new Date(now() - 49_000).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'I am doing well, thanks for asking. I can read and edit files, run commands, and work with documents in this workspace — tell me what you would like to look at first.',
            },
          ],
        },
      },
      { type: 'context_edit', id: 'e4', timestamp: new Date(now() - 47_000).toISOString(), targetId: 'e1', replacement: null },
      /* 压缩条目按**真机形状**写（pi `docs/compaction.md` §CompactionEntry Structure；
         本机 `2026-09-21T14-18-43-680Z_01a0c455….jsonl` 里的那条就是这个形状）。
         以前这里只有 `{type,id,timestamp}` 三个字段 —— 于是"压缩看不到细节"这个 bug
         在门禁里根本复现不出来（夹具里压根没有细节可显示）。 */
      MOCK_COMPACTION_ENTRY,
      /* 预览滚动条（docs/04 §2.6）的核对需要**多轮**会话：刻度梯至少要两条刻度才画。
         这里补 7 轮（用户 + 回答），既有内容可预览，也够长到能滚起来。 */
      ...Array.from({ length: 7 }, (_, i) => {
        const base = 40_000 - i * 4_000;
        return [
          {
            type: 'message',
            id: `rail-u${i}`,
            timestamp: new Date(now() - base).toISOString(),
            message: {
              role: 'user',
              content: [{ type: 'text', text: `第 ${i + 2} 轮：帮我看一下模块 ${i + 1} 的边界条件` }],
            },
          },
          {
            type: 'message',
            id: `rail-a${i}`,
            timestamp: new Date(now() - base + 1_000).toISOString(),
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `第 ${i + 2} 轮的回答：模块 ${i + 1} 的边界条件是空数组与重复 id，两处都补了测试。` }],
            },
          },
        ];
      }).flat(),
    ],
    leafId: 'e5',
  }),
  pi_compact: () => ({ summary: 'mock 压缩摘要' }),
  pi_export_html: () => ({ path: '/Users/mock/Downloads/session.html' }),
  pi_bash: () => ({ output: 'mock-bash-output', exitCode: 0, cancelled: false, truncated: false }),
  /* M3 Fleet（mock 演示：启动 → 2.5s 后全部 settle，驱动面板）
   *
   * ⚠️ 参数名：`cmd()` 直传 camelCase（Tauri 侧才做 snake_case 映射），
   * 所以 mock 处理器也**必须读 camelCase**。这里曾读 `a.template_id`，
   * 于是 mock 下 templateId 恒为 "undefined"、lane 集合永远走默认分支——
   * 真机正常、mock 骗人，正是 docs/15 规矩 4 说的那类分歧。 */
  fleet_templates: () => ({
    'parallel-review': { label: '并行评审' },
    'scout-review-build': { label: '侦察 → 评审 + 构建' },
    research: { label: '调研汇总' },
    custom: { label: '自定义' },
  }),
  fleet_list: () => ({ runs: mockFleet.runs }),
  fleet_start: (a) => {
    const templateId = String(a.templateId ?? '');
    const runId = `mock-run-${Date.now()}`;
    const lanes = MOCK_LANES[templateId] ?? MOCK_LANES['parallel-review']!;
    const lanesOf = (status: string, preview?: string) =>
      lanes.map((k) => ({
        key: k,
        role: k,
        status,
        tabId: `mock-${runId}-${k}`,
        ...(preview ? { resultPreview: preview } : {}),
      }));
    const run = {
      id: runId,
      templateId,
      task: String(a.task ?? ''),
      cwd: String(a.cwd ?? ''),
      status: 'running' as string,
      lanes: lanesOf('running'),
    };
    mockFleet.runs = [run];
    // 深拷贝再 emit：immer 的 auto-freeze 会冻结被写进 store 的对象，
    // 直接把自己的内部对象交出去，后面的定时器改它就会
    // `TypeError: Cannot assign to read only property 'status'`（实测踩到）。
    // 真机每次发的是新 JSON，所以 mock 也必须发副本。
    const snapshot = () => structuredClone({ runs: mockFleet.runs });
    setTimeout(() => emit('fleet:changed', snapshot()), 400);
    setTimeout(() => {
      run.status = 'done';
      run.lanes = lanesOf('settled', 'mock 结论：一切正常。');
      emit('fleet:changed', snapshot());
    }, 2500);
    return runId;
  },
  fleet_abort: (a) => {
    const run = mockFleet.runs.find((r) => r.id === a.runId);
    if (!run) throw new Error(`run 不存在: ${String(a.runId)}`);
    run.status = 'aborted';
    run.lanes = run.lanes.map((l) =>
      l.status === 'running' || l.status === 'pending' ? { ...l, status: 'failed' } : l,
    );
    emit('fleet:changed', structuredClone({ runs: mockFleet.runs }));
    return null;
  },
  fleet_steer: (a) => {
    const run = mockFleet.runs.find((r) => r.id === a.runId);
    if (!run) throw new Error(`run 不存在: ${String(a.runId)}`);
    const lane = run.lanes.find((l) => l.key === a.laneKey);
    if (!lane) throw new Error(`lane 不存在: ${String(a.laneKey)}`);
    if (!String(a.message ?? '').trim()) throw new Error('steer 需要非空消息');
    // 真机语义：流式中 = true（已转向），空闲 = false（当普通补发）
    return lane.status === 'running';
  },
  fleet_open_lane: (a) => {
    const run = mockFleet.runs.find((r) => r.id === a.runId);
    const lane = run?.lanes.find((l) => l.key === a.laneKey);
    if (!run || !lane) throw new Error(`lane 不存在: ${String(a.laneKey)}`);
    return {
      tab_id: lane.tabId,
      cwd: run.cwd || '/Users/mock/proj',
      session_file: null,
      session_id: null,
      session_name: `${lane.role} · ${run.task.slice(0, 24)}`,
      worker_state: 'ready',
      state: {},
    };
  },
  pi_abort_bash: () => null,
};

/**
 * prompt：脚本化流式演示（合帧后的帧节奏，docs/04 §4.1 同构）。
 *
 * **队列语义照真机**（`agent-session.ts:2053-2136`）：
 *  - 正在流式中且**没带** `streamingBehavior` → 报错（真机那句原文）；
 *  - 正在流式中带了 → 只入队、推 `queue_update`、立刻返回（`success:true`）；
 *  - 空闲 → 起一轮假流式（`streamingBehavior` 在这条路上被忽略，真机也是）。
 *
 * 队列的**消费**时机也对齐：`steering` 在助手消息结束后吃掉（`agent-loop.ts:295`），
 * `followUp` 只在"本来要停了"的时候才吃（`:302-308`）—— 也就是本函数收尾那一处。
 */
async function mockPrompt(args: Record<string, unknown>) {
  // 前端 cmd() 直传 camelCase（Tauri 侧才做 snake_case 映射）
  const tabId = String(args.tabId ?? args.tab_id ?? TAB);
  const text = String(args.message ?? '');
  const behavior = args.streamingBehavior ?? args.streaming_behavior;
  // 扩展命令：真实 pi 里 `/piggy:*` 由扩展即时执行、**不经过模型**（docs/06 §4.2），
  // mock 照抄这个语义——否则浏览器里点"刷新子代理"会得到一段假回复，掩盖链路问题。
  if (text.startsWith('/piggy:')) {
    mockBridgeCommand(tabId, text);
    return;
  }
  const emitCommit = (type: string, extra: Record<string, unknown> = {}): void =>
    emit(`pi:commit:${tabId}`, { type, ...extra });
  if (mockStreamingTabs.has(tabId)) {
    // 流式中：pi 只接受这两种投递语义，别的直接拒绝（disposition 才是真机回的东西）
    if (behavior !== 'steer' && behavior !== 'followUp') {
      throw new Error(
        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      );
    }
    queueOf(tabId)[behavior === 'steer' ? 'steering' : 'followUp'].push(text);
    emitQueue(tabId);
    return;
  }
  mockStreamingTabs.add(tabId);
  try {
    emitCommit('agent_start');
    emitCommit('message_start', { message: { role: 'user', content: text, timestamp: now() } });
    emitCommit('message_end', { message: { role: 'user', content: text, timestamp: now() } });
    emitCommit('turn_start');
    emitCommit('message_start', { message: { role: 'assistant', content: [] } });
    const reply = `这是 **mock 流式回复**：你发送了「${text.slice(0, 40)}」。合帧器把它切成 60Hz 帧逐段上屏。`;
    const chunk = Math.ceil(reply.length / 12);
    for (let i = 0; i < reply.length; i += chunk) {
      emitFrame(tabId, { text: [{ contentIndex: 0, delta: reply.slice(i, i + chunk) }], usage: { totalTokens: 500 + i * 10 } });
      await new Promise((r) => setTimeout(r, 70));
    }
    emitCommit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: now() },
    });
    emitCommit('turn_end', { message: {} });
    /* 队列消费（顺序即 pi 的 drain 顺序）：
       ① steering 在 `turn_end` 之后被吃掉 → 变成用户消息进转录；
       ② followUp 只在"本来要停了"时吃 → 吃到了就再跑一轮（这里简化为把它当用户消息发出来）。 */
    const q = queueOf(tabId);
    const steering = [...q.steering];
    q.steering = [];
    if (steering.length > 0) emitQueue(tabId);
    for (const m of steering) {
      emitCommit('message_start', { message: { role: 'user', content: m, timestamp: now() } });
      emitCommit('message_end', { message: { role: 'user', content: m, timestamp: now() } });
    }
    const followUp = [...q.followUp];
    q.followUp = [];
    if (followUp.length > 0) emitQueue(tabId);
    for (const m of followUp) {
      emitCommit('message_start', { message: { role: 'user', content: m, timestamp: now() } });
      emitCommit('message_end', { message: { role: 'user', content: m, timestamp: now() } });
    }
    emitCommit('agent_end', { messages: [] });
    emitCommit('agent_settled');
  } finally {
    mockStreamingTabs.delete(tabId);
  }
}
function emitFrame(tabId: string, frame: unknown) {
  emit(`pi:frame:${tabId}`, frame);
}

/** mock 的 Fleet 运行（对应 Rust `FleetManager`）：跨命令共享，才能像真机一样被 steer/abort。 */
const mockFleet: {
  runs: Array<{
    id: string;
    templateId: string;
    task: string;
    cwd: string;
    status: string;
    lanes: Array<{ key: string; role: string; status: string; tabId: string; resultPreview?: string }>;
  }>;
} = { runs: [] };

const MOCK_LANES: Record<string, string[]> = {
  'scout-review-build': ['scout', 'review', 'build'],
  research: ['res-1', 'res-2', 'synth'],
  'parallel-review': ['r-correctness', 'r-tests', 'r-complexity'],
  custom: ['lane-1'],
};

/**
 * mock 的 piggy-bridge（B 层）：把扩展命令的应答按真机形状回传。
 *
 * 真机路径是 `bridge → ctx.ui.setEditorText("PIGGY:1:"+json)` → pi 发
 * `extension_ui_request{method:'set_editor_text'}` → Piggy 的前端劫持。
 * 这里直接发同一个事件形状，所以前端那条解析/劫持逻辑在浏览器里也被真实走过一遍。
 */
function mockBridgeCommand(tabId: string, text: string): void {
  const payload = text.startsWith('/piggy:status') || text.startsWith('/piggy:fleet-refresh')
    ? {
        kind: 'status',
        ok: true,
        status: {
          text: 'In-memory subagent status: 2 active children.',
          fleet: { version: 1, totalActive: 2, omitted: 0, entries: [] },
        },
        lanes: [
          { agent: 'reviewer · correctness', status: 'running', elapsed: 4_200, tokens: 1_280 },
          { agent: 'builder', status: 'complete', elapsed: 9_800, tokens: 3_400, cost: 0.0123 },
        ],
      }
    : text.startsWith('/piggy:spawn')
      ? { kind: 'spawn', ok: true, agent: text.split(/\s+/)[1] ?? 'agent', runId: 'mock-async-run' }
      : { kind: 'bridge', ok: false, verb: text.slice(1), error: 'mock：该动词未在浏览器里模拟' };
  emit(`pi:ui-req:${tabId}`, {
    type: 'extension_ui_request',
    id: `mock-ui-${now()}`,
    method: 'set_editor_text',
    text: `PIGGY:1:${JSON.stringify(payload)}`,
  });
  emit(`pi:ui-req:${tabId}`, {
    type: 'extension_ui_request',
    id: `mock-ui-w-${now()}`,
    method: 'setWidget',
    widgetKey: 'piggy-fleet',
    widgetLines: ['fleet: mock 舰队状态行'],
  });
}

export const isMock = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

/** 性能场景钩子（05 §6.2 S1–S6，M2）：仅 mock 环境暴露，直接驱动真实渲染管线 */
if (typeof window !== 'undefined' && isMock) {
  (window as unknown as Record<string, unknown>).__piggyPerf = {
    /**
     * S1：灌 delta 帧 totalMs 毫秒（chunkMs 一帧，走真实 live 通道）。
     *
     * `tabId` 默认是 mock 的第一个 tab；门禁第 19 段要往**它自己刚建的**那个会话灌
     * （那段不能依赖前面几段留下的标签，`closeAllTabs` 之后 TAB 早就不在了）。
     */
    async streamFor(totalMs: number, chunkMs = 16, tabId = TAB): Promise<number> {
      const start = performance.now();
      emit(`pi:commit:${tabId}`, { type: 'agent_start' });
      /* 一轮 = `message_start` … 帧 … `message_end`（与真机 pi 的事件顺序一致）。
         少了 message_start，帧会被丢掉（流式那一行是它建出来的，见 stores/messages.ts）。 */
      emit(`pi:commit:${tabId}`, { type: 'message_start', message: { role: 'assistant', content: [] } });
      let i = 0;
      let text = '';
      while (performance.now() - start < totalMs) {
        // 被 `pi_abort` 打断（与 streamMixed 同一条纪律：mock 也要能停）
        if (abortedTabs.has(tabId)) break;
        const delta = '流式渲染性能压测流。';
        text += delta;
        emit(`pi:frame:${tabId}`, {
          text: [{ contentIndex: 0, delta }],
          usage: { totalTokens: 1000 + i },
        });
        i += 1;
        await new Promise((r) => setTimeout(r, chunkMs));
      }
      emit(`pi:commit:${tabId}`, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() },
      });
      emit(`pi:commit:${tabId}`, { type: 'agent_settled' });
      return i;
    },
    /**
     * S1b：思考 + 工具调用 + 正文三种块一起流（门禁第 21 段量"实时块里的思考/工具
     * 是不是和提交之后一样的窄行"）。工具参数按 JSON 增量发：先半截、再补全，
     * 好让"够完整才抽摘要"这条也被真的走到。
     */
    async streamMixed(totalMs: number, chunkMs = 16, tabId = TAB): Promise<void> {
      const start = performance.now();
      emit(`pi:commit:${tabId}`, { type: 'agent_start' });
      emit(`pi:commit:${tabId}`, { type: 'message_start', message: { role: 'assistant', content: [] } });
      emit(`pi:frame:${tabId}`, { signals: [{ type: 'thinking_start', contentIndex: 0 }] });
      emit(`pi:frame:${tabId}`, { thinking: [{ contentIndex: 0, delta: '先读一下 stores/messages.ts\n第二行思考' }] });
      emit(`pi:frame:${tabId}`, { signals: [{ type: 'toolcall_start', contentIndex: 1, id: 'live-edit', toolName: 'edit' }] });
      /* 参数按 **pi 的真实 schema** 发（`{path, edits:[{oldText,newText}]}`）：
         门禁第 21 段要核对"实时那一行的摘要取自调用参数"，键名写错就退化成结果首行。 */
      emit(`pi:frame:${tabId}`, { toolArgs: [{ contentIndex: 1, delta: '{"path":"src/stores/mes' }] });
      emit(`pi:frame:${tabId}`, { toolArgs: [{ contentIndex: 1, delta: 'sages.ts","edits":[{"oldText":"a","newText":"b"}]}' }] });
      /* 正文从 markdown 开头流：门禁据此断言"流式途中标题/粗体已经成形"
         （部分渲染 markdown，`features/chat/markdown.tsx` 的增量解析）。 */
      const head = '## 流式标题\n\n这是 **加粗** 的正文：';
      emit(`pi:frame:${tabId}`, { text: [{ contentIndex: 2, delta: head }] });
      let i = 0;
      let text = head;
      while (performance.now() - start < totalMs) {
        // 被 `pi_abort` 打断：真机上这一轮就此结束（后面不再有 message_end 的正文）
        if (abortedTabs.has(tabId)) break;
        const delta = '正文流。';
        text += delta;
        emit(`pi:frame:${tabId}`, { text: [{ contentIndex: 2, delta }], usage: { totalTokens: 1000 + i } });
        i += 1;
        await new Promise((r) => setTimeout(r, chunkMs));
      }
      /* 转正：与流式帧里那份参数一致（同一行，不重挂） */
      emit(`pi:commit:${tabId}`, {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先读一下 stores/messages.ts\n第二行思考' },
            {
              type: 'toolCall',
              id: 'live-edit',
              name: 'edit',
              arguments: { path: 'src/stores/messages.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
            { type: 'text', text },
          ],
          timestamp: Date.now(),
        },
      });
      emit(`pi:commit:${tabId}`, { type: 'agent_settled' });
    },
    /** S3：hydrate n 条消息，返回耗时 ms（对应"打开大会话"路径） */
    async hydrate(n: number): Promise<number> {
      const { useMessages } = await import('@/stores/messages');
      const msgs = Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `消息 #${i}：性能场景压测负载。${'x'.repeat(180)}` }],
        timestamp: 1_700_000_000_000 + i,
      }));
      const t0 = performance.now();
      useMessages.getState().hydrate(TAB, msgs as never[]);
      return performance.now() - t0;
    },
    /** S4：并发工具执行事件 N 组（start+end 成对） */
    async toolRuns(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        emit(`pi:commit:${TAB}`, { type: 'tool_execution_start', toolCallId: `t${i}`, toolName: 'read' });
      }
      for (let i = 0; i < n; i += 1) {
        emit(`pi:commit:${TAB}`, { type: 'tool_execution_end', toolCallId: `t${i}`, isError: false });
      }
    },
    /** S5：崩溃恢复（worker 崩溃 → resync 补齐） */
    /**
     * 只报"崩了"。
     *
     * 与 `crashRecover` 拆开是为了让门禁能在**中间那一刻**量东西：崩溃之后、resync 之前
     * 那一瞬间，这一轮必须已经落地（`streaming` 归假 + 一条「已中止」的行）。
     * 合成一个 helper 的话，resync 会把中断行按设计丢掉，断言窗口只有 100ms。
     */
    mockCrash(tabId = TAB): void {
      emit(`pi:state:${tabId}`, { state: 'crashed' });
    },
    /**
     * 模拟一次**提问卡**（docs/06 §7）：走真实的 `pi:ui-req` 通道发那个"信封 select"。
     *
     * 门禁与单测要的是"和 pi-ask 插件发出的东西一模一样"：标题前缀 + 单一提交选项，
     * 问题本体在**工具调用参数**里（所以调用方要自己把工具行灌进转录）。
     *
     * @param tabId - 目标标签页
     * @param toolCallId - 提问工具调用的 id（宿主按它对上号）
     * @param title - 覆盖标题（用来核对"不是信封就不该被认领"）
     * @returns 宿主侧的请求 id（回答时要用它）
     */
    mockAskUserQuestion(tabId: string, toolCallId: string, title?: string): string {
      const id = `mock-ask-${now()}`;
      emit(`pi:ui-req:${tabId}`, {
        type: 'extension_ui_request',
        id,
        method: 'select',
        title: title ?? `piggy:ask:v1:${toolCallId}`,
        options: ['提交'],
      });
      return id;
    },
    /** worker 醒来：按会话文件补齐上下文（`piggy:resync`）并把状态改回 ready。 */
    mockRevive(tabId = TAB): void {
      emit(`pi:commit:${tabId}`, {
        type: 'piggy:resync',
        entries: [
          { type: 'message', id: 'r1', message: { role: 'user', content: '崩溃前消息', timestamp: 1_700_000_000_001 } },
        ],
        leafId: 'r1',
      });
      emit(`pi:state:${tabId}`, { state: 'ready', revived: true });
    },
    async crashRecover(): Promise<void> {
      emit(`pi:state:${TAB}`, { state: 'crashed' });
      await new Promise((r) => setTimeout(r, 100));
      emit(`pi:commit:${TAB}`, {
        type: 'piggy:resync',
        entries: [
          { type: 'message', id: 'r1', message: { role: 'user', content: '崩溃前消息', timestamp: 1_700_000_000_001 } },
        ],
        leafId: 'r1',
      });
      emit(`pi:state:${TAB}`, { state: 'ready', revived: true });
    },
  };
}

export async function mockInvoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 30)); // 模拟 IPC 延迟
  // 提供商配置的调用记录（门禁用）。统一在入口记，将来加命令不会漏。
  if (name.startsWith('provider_')) providerOps.push({ name, args: { ...(args ?? {}) } });
  if (name.startsWith('plugin_')) pluginOps.push({ name, args: { ...(args ?? {}) } });
  if (name.startsWith('session_title')) sessionTitleOps.push({ name, args: { ...(args ?? {}) } });
  if (name === 'pi_prompt' || name === 'pi_steer') {
    void mockPrompt(args ?? {});
    return true as T;
  }
  // tab 存在性检查（与真机 worker_of 一致）。`tab_close` 故意不查：
  // Rust 的 close_tab 对不存在的 tab 返回 Ok（幂等），前端也在关闭回调里无脑调用它。
  if (TAB_SCOPED.has(name)) {
    const id = String(args?.tabId ?? args?.tab_id ?? '');
    if (id && !liveTabs.has(id)) throw new Error(`tab 不存在: ${id}`);
  }
  const required = REQUIRED_ARGS[name];
  if (required) {
    const missing = required.filter((k) => args?.[k] === undefined);
    if (missing.length > 0) {
      // 文案照 Tauri 的来，方便和真机报错对上
      throw new Error(
        `invalid args \`${missing[0]}\` for command \`${name}\`: command ${name} missing required key ${missing[0]}`,
      );
    }
  }
  const h = handlers[name];
  if (!h) {
    /* ⚠️ 静默返回 `{}` 是**危险**的：浏览器门禁跑在 mock 上，真机路径一旦调到一个
       没实现（或拼错）的命令，界面上只会"什么都没发生"，而门禁全绿 ——
       docs/14 §6 记过这一类"mock 比真机宽松"的结构性风险。
       现在：① 明确 warn（门禁会把它收集起来）；② `ipc-mock-coverage.test.ts`
       静态对账"前端调用的每个命令都有 handler 或落在显式白名单里"。
       返回值仍是 `{}`：有些命令（`webview_log`、`pty_*`）的调用方不读返回值，
       真机上它们也确实成功 —— 抛异常会让无关的界面段整段挂掉。 */
    console.warn(`[mock-ipc] 没有实现：${name}`, args);
    return {} as T;
  }
  return h(args ?? {}) as T;
}

export function mockOn(channel: string, handler: Handler): UnlistenFn {
  if (!bus.has(channel)) bus.set(channel, new Set());
  bus.get(channel)!.add(handler);
  return () => {
    bus.get(channel)?.delete(handler);
  };
}
