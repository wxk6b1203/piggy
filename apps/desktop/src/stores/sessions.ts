/** 会话列表 store（WP2，docs/03 §2.8）：Rust 扫描 + sessions:changed 事件刷新 */
import { create } from 'zustand';
import { cmd, on } from '@/lib/ipc';
import { baseName } from '@/lib/paths';

export interface SessionMeta {
  path: string;
  file_name: string;
  session_id: string | null;
  cwd: string | null;
  name: string | null;
  first_message: string | null;
  /** 文件 mtime（最后写入时间）。**不用于排序**，仅作信息展示/兜底。 */
  mtime_ms: number;
  /** 会话创建时间（SessionHeader.timestamp → 文件名 → mtime）。排序与展示都用它。 */
  created_ms?: number;
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

/** 项目分组标题 = cwd 最后一段。导出是为了单测（Windows 反斜杠路径，见 `test/paths.test.ts`）。 */
export function groupLabel(cwd: string): string {
  // Windows 路径是反斜杠（C:\Users\x\proj）：只按 '/' 切会把整条路径当项目名
  return baseName(cwd) || cwd;
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
          // 用**创建时间**而不是 mtime：mtime 会随写入变化，
          // 于是"老会话被追加一条消息"就跳到顶部，顺序看起来经常变（用户报过）。
          const am = a.sessions[0] ? createdMs(a.sessions[0]) : 0;
          const bm = b.sessions[0] ? createdMs(b.sessions[0]) : 0;
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

/** 排序与展示统一用创建时间；缺字段时回落到 mtime（老 mock / 老后端）。 */
export function createdMs(m: SessionMeta): number {
  return m.created_ms ?? m.mtime_ms ?? 0;
}

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
  /** 「已删除的项目目录」汇总组：默认收起、永远排在最后（见 buildSidebar 注释） */
  missingRoot?: boolean;
}

export const PREVIEW_LIMIT = 3;

/** 「已删除的项目目录」汇总组的键（不是真 cwd，只用于折叠/展开状态）。 */
export const MISSING_CWD_KEY = '\u0000missing-cwd';

/**
 * 侧栏分组视图（docs/09 DSH 参考）：组与组内会话一律按**创建时间**降序（稳定，不随写入跳动）；
 * collapsedGroups 整组收起；expandedGroups 超过 PREVIEW_LIMIT 时展开全部，否则显示前 3 + 折叠计数。
 *
 * **目录已不存在的分组要沉底并合并成一个**（真机踩到）：自定义 `sessionDir` 下，
 * pi 自己会把每次 `pi -p`（含它自己的测试跑）的会话平铺写进同一个目录，于是侧栏里
 * 一次多出几十个 `/private/tmp/...`、`/var/folders/...` 分组——每个只挂 1 个会话，
 * 却因为"按最新排序"把用户真正的项目挤到第 16、27 位，看起来就像"原来的会话没了"。
 * 这些会话本身不能丢（pi 的 `--resume` 也能看到它们），所以合并成一个默认收起的
 * 汇总组放在最后，而不是过滤掉。判据用后端已经给出的 `cwd_missing`（逐会话），
 * 一个分组只要还有会话的目录存在，就仍按普通项目排。
 */
export function buildSidebar(
  groups: SessionGroup[],
  collapsedGroups: Record<string, boolean>,
  expandedGroups: Record<string, boolean>,
): SessionGroupView[] {
  const normalized = [...groups].map((g) => ({
    ...g,
    sessions: [...g.sessions].sort((a, b) => createdMs(b) - createdMs(a)),
  }));
  // 目录还在的项目组：按最新会话降序（原逻辑）
  const alive = normalized
    .filter((g) => g.sessions.some((m) => !m.cwd_missing))
    .sort((a, b) => {
      const am = a.sessions[0] ? createdMs(a.sessions[0]) : 0;
      const bm = b.sessions[0] ? createdMs(b.sessions[0]) : 0;
      return bm - am;
    });
  // 目录全没了的会话：合并成一个汇总组
  const missing = normalized
    .filter((g) => g.sessions.length > 0 && g.sessions.every((m) => m.cwd_missing))
    .flatMap((g) => g.sessions)
    .sort((a, b) => createdMs(b) - createdMs(a));

  const views = alive.map((g) => viewOf(g, collapsedGroups, expandedGroups));
  if (missing.length > 0) {
    views.push(
      viewOf(
        { cwd: MISSING_CWD_KEY, label: '已删除的项目目录', sessions: missing },
        collapsedGroups,
        expandedGroups,
        true,
      ),
    );
  }
  return views;
}

function viewOf(
  g: SessionGroup,
  collapsedGroups: Record<string, boolean>,
  expandedGroups: Record<string, boolean>,
  missingRoot = false,
): SessionGroupView {
  // 只有汇总组才带 missingRoot 标记，普通分组不带（别让调用方以为"false 也算标记"）
  const mark = missingRoot ? { missingRoot: true as const } : {};
  const expanded = expandedGroups[g.cwd];
  // 汇总组默认收起（用户没明确展开过就不铺开）
  if (missingRoot ? !expanded : collapsedGroups[g.cwd]) {
    return {
      cwd: g.cwd,
      label: g.label,
      sessions: g.sessions,
      visible: [],
      hiddenCount: g.sessions.length,
      ...mark,
    };
  }
  const visible = expanded ? g.sessions : g.sessions.slice(0, PREVIEW_LIMIT);
  return {
    cwd: g.cwd,
    label: g.label,
    sessions: g.sessions,
    visible,
    hiddenCount: g.sessions.length - visible.length,
    ...mark,
  };
}
