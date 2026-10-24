/**
 * 右侧栏（文件 + 统计 + 通知）。
 *
 * 会话树视图 2026-09-24 **移除**（用户："会话树这个功能好像没什么用，去掉吧"）——
 * 它只是把 pi 的 `get_tree` 原样铺成一棵 antd Tree，既不能切分支也没有别的动作，
 * 而 pi 的 RPC 又没有"就地切分支"的入口（docs/02 §5.2 的 C11）。留着是纯粹的噪音：
 * 右栏一个按钮 + 一条 `/tree` 斜杠命令 + 一个只读树。
 *
 * 对齐 DSH（docs/12 §6）：DSH 右栏是**文档/代码预览**面板，token 用量等窗口级状态归 Composer dock，
 * 不占右栏。因此默认视图是「文件」，统计降为次级入口，避免同一份数据在两处重复呈现。
 * 图标统一用 VS Code codicons（docs/13），替换此前的 emoji。
 *
 * **可折叠（docs/04 §1.2「右视图轨常驻」）**：折叠 = 内容卸载、图标轨留下。
 * 留下轨道是硬要求，不是美观问题：左栏当年就是 `{sidebarOpen && <Panel…>}` ——
 * 折叠把侧栏连同它唯一的"展开"入口一起从 DOM 里删了，用户拿到的是**一屏黑、无处可点**
 * （见 SidebarRail.tsx 与 src/test/sidebar-rail.test.tsx）。
 * 几何（折叠到 40px）由 AppFrame 的 `collapsible` Panel 执行，这里只负责画什么。
 */
import { useCallback, useEffect, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { baseName } from '@/lib/paths';
import { cacheHitPercentOf, clampPercent, formatPercent, formatTokens } from '@/lib/tokenFormat';
import { windowEvents } from '@/lib/windowEvents';
import { Icon } from '@/features/common/Icon';
import { FileIcon } from '@/features/common/FileIcon';
import { toast } from '@/lib/feedback';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { unreadCount, useNotifications, type AppNotification } from '@/stores/notifications';
import { openPreviewTab } from './EditorArea';
import { FleetView } from './FleetView';

type RightView = 'files' | 'stats' | 'fleet' | 'notifications';

/**
 * Fleet（子代理）入口开关。
 *
 * 用户 2026-09-24："Fleet 功能暂时也隐藏掉按钮" —— 只藏**右栏那颗按钮**，
 * 视图本身与 `fleet:*` 通道都留着（`windowEvents.emit('rightbar-view', 'fleet')`
 * 仍可打开，门禁第 4 段就是这么进的）。要重新露出来把这个常量改回 true。
 */
const SHOW_FLEET_ENTRY = false;

export function RightBar({ tabId }: { tabId: string | null }) {
  const [view, setView] = useState<RightView>('files');
  // 开合状态在 store（命令 `rightpanel.toggle` / ⌘\ / 命令面板都要写它）；
  // 真正的几何由 AppFrame 那个可折叠 Panel 执行，这里只决定"画不画内容"。
  const open = useUi((s) => s.rightpanelOpen);
  const setOpen = useUi((s) => s.setRightpanelOpen);
  const unread = useNotifications((s) => unreadCount(s.items));

  /** 切视图 = 顺带展开。折叠态下点图标却什么都不出来，用户会以为按钮坏了。 */
  const show = useCallback(
    (v: RightView) => {
      // 通知视图一打开就全部已读（用户 2026-10-24 的口径；不在每条通知里再点一次）
      if (v === 'notifications') useNotifications.getState().markAllRead();
      setView(v);
      setOpen(true);
    },
    [setOpen],
  );

  // 视图也可由外部命令打开：`/session` → 统计（docs/04 §7.2）。
  // 走事件而不是把 view 提进 store：右栏视图是纯局部 UI 状态，提上去只会多一份要同步的东西。
  // ⚠️ 只有**开合**进了 store —— 那是"内容"与"图标轨"两边都要读的状态（后者常驻且折叠时也画）。
  useEffect(
    () =>
      windowEvents.on('rightbar-view', (v) => {
        if (v === 'files' || v === 'stats' || v === 'fleet' || v === 'notifications') show(v);
      }),
    [show],
  );

  // 通知视图开着时新到的通知也直接算已读（用户正看着它，不该再亮一个未读点）
  useEffect(() => {
    if (open && view === 'notifications' && unread > 0) useNotifications.getState().markAllRead();
  }, [open, view, unread]);

  return (
    <div className="pg-rightbar">
      {/* 内容是在**折叠时卸载**的（不是 CSS 藏起来）：折叠后 Panel 只有图标轨那么宽，
          留着内容等于白跑一遍文件树/统计的 IPC，读屏也还会念到看不见的东西。 */}
      {open && (
        <div className="pg-rightbar-body">
          {view === 'files' && <FilesView tabId={tabId} />}
          {view === 'stats' && <StatsView tabId={tabId} />}
          {view === 'notifications' && <NotificationsView />}
          {view === 'fleet' && <FleetView tabId={tabId} />}
        </div>
      )}
      {/* 折叠态留下的那条图标轨（40px）。**它是折叠后唯一还能点的地方**——
          与左栏折叠轨（SidebarRail，56px）同一条教训：折叠绝不能把唯一的出口一起删掉。 */}
      <div
        className="pg-rightrail"
        role="toolbar"
        aria-label={open ? '右侧栏视图' : '折叠的右栏'}
        aria-orientation="vertical"
      >
        <button
          type="button"
          className="pg-rail-btn pg-rail-toggle-right"
          title={open ? '收起右栏（⌘\\）' : '展开右栏（⌘\\）'}
          aria-label={open ? '收起右栏' : '展开右栏'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'layout-sidebar-right-off' : 'layout-sidebar-right'} size={15} />
        </button>
        <button
          type="button"
          className={`pg-rail-btn${view === 'files' && open ? ' pg-rail-active' : ''}`}
          title="文件（项目根）"
          aria-label="文件"
          aria-pressed={view === 'files' && open}
          onClick={() => show('files')}
        >
          <Icon name="files" size={15} />
        </button>
        <button
          type="button"
          className={`pg-rail-btn${view === 'stats' && open ? ' pg-rail-active' : ''}`}
          title="统计"
          aria-label="统计"
          aria-pressed={view === 'stats' && open}
          onClick={() => show('stats')}
        >
          <Icon name="dashboard" size={15} />
        </button>
        <button
          type="button"
          className={`pg-rail-btn${view === 'notifications' && open ? ' pg-rail-active' : ''}`}
          title={unread > 0 ? `通知（${unread} 条未读）` : '通知'}
          aria-label={unread > 0 ? `通知（${unread} 条未读）` : '通知'}
          aria-pressed={view === 'notifications' && open}
          data-notifications-entry
          onClick={() => show('notifications')}
        >
          <Icon name="bell" size={15} />
          {unread > 0 ? <span className="pg-rail-unread-dot" aria-hidden /> : null}
        </button>
        {SHOW_FLEET_ENTRY ? (
          <button
            type="button"
            className={`pg-rail-btn${view === 'fleet' && open ? ' pg-rail-active' : ''}`}
            title="Fleet（子代理）"
            aria-label="Fleet"
            aria-pressed={view === 'fleet' && open}
            onClick={() => show('fleet')}
          >
            <Icon name="server-process" size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface StatsData {
  tokens?: { input?: number; output?: number; total?: number; cacheRead?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
}

function StatsView({ tabId }: { tabId: string | null }) {
  const [stats, setStats] = useState<StatsData | null>(null);
  useEffect(() => {
    if (!tabId) return;
    const refresh = () => {
      void cmd<StatsData>('pi_get_session_stats', { tabId }).then(setStats).catch(() => {});
    };
    refresh();
    return windowEvents.on('refresh-stats', (id) => {
      if (id === tabId) refresh();
    });
  }, [tabId]);

  if (!tabId) return <div className="pg-fg-dim pg-rightbar-pad">无活动会话</div>;
  const total = stats?.tokens?.total;
  const ctx = stats?.contextUsage;
  const pct = ctx?.percent;
  const used = clampPercent(pct);
  // 命中率、上下文长度、上下文占用的口径都在 lib/tokenFormat（3 位小数，与状态行同一份实现）
  const hit = cacheHitPercentOf(stats?.tokens);
  return (
    <div className="pg-stats">
      <Row label="总 tokens" value={total?.toLocaleString() ?? '—'} />
      <Row
        label="输入 / 输出"
        value={stats?.tokens ? `${(stats.tokens.input ?? 0).toLocaleString()} / ${(stats.tokens.output ?? 0).toLocaleString()}` : '—'}
      />
      <Row label="缓存读" value={stats?.tokens?.cacheRead?.toLocaleString() ?? '—'} />
      <Row label="缓存命中" value={hit != null ? `${hit}%` : '—'} />
      <Row label="成本" value={stats?.cost != null ? `$${Number(stats.cost).toFixed(4)}` : '—'} />
      <div className="pg-stat-row">
        <span className="pg-stat-label">上下文</span>
        <span className="pg-stat-value" data-ctx-percent={formatPercent(pct)}>
          {pct != null ? `${formatPercent(pct)}%` : '—'}
        </span>
      </div>
      <Row
        label="上下文长度"
        value={`${formatTokens(ctx?.tokens)} / ${formatTokens(ctx?.contextWindow)}`}
      />
      <div className="pg-usage-bar">
        <div
          className="pg-usage-fill"
          style={{ width: `${used}%` }}
          data-level={used > 85 ? 'high' : used > 60 ? 'mid' : 'low'}
        />
      </div>
      <Row label="消息" value={stats ? `${stats.userMessages ?? 0} 用户 / ${stats.assistantMessages ?? 0} 助手` : '—'} />
      <Row label="工具调用" value={stats?.toolCalls?.toLocaleString() ?? '—'} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="pg-stat-row">
      <span className="pg-stat-label">{label}</span>
      <span className="pg-stat-value">{value}</span>
    </div>
  );
}

/* ---------------- 通知视图：扩展 notify 的历史（打开即全部已读） ---------------- */

function clockOf(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function NotificationsView() {
  const items = useNotifications((s) => s.items);
  const tabs = useTabs((s) => s.tabs);

  if (items.length === 0) {
    return (
      <div className="pg-notif-empty pg-rightbar-pad" data-notifications-empty>
        暂无通知
      </div>
    );
  }

  return (
    <div className="pg-notif" data-notifications>
      <div className="pg-notif-head">
        <span>通知</span>
        <span className="pg-notif-count">{items.length}</span>
      </div>
      <div className="pg-notif-list">
        {items.map((n: AppNotification) => {
          const tab = n.tabId ? tabs[n.tabId] : undefined;
          const source =
            tab?.sessionName?.trim() || (tab?.cwd ? baseName(tab.cwd) : n.tabId ? '已关闭的会话' : 'Piggy');
          return (
            <div
              key={n.id}
              className="pg-notif-item"
              data-notification-item
              data-level={n.level}
              data-read={n.read ? 'true' : 'false'}
            >
              <div className="pg-notif-meta">
                <span className="pg-notif-source">{source}</span>
                <time className="pg-notif-time" dateTime={new Date(n.ts).toISOString()}>
                  {clockOf(n.ts)}
                </time>
              </div>
              <div className="pg-notif-message">{n.message}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 文件视图：活动 tab 项目根的只读目录树（docs/04 §1.6） ---------------- */

interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** 每个已展开目录的条目缓存：key = 绝对路径。 */
function FilesView({ tabId }: { tabId: string | null }) {
  const cwd = useTabs((s) => (tabId ? s.tabs[tabId]?.cwd : undefined));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
    setError(null);
  }, [cwd]);

  const loadDir = async (dir: string, root: string) => {
    try {
      const r = await cmd<{ entries: FsEntry[] }>('fs_list_dir', { root, path: dir });
      setChildren((prev) => ({ ...prev, [dir]: r.entries ?? [] }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 首屏加载根目录（懒加载只针对子目录）
  useEffect(() => {
    if (cwd) void loadDir(cwd, cwd);
  }, [cwd]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir] && cwd) void loadDir(dir, cwd);
      }
      return next;
    });
  };

  if (!tabId || !cwd) return <div className="pg-rightbar-pad pg-fg-dim">无活动会话</div>;
  if (error) return <div className="pg-rightbar-pad pg-fg-dim">目录读取失败：{error}</div>;

  return (
    <div className="pg-files" role="tree" aria-label="项目文件">
      <div className="pg-files-head" title={cwd}>
        <Icon name="root-folder" size={13} />
        <span className="pg-files-rootname">{baseName(cwd) || cwd}</span>
      </div>
      <DirEntries
        dir={cwd}
        depth={0}
        expanded={expanded}
        children={children}
        onToggle={toggle}
        onError={setError}
      />
    </div>
  );
}

function DirEntries({
  dir,
  depth,
  expanded,
  children,
  onToggle,
  onError,
}: {
  dir: string;
  depth: number;
  expanded: Set<string>;
  children: Record<string, FsEntry[]>;
  onToggle: (dir: string) => void;
  onError: (e: string) => void;
}) {
  const entries = children[dir];
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => {
        const full = `${dir}/${e.name}`;
        const isOpen = expanded.has(full);
        return (
          <div key={full}>
            <button
              className="pg-files-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              role="treeitem"
              aria-expanded={e.isDir ? isOpen : undefined}
              title={full}
              onClick={() => {
                if (e.isDir) onToggle(full);
                else openPreviewTab(full, full, e.name, dir);
              }}
            >
              <FileIcon name={e.name} isDir={e.isDir} open={isOpen} size={14} />
              <span className="pg-files-name">{e.name}</span>
            </button>
            {e.isDir && isOpen && (
              <DirEntries
                dir={full}
                depth={depth + 1}
                expanded={expanded}
                children={children}
                onToggle={onToggle}
                onError={onError}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
