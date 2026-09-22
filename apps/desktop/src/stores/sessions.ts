/** 会话列表 store（WP2，docs/03 §2.8）：Rust 扫描 + sessions:changed 事件刷新 */
import { create } from 'zustand';
import { cmd, on } from '@/lib/ipc';

export interface SessionMeta {
  path: string;
  file_name: string;
  session_id: string | null;
  cwd: string | null;
  name: string | null;
  first_message: string | null;
  mtime_ms: number;
  size: number;
}

export interface SessionGroup {
  cwd: string;
  label: string;
  sessions: SessionMeta[];
}

interface SessionsState {
  groups: SessionGroup[];
  total: number;
  loaded: boolean;
  load(): Promise<void>;
  removeLocal(path: string): void;
}

function groupLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export const useSessions = create<SessionsState>()((set, get) => ({
  groups: [],
  total: 0,
  loaded: false,

  async load() {
    try {
      const metas = await cmd<SessionMeta[]>('session_list');
      const byCwd = new Map<string, SessionMeta[]>();
      for (const m of metas) {
        const cwd = m.cwd ?? '(未知项目)';
        if (!byCwd.has(cwd)) byCwd.set(cwd, []);
        byCwd.get(cwd)!.push(m);
      }
      const groups: SessionGroup[] = [...byCwd.entries()]
        .map(([cwd, sessions]) => ({ cwd, label: groupLabel(cwd), sessions }))
        .sort((a, b) => {
          const am = a.sessions[0]?.mtime_ms ?? 0;
          const bm = b.sessions[0]?.mtime_ms ?? 0;
          return bm - am;
        });
      set({ groups, total: metas.length, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  removeLocal(path) {
    set((s) => ({
      groups: s.groups
        .map((g) => ({ ...g, sessions: g.sessions.filter((x) => x.path !== path) }))
        .filter((g) => g.sessions.length > 0),
      total: Math.max(0, get().total - 1),
    }));
  },
}));

/** 会话显示标题：name > 首条用户消息 > 文件名 */
export function sessionTitle(m: SessionMeta): string {
  if (m.name) return m.name;
  if (m.first_message) return m.first_message;
  return m.file_name.replace(/\.jsonl$/, '');
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)}分钟`;
  if (diff < day) return `${Math.floor(diff / hour)}小时`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}天`;
  return `${Math.floor(diff / (30 * day))}个月`;
}

/** 全局 watcher 订阅（App 启动时挂一次） */
export async function watchSessionsChanged() {
  return on('sessions:changed', () => {
    void useSessions.getState().load();
  });
}
