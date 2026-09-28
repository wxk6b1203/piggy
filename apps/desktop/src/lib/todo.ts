/**
 * todo 功能的数据层（docs/03 §2.20）：**能力探测** + **会话清单投影**两条 IPC。
 *
 * Piggy 不实现 todo —— 它由 pi 扩展（本机是 `pi-todo`）提供。所以这里问后端两件事：
 *
 *   1. `plugin_capability('todo')` —— 这台机器上有没有一个**已启用**的插件提供 todo
 *      能力？（`supported` 为假 → 整个 todo 界面都不出现，与没这功能时一模一样）
 *   2. `session_todo(path)` —— 这个会话当前的任务清单是什么（整文件扫描 + 分支跟随）
 *
 * 形状归一化的理由与 `lib/plugins.ts` 相同（docs/15 规矩 28）：后端少一个字段就可能让
 * 整页白屏，所以进组件之前一律补默认值。
 */
import { cmd } from '@/lib/ipc';
import { parseTodoList, type TodoItem } from '@/lib/todoModel';

/** 一个提供能力的插件（后端 `plugin::capabilities` 的形状）。 */
export interface TodoCapabilityPlugin {
  name: string;
  key: string;
  kind: string;
  scope: string;
  scopeLabel: string;
  source: string;
  path: string;
  version: string | null;
  entries: string[];
  enabled: boolean;
  enabledBy: string | null;
  /** 凭什么认定它提供该能力：声明 / 内容探测 */
  evidence: string;
  /** 逐文件的探测明细 */
  probes: Array<{ entry: string; hit: boolean; truncated?: boolean; error?: string | null; skipped?: string }>;
}

/** 能力探测结果。 */
export interface TodoCapability {
  capability: string;
  label: string;
  markers: string[];
  /** 探测到（不管启停） */
  detected: boolean;
  /** 探测到**且已启用** —— 界面开不开就看这一个字段 */
  supported: boolean;
  plugin: TodoCapabilityPlugin | null;
  /** 探测到但被停用的插件（界面可以提示"装了没启用"） */
  disabled: TodoCapabilityPlugin[];
  /** 盘了多少个插件（排查用） */
  considered: number;
  /** 探测过程中的问题（读不到文件、超限截断……）——**不静默**，进控制台 */
  problems: string[];
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizePlugin(raw: unknown): TodoCapabilityPlugin | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null;
  return {
    name,
    key: asString(r.key),
    kind: asString(r.kind),
    scope: asString(r.scope),
    scopeLabel: asString(r.scopeLabel, asString(r.scope)),
    source: asString(r.source),
    path: asString(r.path),
    version: typeof r.version === 'string' ? r.version : null,
    entries: Array.isArray(r.entries) ? r.entries.filter((e): e is string => typeof e === 'string') : [],
    enabled: r.enabled === true,
    enabledBy: typeof r.enabledBy === 'string' ? r.enabledBy : null,
    evidence: asString(r.evidence),
    probes: Array.isArray(r.probes)
      ? r.probes
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({
            entry: asString(p.entry),
            hit: p.hit === true,
            truncated: p.truncated === true,
            error: typeof p.error === 'string' ? p.error : null,
            skipped: typeof p.skipped === 'string' ? p.skipped : undefined,
          }))
      : [],
  };
}

/**
 * 探测 todo 能力。
 *
 * @param projectDir - 当前项目目录（项目级插件也要盘；`null` = 只盘全局）
 * @returns 归一化后的能力状态（探测失败会抛出，由调用方决定怎么提示）
 */
export async function loadTodoCapability(projectDir?: string | null): Promise<TodoCapability> {
  const raw = await cmd<Record<string, unknown>>('plugin_capability', {
    capability: 'todo',
    projectDir: projectDir ?? null,
  });
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.map(normalizePlugin).filter((p): p is TodoCapabilityPlugin => p !== null)
    : [];
  return {
    capability: asString(raw.capability, 'todo'),
    label: asString(raw.label, '任务清单'),
    markers: Array.isArray(raw.markers) ? raw.markers.filter((m): m is string => typeof m === 'string') : [],
    detected: raw.detected === true,
    supported: raw.supported === true,
    plugin: normalizePlugin(raw.plugin),
    disabled,
    considered: typeof raw.considered === 'number' ? raw.considered : 0,
    problems: Array.isArray(raw.problems) ? raw.problems.filter((p): p is string => typeof p === 'string') : [],
  };
}

/** 会话清单投影（Rust `transcript::TodoProjection::to_json`）。 */
export interface TodoProjection {
  /** 当前计划（`null` = 没有 / 已被新一轮清空） */
  todos: TodoItem[] | null;
  /** 结论来自哪：`event`（插件的 todo/write 条目）/ `call`（工具调用参数） */
  source: 'event' | 'call' | null;
  /** 那次写入在会话文件里的字节偏移 */
  offset: number | null;
  /** 写入之后又开始了新的一轮（DSH 的 `turn/start` 清空规则） */
  clearedByTurn: boolean;
  /** 整段会话里见过几次整表写入 */
  writes: number;
  /** 文件有分支（活动分支比全部条目短） */
  branchy: boolean;
  /**
   * 链条走断 —— 这份结论是**按文件序**折出来的（退回行为），不是沿活动分支。
   * 界面据此把"来源"标得弱一点：结论没错，但强度低。
   */
  chainBroken: boolean;
  scannedBytes: number;
  parsedLines: number;
}

/**
 * 读会话的任务清单投影。
 *
 * @param sessionFile - 会话 JSONL 路径
 * @returns 投影（读不出来会抛出，由调用方决定是否只是少一个面板）
 */
export async function loadSessionTodo(sessionFile: string): Promise<TodoProjection> {
  const raw = await cmd<Record<string, unknown>>('session_todo', { path: sessionFile });
  // `todos: null` 与"形状坏了"必须分开：前者是"没有计划"，后者是"读到了但看不懂"。
  // 看不懂时给 null（少显示比显示错的强），但**不编造**一份空清单。
  const todos = raw.todos === null || raw.todos === undefined ? null : parseTodoList(raw.todos);
  return {
    todos,
    source: raw.source === 'event' || raw.source === 'call' ? raw.source : null,
    offset: typeof raw.offset === 'number' ? raw.offset : null,
    clearedByTurn: raw.clearedByTurn === true,
    writes: typeof raw.writes === 'number' ? raw.writes : 0,
    branchy: raw.branchy === true,
    chainBroken: raw.chainBroken === true,
    scannedBytes: typeof raw.scannedBytes === 'number' ? raw.scannedBytes : 0,
    parsedLines: typeof raw.parsedLines === 'number' ? raw.parsedLines : 0,
  };
}
