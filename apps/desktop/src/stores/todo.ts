/**
 * todo store（docs/03 §2.20）：**能力状态**（全机器一份）+ **每个 tab 的当前计划**。
 *
 * ## 数据从哪来（三条来路，职责分明）
 *
 * | 来路 | 时机 | 作用 |
 * |---|---|---|
 * | `loadCapability()` | 应用启动 / 切项目 | 有没有已启用的 todo 插件（`supported`） |
 * | `seed()` | 打开会话（读到 session 文件） | 整文件投影：清单可能写在很久以前那一轮 |
 * | `noteCommit()` | 实时 `pi:commit` | 增量：新写入 / 新一轮开始 |
 *
 * 为什么不能只靠第三条：分页只载入尾部一页，`todo_write` 可能在上百轮之前 ——
 * 而 DSH 对清单的要求是"The list survives across turns and reopened sessions"
 * （`packages/todo/tool-todo/README.md:12`）。所以打开会话时后端扫一次全文件，
 * 之后前端只做增量。
 *
 * ## 清空规则（DSH `turn/start`）
 *
 * 用户发新消息 = 新一轮开始 → 计划面板清空（DSH `src/index.ts:140`：`turn/start` → `null`）。
 * 这不是"删掉记录"：`clearedByTurn` 与 `writes` 都留着，界面能说清"上一轮有过一份清单"。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useStore } from 'zustand';
import type { AgentMessage } from '@piggy/pi-protocol';
import { loadTodoCapability, loadSessionTodo, type TodoCapability, type TodoProjection } from '@/lib/todo';
import { isTurnStart, todosFromMessage, type TodoItem } from '@/lib/todoModel';

/** 一个 tab 的清单状态。 */
export interface TabTodo {
  /** 当前计划（`null` = 没有 / 已被新一轮清空） */
  todos: TodoItem[] | null;
  /** 上一次写入的清单（差异对比用） */
  previous: TodoItem[] | null;
  /** 这条结论从哪来 */
  source: 'event' | 'call' | 'live' | null;
  /** 写入之后又开始了新的一轮 */
  clearedByTurn: boolean;
  /** 本会话见过几次整表写入 */
  writes: number;
  /** 链条走断（结论按文件序得出，强度较低） */
  chainBroken: boolean;
}

const emptyTab = (): TabTodo => ({
  todos: null,
  previous: null,
  source: null,
  clearedByTurn: false,
  writes: 0,
  chainBroken: false,
});

interface TodoState {
  /** 能力状态（机器级；`null` = 还没探测） */
  capability: TodoCapability | null;
  /** 探测失败的原因（界面据此**不显示** todo 界面，并留证据） */
  capabilityError: string | null;
  capabilityLoading: boolean;
  /** 已经用项目目录探过的项目（同一个项目只补探一次，避免每次开会话都 IPC） */
  probedProjects: Record<string, boolean>;
  tabs: Record<string, TabTodo>;

  /** 探测 todo 能力（应用启动 / 切项目时调） */
  loadCapability(projectDir?: string | null): Promise<void>;
  /** 用后端的整文件投影铺底（打开会话时调） */
  seed(tabId: string, projection: TodoProjection): void;
  /** 实时提交：维护清单（新一轮清空 / 新写入替换） */
  noteCommit(tabId: string, ev: { type: string } & Record<string, unknown>): void;
  /** 探测失败时把原因记下来（不静默） */
  setCapabilityError(message: string | null): void;
  /** 记下"这个项目已经补探过" */
  markProjectProbed(projectDir: string): void;
  drop(tabId: string): void;
}

/** 把一条消息折进 tab（`message_end` 与 `piggy:resync` 共用，避免两条路径分叉）。 */
function foldMessage(tab: TabTodo, message: AgentMessage | undefined): void {
  if (!message) return;
  if (isTurnStart(message)) {
    if (tab.todos !== null) {
      tab.previous = tab.todos;
      tab.todos = null;
      tab.clearedByTurn = true;
    }
    return;
  }
  const list = todosFromMessage(message);
  if (list === null) return;
  if (tab.todos !== null) tab.previous = tab.todos;
  tab.todos = list;
  tab.source = 'live';
  tab.clearedByTurn = false;
  tab.writes += 1;
}

export const useTodo = create<TodoState>()(
  immer((set) => ({
    capability: null,
    capabilityError: null,
    capabilityLoading: false,
    probedProjects: {},
    tabs: {},

    async loadCapability(projectDir) {
      set((s) => {
        s.capabilityLoading = true;
      });
      try {
        const capability = await loadTodoCapability(projectDir);
        set((s) => {
          s.capability = capability;
          s.capabilityError = null;
          s.capabilityLoading = false;
        });
        // 探测过程中的问题必须留痕：截断/读不到都可能让"未命中"不是定论
        if (capability.problems.length > 0) {
          console.warn('[piggy] todo 能力探测有问题：', capability.problems);
        }
      } catch (e) {
        set((s) => {
          s.capability = null;
          s.capabilityError = e instanceof Error ? e.message : String(e);
          s.capabilityLoading = false;
        });
        console.warn('[piggy] todo 能力探测失败（界面将不显示 todo）：', e);
      }
    },

    seed(tabId, projection) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.todos = projection.todos;
        tab.previous = null;
        tab.source = projection.source;
        tab.clearedByTurn = projection.clearedByTurn;
        tab.writes = projection.writes;
        tab.chainBroken = projection.chainBroken;
      });
    },

    noteCommit(tabId, ev) {
      const type = ev.type;
      if (type === 'message_end') {
        const message = (ev as { message?: AgentMessage }).message;
        set((s) => {
          const tab = (s.tabs[tabId] ??= emptyTab());
          foldMessage(tab, message);
        });
        return;
      }
      if (type === 'piggy:resync') {
        const entries =
          (ev as { entries?: Array<{ type: string; message?: AgentMessage }> }).entries ?? [];
        set((s) => {
          const tab = (s.tabs[tabId] ??= emptyTab());
          for (const entry of entries) {
            if (entry.type !== 'message') continue;
            foldMessage(tab, entry.message);
          }
        });
      }
    },

    setCapabilityError(message) {
      set((s) => {
        s.capabilityError = message;
      });
    },

    markProjectProbed(projectDir) {
      set((s) => {
        s.probedProjects[projectDir] = true;
      });
    },

    drop(tabId) {
      set((s) => {
        delete s.tabs[tabId];
      });
    },
  })),
);

const EMPTY_TAB = emptyTab();
Object.freeze(EMPTY_TAB);

/** per-tab 选择器（空态用同一个冻结对象，避免重渲染风暴）。 */
export function useTabTodo<T>(tabId: string | null, sel: (t: TabTodo) => T): T {
  return useStore(useTodo, (s) => sel((tabId ? s.tabs[tabId] : null) ?? EMPTY_TAB));
}

/** todo 界面该不该出现：探测到**且已启用**（探测失败 / 没装 → 一律不显示）。 */
export function useTodoSupported(): boolean {
  return useStore(useTodo, (s) => s.capability?.supported === true);
}

/**
 * 打开会话时装载清单投影。
 *
 * 失败**只记日志不弹错**：todo 面板少一个不影响读会话，弹一个红条反而更吵。
 * 但证据要留全（哪条命令、什么错）。
 *
 * @param tabId - 标签 id
 * @param sessionFile - 会话文件路径（没有 = 还没落盘，直接跳过）
 */
export async function loadTodosForSession(
  tabId: string,
  sessionFile: string | null | undefined,
  projectDir?: string | null,
): Promise<void> {
  if (!sessionFile) return;
  if (!useTodo.getState().capability?.supported) {
    // 全局没有 → 可能是**项目级**插件（`<项目>/.pi/extensions/`）。按需补探一次，
    // 同一个项目只探一次（`probedProjects`），否则每次开会话都要多一次 IPC。
    if (!projectDir || useTodo.getState().probedProjects[projectDir]) return;
    useTodo.getState().markProjectProbed(projectDir);
    await useTodo.getState().loadCapability(projectDir);
    if (!useTodo.getState().capability?.supported) return;
  }
  try {
    const projection = await loadSessionTodo(sessionFile);
    useTodo.getState().seed(tabId, projection);
  } catch (e) {
    console.warn('[piggy] 会话任务清单读取失败（不显示 todo 面板）：', e);
  }
}
