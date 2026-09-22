/** tabsStore v2（M1 多 tab）：tab 注册表 + 活动 tab + 未读徽标（docs/04 §1.3） */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { cmd } from '@/lib/ipc';

export interface TabSnapshot {
  tab_id: string;
  cwd: string;
  session_id: string | null;
  session_file: string | null;
  session_name: string | null;
  worker_state: 'spawning' | 'ready' | 'busy' | 'crashed' | 'stopped';
  state: {
    model?: { id?: string; name?: string; provider?: string } | null;
    thinkingLevel?: string;
    isStreaming?: boolean;
    sessionName?: string;
  };
}

export interface TabInfo {
  tabId: string;
  cwd: string;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  workerState: TabSnapshot['worker_state'];
  model: { id?: string; provider?: string } | null;
  thinkingLevel: string | null;
}

interface TabsState {
  tabs: Record<string, TabInfo>;
  order: string[];
  activeTabId: string | null;
  unread: Record<string, boolean>;
  banner: string | null;

  addTab(snap: TabSnapshot): void;
  removeTab(tabId: string): void;
  setActive(tabId: string): void;
  patch(tabId: string, patch: Partial<TabInfo>): void;
  setWorkerState(tabId: string, s: TabInfo['workerState'], extra?: Record<string, unknown>): void;
  markUnread(tabId: string): void;
  clearUnread(tabId: string): void;
  setBanner(b: string | null): void;
  snapshotOf(tabId: string): TabSnapshot | null;
}

export const useTabs = create<TabsState>()(
  immer((set, get) => ({
  tabs: {},
  order: [],
  activeTabId: null,
  unread: {},
  banner: null,

  addTab(snap) {
    set((s) => {
      s.tabs[snap.tab_id] = {
        tabId: snap.tab_id,
        cwd: snap.cwd,
        sessionFile: snap.session_file,
        sessionId: snap.session_id,
        sessionName: snap.session_name,
        workerState: snap.worker_state,
        model: snap.state.model ?? null,
        thinkingLevel: snap.state.thinkingLevel ?? null,
      };
      if (!s.order.includes(snap.tab_id)) s.order.push(snap.tab_id);
      s.activeTabId = snap.tab_id;
    });
  },

  removeTab(tabId) {
    set((s) => {
      delete s.tabs[tabId];
      s.order = s.order.filter((id) => id !== tabId);
      delete s.unread[tabId];
      if (s.activeTabId === tabId) {
        s.activeTabId = s.order.at(-1) ?? null;
      }
    });
  },

  setActive(tabId) {
    set({ activeTabId: tabId });
    get().clearUnread(tabId);
  },

  patch(tabId, patch) {
    set((s) => {
      const t = s.tabs[tabId];
      if (t) Object.assign(t, patch);
    });
  },

  setWorkerState(tabId, workerState, extra) {
    get().patch(tabId, { workerState });
    if (extra?.['gaveUp']) useTabs.setState({ banner: '⚠ worker 反复崩溃，已停止自动重启' });
    else if (workerState === 'crashed') useTabs.setState({ banner: '⚠ worker 崩溃，正在自动重启…' });
    else if (workerState === 'ready' && extra?.['revived']) useTabs.setState({ banner: null });
  },

  markUnread(tabId) {
    set((s) => {
      s.unread[tabId] = true;
    });
  },

  clearUnread(tabId) {
    set((s) => {
      delete s.unread[tabId];
    });
  },

  setBanner(b) {
    set({ banner: b });
  },

  snapshotOf(tabId) {
    const t = get().tabs[tabId];
    if (!t) return null;
    return {
      tab_id: t.tabId,
      cwd: t.cwd,
      session_id: t.sessionId,
      session_file: t.sessionFile,
      session_name: t.sessionName,
      worker_state: t.workerState,
      state: { model: t.model, thinkingLevel: t.thinkingLevel ?? undefined },
    };
  },
  }))
);
/** 创建 tab（含初始化）；失败抛出由调用方呈现 */
export async function createTab(opts: { cwd?: string; sessionPath?: string; name?: string }) {
  return cmd<TabSnapshot>('tab_create', {
    cwd: opts.cwd,
    session_path: opts.sessionPath,
    name: opts.name,
  });
}
