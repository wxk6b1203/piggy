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
  /** 项目目录已不存在（打开会失败，Rust scan 标记） */
  cwd_missing?: boolean;
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

/* ---------------- DSH 式侧栏视图模型（纯函数，可测） ---------------- */

export interface SessionGroupView {
  cwd: string;
  label: string;
  /** 全部会话（按 mtime 降序） */
  sessions: SessionMeta[];
  /** 折叠时为空数组 */
  visible: SessionMeta[];
  /** 折叠/收起后未展示的会话数 */
  hiddenCount: number;
}

export const PREVIEW_LIMIT = 3;

/**
 * 侧栏分组视图（docs/09 DSH 参考）：组按最新会话 mtime 降序；组内会话 mtime 降序；
 * collapsedGroups 整组收起；expandedGroups 超过 PREVIEW_LIMIT 时展开全部，否则显示前 3 + 折叠计数。
 */
export function buildSidebar(
  groups: SessionGroup[],
  collapsedGroups: Record<string, boolean>,
  expandedGroups: Record<string, boolean>,
): SessionGroupView[] {
  const sorted = [...groups]
    .map((g) => ({
      ...g,
      sessions: [...g.sessions].sort((a, b) => b.mtime_ms - a.mtime_ms),
    }))
    .sort((a, b) => (b.sessions[0]?.mtime_ms ?? 0) - (a.sessions[0]?.mtime_ms ?? 0));
  return sorted.map((g) => {
    if (collapsedGroups[g.cwd]) {
      return { cwd: g.cwd, label: g.label, sessions: g.sessions, visible: [], hiddenCount: g.sessions.length };
    }
    const expanded = expandedGroups[g.cwd];
    const visible = expanded ? g.sessions : g.sessions.slice(0, PREVIEW_LIMIT);
    return {
      cwd: g.cwd,
      label: g.label,
      sessions: g.sessions,
      visible,
      hiddenCount: g.sessions.length - visible.length,
    };
  });
}
