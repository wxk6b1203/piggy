/**
 * todo store（`stores/todo.ts`）：能力探测 + 三条来路的清单状态。
 *
 * 这份 store 的职责边界最容易搞错，所以逐条钉：
 *   ① **能力**：探测失败 / 没装插件 → `supported=false`，绝不"猜着支持"；
 *   ② **铺底**（`seed`）：打开会话时后端给的整文件投影说了算（清单可能远在已载入的一页之前）；
 *   ③ **增量**（`noteCommit`）：新写入替换、用户发言清空 —— 与 DSH 的 `turn/start` 同规则；
 *   ④ **IPC 形状坏掉不许白屏**（docs/15 规矩 28）：字段缺失一律给安全默认值。
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { loadTodosForSession, useTodo } from '@/stores/todo';
import { loadTodoCapability } from '@/lib/todo';
import type { TodoItem } from '@/lib/todoModel';

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

/** 一个"探测到且已启用"的能力响应（字段名与 Rust 侧一致）。 */
function capabilityPayload(over: Record<string, unknown> = {}) {
  return {
    capability: 'todo',
    label: '任务清单',
    markers: ['todo_write'],
    detected: true,
    supported: true,
    considered: 6,
    problems: [],
    disabled: [],
    plugin: {
      name: 'pi-todo',
      key: 'global:discovered:/h/.pi/agent/extensions/pi-todo',
      kind: 'discovered',
      scope: 'global',
      scopeLabel: '全局',
      source: '/h/.pi/agent/extensions/pi-todo',
      path: '/h/.pi/agent/extensions/pi-todo',
      version: '0.1.0',
      entries: ['/h/.pi/agent/extensions/pi-todo/index.ts'],
      enabled: true,
      enabledBy: '默认加载（没有任何规则排除它）',
      evidence: 'package.json 声明 pi.piggy.capabilities 含 "todo"',
      probes: [],
    },
    ...over,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  useTodo.setState({ capability: null, capabilityError: null, capabilityLoading: false, probedProjects: {}, tabs: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('能力探测', () => {
  it('探测到且已启用 → supported=true，并记下提供者与凭据', async () => {
    invokeMock.mockResolvedValue(capabilityPayload());
    await useTodo.getState().loadCapability();
    const cap = useTodo.getState().capability!;
    expect(cap.supported).toBe(true);
    expect(cap.plugin?.name).toBe('pi-todo');
    expect(cap.plugin?.evidence).toContain('capabilities');
    expect(invokeMock).toHaveBeenCalledWith('plugin_capability', { capability: 'todo', projectDir: null });
  });

  it('装了但被停用 → supported=false（界面不出现），但 detected 与停用项都留着', async () => {
    const disabled = { ...capabilityPayload().plugin, enabled: false, enabledBy: '-extensions/pi-todo' };
    invokeMock.mockResolvedValue(capabilityPayload({ supported: false, plugin: null, disabled: [disabled] }));
    await useTodo.getState().loadCapability();
    const cap = useTodo.getState().capability!;
    expect(cap.supported).toBe(false);
    expect(cap.detected).toBe(true);
    expect(cap.disabled[0]?.enabledBy).toBe('-extensions/pi-todo');
  });

  it('探测抛错 → capability=null + capabilityError（不静默、也不假装支持）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error('未知能力 todo'));
    await useTodo.getState().loadCapability();
    expect(useTodo.getState().capability).toBeNull();
    expect(useTodo.getState().capabilityError).toContain('未知能力');
    expect(warn).toHaveBeenCalled();
  });

  it('探测有 problems 时打到控制台（截断/读不到都不许悄悄吞掉）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockResolvedValue(capabilityPayload({ problems: ['/h/x/dist/index.js 超过 512 KiB，只探测了前一段'] }));
    await useTodo.getState().loadCapability();
    expect(warn).toHaveBeenCalled();
    expect(useTodo.getState().capability?.problems).toHaveLength(1);
  });

  it('IPC 形状坏掉（字段全缺）→ 归一化成"不支持"，不白屏', async () => {
    invokeMock.mockResolvedValue({});
    const cap = await loadTodoCapability();
    expect(cap.supported).toBe(false);
    expect(cap.plugin).toBeNull();
    expect(cap.disabled).toEqual([]);
    expect(cap.problems).toEqual([]);
    expect(cap.markers).toEqual([]);
  });
});

describe('铺底与增量', () => {
  it('seed：后端的投影说了算（含清空标记与写入次数）', () => {
    useTodo.getState().seed('t1', {
      todos: [t('一', 'in_progress'), t('二', 'pending')],
      source: 'event',
      offset: 4096,
      clearedByTurn: false,
      writes: 3,
      branchy: false,
      chainBroken: false,
      scannedBytes: 100,
      parsedLines: 2,
    });
    const tab = useTodo.getState().tabs['t1']!;
    expect(tab.todos).toHaveLength(2);
    expect(tab.source).toBe('event');
    expect(tab.writes).toBe(3);
  });

  it('noteCommit：新的 todo_write 替换清单，并把旧的留作差异基线', () => {
    useTodo.getState().seed('t1', {
      todos: [t('一', 'pending'), t('二', 'pending')],
      source: 'event',
      offset: null,
      clearedByTurn: false,
      writes: 1,
      branchy: false,
      chainBroken: false,
      scannedBytes: 0,
      parsedLines: 0,
    });
    useTodo.getState().noteCommit('t1', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'c2',
            name: 'todo_write',
            arguments: { todos: [t('一', 'completed'), t('二', 'in_progress')] },
          },
        ],
      },
    });
    const tab = useTodo.getState().tabs['t1']!;
    expect(tab.todos?.[0]?.status).toBe('completed');
    expect(tab.previous?.[0]?.status).toBe('pending');
    expect(tab.source).toBe('live');
    expect(tab.writes).toBe(2);
  });

  it('noteCommit：用户发言 = 新一轮，计划清空但留下痕迹', () => {
    useTodo.getState().seed('t1', {
      todos: [t('一', 'completed')],
      source: 'event',
      offset: null,
      clearedByTurn: false,
      writes: 1,
      branchy: false,
      chainBroken: false,
      scannedBytes: 0,
      parsedLines: 0,
    });
    useTodo.getState().noteCommit('t1', { type: 'message_end', message: { role: 'user', content: [] } });
    const tab = useTodo.getState().tabs['t1']!;
    expect(tab.todos).toBeNull();
    expect(tab.clearedByTurn).toBe(true);
    expect(tab.previous?.[0]?.content).toBe('一');
    expect(tab.writes).toBe(1);
  });

  it('noteCommit：非 todo 的助手消息与别的工具不动清单', () => {
    useTodo.getState().seed('t1', {
      todos: [t('一', 'pending')],
      source: 'event',
      offset: null,
      clearedByTurn: false,
      writes: 1,
      branchy: false,
      chainBroken: false,
      scannedBytes: 0,
      parsedLines: 0,
    });
    useTodo.getState().noteCommit('t1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'bash', arguments: { command: 'ls' } }] },
    });
    expect(useTodo.getState().tabs['t1']!.todos).toHaveLength(1);
    expect(useTodo.getState().tabs['t1']!.writes).toBe(1);
  });

  it('piggy:resync 走同一套折叠（重连后不会把清单弄丢或弄反）', () => {
    useTodo.getState().noteCommit('t1', {
      type: 'piggy:resync',
      entries: [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c1', name: 'todo_write', arguments: { todos: [t('一', 'pending'), t('二', 'pending')] } }],
          },
        },
        { type: 'message', message: { role: 'user', content: [] } },
      ],
    });
    const tab = useTodo.getState().tabs['t1']!;
    expect(tab.todos).toBeNull();
    expect(tab.clearedByTurn).toBe(true);
  });
});

describe('打开会话时的装载（含项目级插件的按需补探）', () => {
  it('没有会话文件 → 什么都不做（连 IPC 都不发）', async () => {
    await loadTodosForSession('t1', null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('没探测到能力且没有项目目录 → 不扫描（省掉一次整文件扫描）', async () => {
    await loadTodosForSession('t1', '/h/s.jsonl', null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('全局没有但给了项目目录 → 补探一次；仍没有则不再重复探', async () => {
    invokeMock.mockResolvedValue(capabilityPayload({ supported: false, plugin: null }));
    await loadTodosForSession('t1', '/h/s.jsonl', '/proj');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]![0]).toBe('plugin_capability');
    // 第二次同一个项目：不再探（probedProjects 记住）
    await loadTodosForSession('t1', '/h/s.jsonl', '/proj');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('能力可用 → 读投影并铺底', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_capability') return Promise.resolve(capabilityPayload());
      if (cmd === 'session_todo') {
        return Promise.resolve({
          todos: [t('一', 'in_progress'), t('二', 'pending')],
          source: 'event',
          offset: 512,
          clearedByTurn: false,
          writes: 2,
          branchy: false,
          chainBroken: false,
          scannedBytes: 2048,
          parsedLines: 4,
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await useTodo.getState().loadCapability();
    await loadTodosForSession('t1', '/h/s.jsonl', '/proj');
    expect(invokeMock).toHaveBeenCalledWith('session_todo', { path: '/h/s.jsonl' });
    const tab = useTodo.getState().tabs['t1']!;
    expect(tab.todos).toHaveLength(2);
    expect(tab.source).toBe('event');
    expect(tab.writes).toBe(2);
  });

  it('投影读取失败 → 只记日志，不抛（少一个面板不该打断读会话）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_capability') return Promise.resolve(capabilityPayload());
      return Promise.reject(new Error('文件没了'));
    });
    await useTodo.getState().loadCapability();
    await expect(loadTodosForSession('t1', '/h/gone.jsonl')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(useTodo.getState().tabs['t1']?.todos ?? null).toBeNull();
  });

  it('投影里 todos 形状坏掉 → 当作"没有计划"，不编造空清单', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_capability') return Promise.resolve(capabilityPayload());
      return Promise.resolve({ todos: [{ content: '一', status: 'done' }], writes: 1 });
    });
    await useTodo.getState().loadCapability();
    await loadTodosForSession('t1', '/h/s.jsonl');
    expect(useTodo.getState().tabs['t1']!.todos).toBeNull();
  });
});
