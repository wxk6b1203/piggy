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
};

function snapshot() {
  return {
    tab_id: TAB,
    cwd: '/Users/mock/proj',
    session_id: state.sessionId,
    session_file: state.sessionFile,
    session_name: state.sessionName,
    worker_state: 'ready',
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
  pi_discover: () => ({ path: '/mock/pi', version: '0.87.0' }),
  tab_create: (a) => {
    const s = snapshot();
    if (a?.session_path) {
      s.session_file = String(a.session_path);
      s.session_name = '恢复的会话';
    }
    return s;
  },
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
    state.model = { id: String(a.model_id), name: String(a.model_id), provider: String(a.provider) };
    return state.model;
  },
  pi_get_available_thinking_levels: () => ({ levels: ['off', 'medium', 'high'] }),
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
  fs_preview_read: (a) => ({
    path: String(a.path),
    size: 1024,
    lines: 20,
    content: '// mock 预览内容\nexport const ok = true;\n',
  }),
  pi_stderr_tail: () => [],
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
  pi_get_entries: () => ({
    entries: [
      { type: 'message', id: 'e1', timestamp: new Date(now() - 50_000).toISOString(), message: { role: 'user', content: '验证轨迹视图' } },
      { type: 'message', id: 'e2', timestamp: new Date(now() - 49_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '轨迹视图工作中' }] } },
      { type: 'session_info', id: 'e3', timestamp: new Date(now() - 48_000).toISOString(), name: '轨迹演示' },
      { type: 'context_edit', id: 'e4', timestamp: new Date(now() - 47_000).toISOString(), targetId: 'e1', replacement: null },
      { type: 'compaction', id: 'e5', timestamp: new Date(now() - 46_000).toISOString() },
    ],
    leafId: 'e5',
  }),
  pi_compact: () => ({ summary: 'mock 压缩摘要' }),
  pi_bash: () => ({ output: 'mock-bash-output', exitCode: 0, cancelled: false, truncated: false }),
  pi_abort_bash: () => null,
};

/** prompt：脚本化流式演示（合帧后的帧节奏，docs/04 §4.1 同构） */
async function mockPrompt(args: Record<string, unknown>) {
  const tabId = String(args.tab_id ?? TAB);
  const text = String(args.message ?? '');
  const emit = (type: string, extra: Record<string, unknown> = {}): void =>
    void emit(`pi:commit:${tabId}`, { type, ...extra });
  emit('agent_start');
  emit('message_start', { message: { role: 'user', content: text, timestamp: now() } });
  emit('message_end', { message: { role: 'user', content: text, timestamp: now() } });
  emit('turn_start');
  emit('message_start', { message: { role: 'assistant', content: [] } });
  const reply = `这是 **mock 流式回复**：你发送了「${text.slice(0, 40)}」。合帧器把它切成 60Hz 帧逐段上屏。`;
  const chunk = Math.ceil(reply.length / 12);
  for (let i = 0; i < reply.length; i += chunk) {
    emit(`pi:frame:${tabId}` as never, undefined as never); // 占位（frame 走专门通道，见下）
    emitFrame(tabId, { text: [{ contentIndex: 0, delta: reply.slice(i, i + chunk) }], usage: { totalTokens: 500 + i * 10 } });
    await new Promise((r) => setTimeout(r, 70));
  }
  emit('message_end', {
    message: { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: now() },
  });
  emit('turn_end', { message: {} });
  emit('agent_end', { messages: [] });
  emit('agent_settled');
}
function emitFrame(tabId: string, frame: unknown) {
  emit(`pi:frame:${tabId}`, frame);
}

export const isMock = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

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
