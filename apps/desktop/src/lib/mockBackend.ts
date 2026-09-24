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

function snapshot() {
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

const messages = [
  { role: 'user', content: '帮我看看这个项目的流式渲染管线', timestamp: now() - 60_000 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '用户想验证 mock 管线。' },
      { type: 'text', text: '这是一条 mock 助手消息：**流式渲染**分两层——协议合帧（Rust）与渲染分帧（前端瞬态直写）。' },
      { type: 'toolCall', name: 'edit', arguments: { path: 'src/lib/live.ts', oldText: 'a', newText: 'b' } },
      { type: 'toolCall', name: 'write', arguments: { path: 'src/features/chat/Transcript.tsx', content: '…' } },
      { type: 'toolCall', name: 'edit', arguments: { path: 'src/styles.css', oldText: 'a', newText: 'b' } },
    ],
    timestamp: now() - 59_000,
  },
  {
    role: 'toolResult',
    toolCallId: 'call_mock_1',
    toolName: 'read',
    content: [{ type: 'text', text: 'export function liveFor(tabId: string): LiveEngine { ... }' }],
    isError: false,
    timestamp: now() - 58_000,
  },
];

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
  perf_config_load: () => ({ ...appCfg }),
  perf_config_save: (a) => {
    appCfg.max_workers = Number(a.maxWorkers ?? appCfg.max_workers);
    appCfg.idle_timeout_min = Number(a.idleTimeoutMin ?? appCfg.idle_timeout_min);
    if (a.piSource) appCfg.pi_source = String(a.piSource);
    if (a.piPath !== undefined) appCfg.pi_path = a.piPath === null ? null : String(a.piPath);
    // 不传 = 保持既有值（与真机 perf_config_save 的读-改-写语义一致）
    if (a.subagentDelegation !== undefined) {
      appCfg.subagent_delegation = Boolean(a.subagentDelegation);
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
    if (a?.sessionPath ?? a?.session_path) {
      s.session_file = String(a.sessionPath ?? a.session_path);
      s.session_name = '恢复的会话';
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
  pi_get_session_stats: () => ({
    tokens: { input: 12_000, output: 3_400, total: 15_400, cacheRead: 9_000 },
    cost: 0.0321,
    contextUsage: { tokens: 15_400, contextWindow: 1_000_000, percent: 2 },
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
  session_list: () => [
    // streaming-fix：创建最早（180 分钟前）但刚被写过（2 分钟前）
    // layout-wp1  ：创建更晚（40 分钟前）、写入也早
    // 按 mtime 排会把 streaming-fix 顶到最前；按创建时间排应该是 layout-wp1 在前。
    sessionMeta('/Users/mock/proj', 'streaming-fix', 2, '帮我看看这个项目的流式渲染管线', 180),
    sessionMeta('/Users/mock/proj', 'layout-wp1', 40, '工作区布局 v1 落地', 40),
    sessionMeta('/Users/mock/testpilot', 'nightly-audit', 3_000, '审核夜间构建', 5_000),
  ],
  session_delete: () => {},
  session_rename: () => {},
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
  session_dir_effective: () => ({ dir: '/Users/mock/.pi/agent/sessions', isCustom: false, raw: null }),
  auth_list: () => ({
    providers: [
      { provider: 'mock-anthropic', kind: 'api_key', masked: 'sk-ant…Xk2f' },
      { provider: 'mock-glm', kind: 'api_key', masked: 'gl-8888…ZZZZ' },
    ],
  }),
  auth_set_key: () => null,
  auth_remove: () => null,
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
      { type: 'compaction', id: 'e5', timestamp: new Date(now() - 46_000).toISOString() },
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

/** prompt：脚本化流式演示（合帧后的帧节奏，docs/04 §4.1 同构） */
async function mockPrompt(args: Record<string, unknown>) {
  // 前端 cmd() 直传 camelCase（Tauri 侧才做 snake_case 映射）
  const tabId = String(args.tabId ?? args.tab_id ?? TAB);
  const text = String(args.message ?? '');
  // 扩展命令：真实 pi 里 `/piggy:*` 由扩展即时执行、**不经过模型**（docs/06 §4.2），
  // mock 照抄这个语义——否则浏览器里点"刷新子代理"会得到一段假回复，掩盖链路问题。
  if (text.startsWith('/piggy:')) {
    mockBridgeCommand(tabId, text);
    return;
  }
  const emitCommit = (type: string, extra: Record<string, unknown> = {}): void =>
    emit(`pi:commit:${tabId}`, { type, ...extra });
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
  emitCommit('agent_end', { messages: [] });
  emitCommit('agent_settled');
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
    /** S1：向活动 tab 灌 delta 帧 totalMs 毫秒（16ms 一帧，走真实 live 通道） */
    async streamFor(totalMs: number, chunkMs = 16): Promise<number> {
      const start = performance.now();
      emit(`pi:commit:${TAB}`, { type: 'agent_start' });
      let i = 0;
      while (performance.now() - start < totalMs) {
        emit(`pi:frame:${TAB}`, {
          text: [{ contentIndex: 0, delta: '流式渲染性能压测流。' }],
          usage: { totalTokens: 1000 + i },
        });
        i += 1;
        await new Promise((r) => setTimeout(r, chunkMs));
      }
      emit(`pi:commit:${TAB}`, { type: 'agent_settled' });
      return i;
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
  const h = handlers[name];
  if (!h) {
    console.debug('[mock-ipc] unhandled:', name, args);
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
