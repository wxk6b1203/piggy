/**
 * 扩展通知中心（`ctx.ui.notify` → 右栏「通知」视图）。
 *
 * 为什么不再用 antd `notification`：
 *  - 右下角 toast 会消失，`notify` 的历史就没了；调试/回看时只能翻控制台；
 *  - toast 是瞬时的，后台 tab 的通知很容易被错过；
 *  - antd 的静态 `notification` 不吃 `ConfigProvider` 主题（`feedback.ts` 里那套坑），
 *    而右栏面板天然跟着主题变量走。
 *
 * 语义：**打开通知视图 = 全部已读**（用户 2026-10-24 的口径："点开通知就算已读，
 * 不需要单独点里面的通知"）。未读只用于右栏图标轨上的小圆点，不进入每条通知的交互。
 */
import { create } from 'zustand';

export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export interface AppNotification {
  /** 全局唯一键（通常是 `<tabId>:<extension_ui_request.id>`） */
  id: string;
  /** 来源会话；空串 = 不属于任何 tab（例如启动期通知） */
  tabId: string;
  level: NotificationLevel;
  message: string;
  /** 毫秒时间戳 */
  ts: number;
  read: boolean;
}

export interface NotificationInput {
  id: string;
  tabId: string;
  level: NotificationLevel;
  message: string;
  ts?: number;
}

interface NotificationsState {
  /** 新的在前；上限 100 条，避免长期运行无限增长 */
  items: AppNotification[];
  push(input: NotificationInput): void;
  /** 打开通知视图时调用；没有未读时是 no-op（避免无意义的重渲染） */
  markAllRead(): void;
  clear(): void;
}

const MAX_ITEMS = 100;

export const useNotifications = create<NotificationsState>()((set, get) => ({
  items: [],

  push(input) {
    const message = input.message.trim();
    if (!message) return;
    const item: AppNotification = {
      id: input.id,
      tabId: input.tabId,
      level: input.level,
      message,
      ts: input.ts ?? Date.now(),
      read: false,
    };
    set((s) => ({
      // 同一个请求重复到达（重放/重连）时替换旧条目，而不是堆两条
      items: [item, ...s.items.filter((n) => n.id !== item.id)].slice(0, MAX_ITEMS),
    }));
  },

  markAllRead() {
    if (!get().items.some((n) => !n.read)) return;
    set((s) => ({ items: s.items.map((n) => (n.read ? n : { ...n, read: true })) }));
  },

  clear() {
    set({ items: [] });
  },
}));

/** 未读数（右栏小圆点用；返回 number，避免 selector 每次造新数组）。 */
export function unreadCount(items: readonly AppNotification[]): number {
  return items.reduce((n, item) => (item.read ? n : n + 1), 0);
}
