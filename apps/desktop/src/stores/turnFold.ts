/**
 * 回合折叠的**手动开合记忆**（DSH `ChatGroupSeat`，docs/04 §2.1.6）。
 *
 * 为什么不能放在组件里：转录是虚拟化的，行滚出窗口就被卸载 —— 折叠一行、往上滚再回来，
 * 组件内的 `useState` 早就没了（与 `lib/rowMemory` 记的那类问题同源）。
 *
 * 键取**会话文件里的字节偏移**（`MessageView.offset`）而不是行 id：行 id 是每次载入
 * 现生成的（`role-时间戳-序号`），刷新一次就变；而偏移来自文件、重开同一个会话也不变。
 * 分页读来的行都有偏移；实时追加的行没有（那时也用不到"跨载入记忆"）。
 * 偏移也拿不到时退回行 id —— 至少同一次载入内是对的。
 */
import { create } from 'zustand';
import type { TranscriptDetail } from './appConfig';

export interface TurnFoldState {
  /** tabId → 回合键 → 手动开合（true = 展开） */
  open: Record<string, Record<string, boolean>>;
  /** 读一次折叠状态：有手动记录用它，否则按档位的默认值 */
  isOpen(tabId: string, turnKey: string, mode: TranscriptDetail): boolean;
  toggle(tabId: string, turnKey: string, mode: TranscriptDetail): void;
  /** 关标签时清掉这个 tab 的记忆（与 `disposeTabListeners` 同一时机调用） */
  forget(tabId: string): void;
}

/** 档位的默认开合：`detailed`/`verbose` 默认摊开，`compact`/`standard` 默认折起。 */
export function defaultOpen(mode: TranscriptDetail): boolean {
  return mode === 'detailed' || mode === 'verbose';
}

export const useTurnFold = create<TurnFoldState>()((set, get) => ({
  open: {},

  isOpen(tabId, turnKey, mode) {
    const manual = get().open[tabId]?.[turnKey];
    // 档位变化不改成员、也不清手动选择（DSH 同一条纪律）：手动开过的保持手动
    return manual ?? defaultOpen(mode);
  },

  toggle(tabId, turnKey, mode) {
    /* ⚠️ 必须**换引用**（浅拷贝两层），不能就地改：
       zustand 的 `set` 见到"新状态 === 旧状态"就不通知订阅者，而选择器
       `s.open[tabId]` 也会因为 `Object.is` 相等而跳过渲染 —— 表现是"点了没反应"
       （这条正是本仓最忌讳的静默失效，实测踩过一次）。 */
    set((s) => {
      const forTab = { ...(s.open[tabId] ?? {}) };
      forTab[turnKey] = !(forTab[turnKey] ?? defaultOpen(mode));
      return { open: { ...s.open, [tabId]: forTab } };
    });
  },

  forget(tabId) {
    set((s) => {
      const next = { ...s.open };
      delete next[tabId];
      return { open: next };
    });
  },
}));
