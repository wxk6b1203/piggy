/**
 * 行内展开态的**记忆**（docs/04 §2.1）。
 *
 * ## 为什么需要它
 *
 * 转录是虚拟化的：滚出窗口（视口 + overscan）的行会被**卸载**，行里的 `useState`
 * 跟着一起没了。于是用户报的这一幕成立——"思考/工具这种行，展开看完，往上滚一点
 * 再滚回底部，展开态就丢了，看不到过程"：展开的那一行只是离开了窗口，
 * 回来时已经是全新挂载的组件，默认又是折叠。
 *
 * 所以"用户手动开过没开过"必须活在行组件**外面**。这里就是那个外面：
 * 一个模块级 Map，键 = `tabId \0 行键 \0 插槽 \0 开关名`。
 *
 * ## 边界（都不是随手定的）
 *
 * · **只记布尔意图**（展开/折叠/显示更多），不记测量结果 —— 测量值随布局变，
 *   记住它只会在下次挂载时给出错误的几何（`CodeBlock.overflowing` 就是测量，不在此列）。
 * · **只写用户真的切过的键**：条目数 = 本次运行里手动展开过的行数，天生很小。
 *   仍然设 LRU 上限兜底（病态会话里翻页会不断产生新行键），并在标签关闭时按 tabId 清空。
 * · **不落盘**：这是视图状态。重启后行本身都是新键（`stores/messages.ts` 的
 *   `nextId` 带 `Date.now()`），记忆跟着一起归零才是对的。
 * · **没有 tabId/行键时退化为组件内 state**（轨迹视图等孤立渲染）：不记忆，也不报错。
 */
import { useCallback, useState } from 'react';

/** 一条行的身份（虚拟化键 + 插槽名拼成记忆键）。 */
export interface RowMemory {
  tabId: string;
  /** 行在 store 里的 id（`stores/messages.ts` 的 `nextId`）。 */
  rowKey: string;
}

/** 记忆条目上限（LRU：写入即移到队尾，超限从队首淘汰）。 */
export const ROW_MEMORY_MAX = 2000;

/** 组合键的分隔符：用 NUL 是因为行键与插槽名里都不会出现它。 */
const SEP = '\u0000';

const memory = new Map<string, boolean>();

/** 行内某个插槽的记忆键；没有行身份时返回 `null`（= 不记忆）。 */
export function slotKey(memoryOf: RowMemory | undefined, slot: string): string | null {
  if (!memoryOf) return null;
  return `${memoryOf.tabId}${SEP}${memoryOf.rowKey}${SEP}${slot}`;
}

/** 读一个开关（没记过 = `undefined`，与"记过 false"区分开）。 */
export function readRowFlag(key: string | null, flag: string): boolean | undefined {
  if (!key) return undefined;
  return memory.get(`${key}${SEP}${flag}`);
}

/**
 * 写入口（`useRowFlag` 的 setter 走它；单测直接用它造状态）。
 *
 * 语义是"记住这个人开过/关过"，所以只有**用户动作**该调它 —— 别拿它记测量结果。
 */
export function rememberRowFlag(key: string, flag: string, value: boolean): void {
  const k = `${key}${SEP}${flag}`;
  // 先删再写 = 把这一条挪到队尾（Map 的迭代顺序就是插入顺序，LRU 靠它）
  memory.delete(k);
  memory.set(k, value);
  if (memory.size > ROW_MEMORY_MAX) {
    const oldest = memory.keys().next();
    if (!oldest.done) memory.delete(oldest.value);
  }
}

/** 关闭标签时清掉它的记忆（与 `disposeLive` / `useMessages.remove` 同一处调用）。 */
export function forgetRowTab(tabId: string): void {
  const prefix = `${tabId}${SEP}`;
  for (const k of [...memory.keys()]) {
    if (k.startsWith(prefix)) memory.delete(k);
  }
}

/** 当前记忆条目数（单测与门禁用）。 */
export function rowMemorySize(): number {
  return memory.size;
}

/** 清空全部记忆（单测用；应用代码不要调）。 */
export function resetRowMemory(): void {
  memory.clear();
}

/**
 * 一个可记忆的布尔开关。
 *
 * 挂载时取记忆值（没记过才用 `initial`），切换时写回记忆 —— 于是"卸载再挂载"
 * 不再等于"回到初始值"。`stored` 告诉调用方**挂载那一刻**记忆里到底有没有值：
 * `CodeBlock` 的"长输出默认折叠"要靠它（用户展开过就不再自动折回去）。
 *
 * @param key - {@link slotKey} 的结果（`null` = 不记忆，退化为普通 `useState`）
 * @param flag - 同一插槽里的多个开关（`open` / `collapsed` / `showAll` …）
 * @param initial - 记忆里没有值时的初值
 * @returns `[值, 设置值, 挂载时是否已有记忆]`
 */
export function useRowFlag(
  key: string | null,
  flag: string,
  initial = false,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void, boolean] {
  const [stored] = useState(() => readRowFlag(key, flag));
  const [value, setValue] = useState(() => stored ?? initial);
  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        if (key) rememberRowFlag(key, flag, v);
        return v;
      });
    },
    [key, flag],
  );
  return [value, set, stored !== undefined];
}
