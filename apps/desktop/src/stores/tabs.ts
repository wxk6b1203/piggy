/** tabsStore（M0 单 tab 版）：worker 状态、模型/会话元信息、统计 */
import { create } from 'zustand';
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

interface TabsState {
  tabId: string | null;
  snapshot: TabSnapshot | null;
  workerState: 'spawning' | 'ready' | 'busy' | 'crashed' | 'stopped';
  banner: string | null;
  statsText: string | null;
  init(cwd?: string): Promise<TabSnapshot>;
  setWorkerState(s: TabsState['workerState'], extra?: Record<string, unknown>): void;
  refreshStats(): Promise<void>;
  refreshState(): Promise<void>;
}

let initPromise: Promise<TabSnapshot> | null = null;

export const useTabs = create<TabsState>()((set, get) => ({
  tabId: null,
  snapshot: null,
  workerState: 'spawning',
  banner: null,
  statsText: null,

  async init(cwd) {
    // 单例：React StrictMode 下 effect 双执行只创建一个 tab（docs/09 M0 修正）
    if (!initPromise) {
      initPromise = cmd<TabSnapshot>('tab_create', { cwd, name: 'Piggy M0' })
        .then((snap) => {
          set({ tabId: snap.tab_id, snapshot: snap, workerState: snap.worker_state });
          return snap;
        })
        .catch((e) => {
          initPromise = null; // 失败允许重试
          throw e;
        });
    }
    return initPromise;
  },

  setWorkerState(s, extra) {
    set({ workerState: s });
    if (extra) {
      if (extra['gaveUp']) set({ banner: '⚠ worker 反复崩溃，已停止自动重启' });
      else if (s === 'crashed') set({ banner: '⚠ worker 崩溃，正在自动重启…' });
      else if (s === 'ready' && extra['revived']) set({ banner: null });
    }
    if (s === 'ready' || s === 'busy') set({ banner: get().banner?.startsWith('⚠ worker') ? null : get().banner });
  },

  async refreshStats() {
    const tabId = get().tabId;
    if (!tabId) return;
    try {
      const stats = await cmd<{
        tokens?: { total?: number };
        cost?: number;
        contextUsage?: { percent?: number | null };
      }>('pi_get_session_stats', { tabId });
      const tok = stats.tokens?.total?.toLocaleString() ?? '—';
      const cost = stats.cost != null ? `$${Number(stats.cost).toFixed(4)}` : '';
      const ctx = stats.contextUsage?.percent != null ? ` · ctx ${stats.contextUsage.percent}%` : '';
      set({ statsText: `${tok} tok${cost ? ` · ${cost}` : ''}${ctx}` });
    } catch {
      /* M0：静默 */
    }
  },

  async refreshState() {
    const tabId = get().tabId;
    if (!tabId) return;
    try {
      const state = await cmd<Record<string, unknown>>('pi_get_state', { tabId });
      set((s) => ({
        snapshot: s.snapshot ? { ...s.snapshot, state: state as TabSnapshot['state'] } : s.snapshot,
      }));
    } catch {
      /* 静默 */
    }
  },
}));
