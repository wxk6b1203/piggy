/**
 * 会话统计 store（docs/14 §6）：`pi_get_session_stats` 的**唯一**前端消费者。
 *
 * 背景：Composer 的上下文环与右栏「统计」视图需要同一份数据。此前只有右栏在拉取，
 * Composer 若也要环就得重复发 RPC——本 store 收敛为每 tab 一份，谁在订阅谁触发刷新。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { cmd } from '@/lib/ipc';
import { windowEvents } from '@/lib/windowEvents';

export interface SessionStats {
  tokens?: { input?: number; output?: number; total?: number; cacheRead?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
}

interface StatsState {
  byTab: Record<string, SessionStats>;
  /** 在途请求去重：同一 tab 并发订阅只发一次 RPC */
  inflight: Record<string, Promise<void> | undefined>;
  /**
   * 生成速率采样（tok/s）。pi 只在提交边界给出累计 output tokens，
   * 因此这里用相邻两次刷新的增量除以真实时间差得到**实测**速率，
   * 而不是凭累计值估算。间隔过大（> 8s，说明期间无生成）时不报速率，避免误导。
   */
  rate: Record<string, { tokPerSec: number; at: number } | undefined>;
  refresh(tabId: string): Promise<void>;
  drop(tabId: string): void;
}

/** 相邻两次采样超过该间隔即认为本轮已停，不再沿用旧速率 */
const RATE_WINDOW_MS = 8000;

export const useStats = create<StatsState>()((set, get) => ({
  byTab: {},
  inflight: {},
  rate: {},

  async refresh(tabId) {
    const pending = get().inflight[tabId];
    if (pending) return pending;
    const p = (async () => {
      try {
        const s = await cmd<SessionStats>('pi_get_session_stats', { tabId });
        const now = Date.now();
        const prev = get().byTab[tabId];
        const prevSample = get().rate[tabId];
        set((st) => {
          const next: Partial<StatsState> = { byTab: { ...st.byTab, [tabId]: s } };
          const prevOut = prev?.tokens?.output;
          const nextOut = s.tokens?.output;
          if (prevSample && prevOut != null && nextOut != null && nextOut > prevOut) {
            const dt = (now - prevSample.at) / 1000;
            if (dt > 0.2 && dt * 1000 < RATE_WINDOW_MS) {
              next.rate = { ...st.rate, [tabId]: { tokPerSec: (nextOut - prevOut) / dt, at: now } };
            }
          } else if (!prevSample || now - prevSample.at >= RATE_WINDOW_MS) {
            next.rate = { ...st.rate, [tabId]: { tokPerSec: 0, at: now } };
          }
          return next;
        });
      } catch {
        /* 会话未就绪（worker 冷启/已回收）：保留上次值，不写错误态 */
      } finally {
        set((st) => ({ inflight: { ...st.inflight, [tabId]: undefined } }));
      }
    })();
    set((st) => ({ inflight: { ...st.inflight, [tabId]: p } }));
    return p;
  },

  drop(tabId) {
    set((st) => {
      const byTab = { ...st.byTab };
      delete byTab[tabId];
      const rate = { ...st.rate };
      delete rate[tabId];
      return { byTab, rate };
    });
  },
}));

/**
 * 订阅某 tab 的统计：挂载/切换 tab 时拉一次，并在 `refresh-stats` 事件到达时刷新。
 * 多个组件同时订阅同一 tab 不会放大 RPC 次数（`refresh` 内部去重）。
 */
export function useSessionStats(tabId: string | null): SessionStats | null {
  const stats = useStats((s) => (tabId ? s.byTab[tabId] : undefined));
  const refresh = useStats((s) => s.refresh);

  useEffect(() => {
    if (!tabId) return;
    void refresh(tabId);
    return windowEvents.on('refresh-stats', (id) => {
      if (id === tabId) void refresh(tabId);
    });
  }, [tabId, refresh]);

  return stats ?? null;
}
