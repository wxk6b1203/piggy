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
} = {
  max_workers: 8,
  idle_timeout_min: 10,
  permission_mode: 'workspace',
  pi_source: 'system',
  pi_path: null,
};

let mockTabSeq = 0;

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

const sessionMeta = (cwd: string, name: string, mins: number, first: string) => ({
  path: `/Users/mock/.pi/agent/sessions/--${cwd.replace(/\//g, '-')}--/2026-09-22_${name}.jsonl`,
  file_name: `2026-09-22_${name}.jsonl`,
  session_id: `sid-${name}`,
  cwd,
  name: null,
  first_message: first,
  mtime_ms: now() - mins * 60_000,
  size: 12_345,
});

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  boot_reset: () => {},
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
    return null;
  },
  tab_sleep: () => null,
  tab_sleep_idlest: () => ({ tabId: 'mock-tab-1' }),
  tab_create: (a) => {
    const s = snapshot();
    if (a?.sessionPath ?? a?.session_path) {
      s.session_file = String(a.sessionPath ?? a.session_path);
      s.session_name = '恢复的会话';
    }
    if (a?.permission) s.permission = String(a.permission) as typeof s.permission;
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
  tab_close: () => {},
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
  pi_get_commands: () => ({
    commands: [
      { name: 'piggy:status', description: '舰队状态', source: 'extension' },
      { name: 'review-pr', description: '评审当前 PR', source: 'prompt' },
      { name: 'skill:brave-search', description: '联网搜索', source: 'skill' },
    ],
  }),
  session_list: () => [
    sessionMeta('/Users/mock/proj', 'streaming-fix', 2, '帮我看看这个项目的流式渲染管线'),
    sessionMeta('/Users/mock/proj', 'layout-wp1', 40, '工作区布局 v1 落地'),
    sessionMeta('/Users/mock/testpilot', 'nightly-audit', 3_000, '审核夜间构建'),
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
  /* M3 Fleet（mock 演示：启动 → 2s 后全部 settle，驱动面板） */
  fleet_templates: () => ({
    'parallel-review': { label: '并行评审' },
    'scout-review-build': { label: '侦察 → 评审 + 构建' },
    research: { label: '调研汇总' },
    custom: { label: '自定义' },
  }),
  fleet_list: () => ({ runs: [] }),
  fleet_start: (a) => {
    const runId = `mock-run-${Date.now()}`;
    const lanes = a.template_id === 'scout-review-build'
      ? ['scout', 'review', 'build']
      : a.template_id === 'research'
        ? ['res-1', 'res-2', 'synth']
        : ['r-correctness', 'r-tests', 'r-complexity'];
    const snapshot = {
      runs: [{
        id: runId,
        templateId: String(a.template_id),
        task: String(a.task),
        cwd: String(a.cwd),
        status: 'running',
        lanes: lanes.map((k) => ({ key: k, role: k, status: 'running', tabId: `mock-${runId}-${k}` })),
      }],
    };
    setTimeout(() => emit('fleet:changed', snapshot), 400);
    setTimeout(() => {
      emit('fleet:changed', {
        runs: [{
          ...snapshot.runs[0],
          status: 'done',
          lanes: lanes.map((k) => ({ key: k, role: k, status: 'settled', tabId: `mock-${runId}-${k}`, resultPreview: 'mock 结论：一切正常。' })),
        }],
      });
    }, 2500);
    return runId;
  },
  fleet_abort: () => null,
  fleet_steer: () => true,
  fleet_open_lane: (a) => ({
    tab_id: `mock-${a.runId}-${a.laneKey}`,
    cwd: '/Users/mock/proj',
    session_file: null,
    session_id: null,
    session_name: null,
    worker_state: 'ready',
    state: {},
  }),
  pi_abort_bash: () => null,
};

/** prompt：脚本化流式演示（合帧后的帧节奏，docs/04 §4.1 同构） */
async function mockPrompt(args: Record<string, unknown>) {
  // 前端 cmd() 直传 camelCase（Tauri 侧才做 snake_case 映射）
  const tabId = String(args.tabId ?? args.tab_id ?? TAB);
  const text = String(args.message ?? '');
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
