/** 会话侧栏：工作区分组 + 折叠 + 搜索 + 新建/改名/导出/删除。
 *  顶部品牌行与行高/选中态对齐 DSH（docs/12 §5）；图标用 VS Code codicons（docs/13）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { windowEvents } from '@/lib/windowEvents';
import { Modal, Input, Button } from 'antd';
import { cmd } from '@/lib/ipc';
import { pickDirectory } from '@/lib/picker';
import { baseName } from '@/lib/paths';
import { createTabGuarded, findTabBySession } from '@/lib/tabCreate';
import { createTab, useTabs, type TabSnapshot } from '@/stores/tabs';
import {
  useSessions,
  sessionTitle,
  relTime,
  createdMs,
  buildSidebar,
  type SessionMeta,
} from '@/stores/sessions';
import { openSessionTab, openSettingsTab, focusSessionTab } from './EditorArea';
import { Icon } from '@/features/common/Icon';
import { ContextMenu, type MenuItem } from '@/features/common/ContextMenu';
import { SessionTitlePreview } from './SessionTitlePreview';
import { describeRun, generateTitle, loadTitleSource, type TitleSourceInfo } from '@/lib/sessionTitle';
import { toast, confirm } from '@/lib/feedback';
import { useUi } from '@/stores/ui';

export function SessionsSidebar() {
  const groups = useSessions((s) => s.groups);
  const loaded = useSessions((s) => s.loaded);
  const load = useSessions((s) => s.load);
  const removeLocal = useSessions((s) => s.removeLocal);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<SessionMeta | null>(null);
  const [renameText, setRenameText] = useState('');
  const [newProject, setNewProject] = useState<{ open: boolean; cwd: string }>({ open: false, cwd: '' });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  /** 右键菜单：位置 + 针对哪个会话。null = 没开。 */
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; session: SessionMeta } | null>(null);
  /** 正在生成标题的会话 path（同一时刻只允许一个：生成是一次模型调用） */
  const [titling, setTitling] = useState<string | null>(null);
  /** 「看看会拿什么去生成」的预览。 */
  const [preview, setPreview] = useState<{
    session: SessionMeta;
    info: TitleSourceInfo | null;
    error: string | null;
  } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const setAboutOpen = useUi((s) => s.setAboutOpen);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void load();
    return windowEvents.on('focus-session-search', () => {
      searchRef.current?.focus();
    });
  }, [load]);

  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const activeSessionFile = activeTabId ? tabs[activeTabId]?.sessionFile : null;
  const openSessionFiles = useMemo(
    () => new Set(Object.values(tabs).map((t) => t.sessionFile).filter(Boolean) as string[]),
    [tabs],
  );

  /**
   * 生成/重新生成标题。
   *
   * 三处入口（右键菜单、悬停图标、命令面板）都走这一个函数——行为分叉是这类
   * "再加一个入口"最容易出的问题（比如只有一个入口会刷新列表）。
   */
  const doGenerateTitle = useCallback(
    async (m: SessionMeta) => {
      if (titling) return;
      setTitling(m.path);
      try {
        const r = await generateTitle(m.path);
        // 生成完重新拉列表：界面显示的必须就是磁盘上的（不做本地合并）
        await load();
        toast.success(`标题已更新为「${r.title}」（${describeRun(r)}）`);
      } catch (e) {
        toast.error(`生成标题失败：${e}`);
      } finally {
        setTitling(null);
      }
    },
    [titling, load],
  );

  /** 打开"素材预览"：列出这次会拿哪几条消息去生成（不调用模型，免费）。 */
  const openTitlePreview = useCallback(async (m: SessionMeta) => {
    setPreview({ session: m, info: null, error: null });
    try {
      setPreview({ session: m, info: await loadTitleSource(m.path), error: null });
    } catch (e) {
      setPreview({ session: m, info: null, error: String(e) });
    }
  }, []);

  const q = query.trim().toLowerCase();
  const sidebar = useMemo(
    () =>
      buildSidebar(
        groups.map((g) => ({
          ...g,
          sessions: q
            ? g.sessions.filter(
                (m) =>
                  sessionTitle(m).toLowerCase().includes(q) ||
                  (m.session_id ?? '').toLowerCase().includes(q),
              )
            : g.sessions,
        })).filter((g) => g.sessions.length > 0),
        collapsedGroups,
        expandedGroups,
      ),
    [groups, q, collapsedGroups, expandedGroups],
  );

  const openSession = async (m: SessionMeta) => {
    const existing = findTabBySession(m.path);
    if (existing && focusSessionTab(existing.tabId)) return;
    try {
      // 幂等：即使落到这里（比如面板丢了、或上一次点击还在建），也不会建出第二个 worker
      const snap = await createTabGuarded({ sessionPath: m.path, cwd: m.cwd ?? undefined });
      await openSessionTab(snap, sessionTitle(m));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const newSession = async (cwd?: string) => {
    try {
      const snap = await createTabGuarded({ cwd, name: '新会话' });
      const label = cwd ? `${baseName(cwd)} · 新会话` : '新会话';
      await openSessionTab(snap, label);
      void load(); // 新目录/新会话立即上侧栏（不依赖 watcher 时序）
    } catch (e) {
      toast.error(String(e));
    }
  };

  const submitNewSession = () => {
    const cwd = newProject.cwd.trim();
    setNewProject({ open: false, cwd: '' });
    void newSession(cwd || undefined);
  };

  const browseCwd = async () => {
    const dir = await pickDirectory('选择项目目录', newProject.cwd.trim() || undefined);
    if (dir) setNewProject((s) => ({ ...s, cwd: dir }));
  };

  const doRename = async () => {
    if (!renaming) return;
    try {
      await cmd('session_rename', { path: renaming.path, name: renameText });
      toast.success('已重命名');
      setRenaming(null);
      void load();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doDelete = (m: SessionMeta) => {
    confirm({
      title: '删除会话',
      content: `「${sessionTitle(m)}」将移入系统回收站。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await cmd('session_delete', { path: m.path });
          removeLocal(m.path);
          toast.success('已移入回收站');
        } catch (e) {
          toast.error(String(e));
        }
      },
    });
  };

  const doExport = async (m: SessionMeta) => {
    try {
      // 导出**已打开**的会话必须复用那个 tab：
      //  - 原来无条件 createTabGuarded → 撞上 Rust 的会话互斥锁 → 报"会话文件已被打开"（必现，不是偶尔）；
      //  - 而且导出后不能顺手把用户正在用的标签关掉。
      const existing = findTabBySession(m.path);
      const snap = existing ?? (await createTabGuarded({ sessionPath: m.path, cwd: m.cwd ?? undefined }));
      const tabId = existing ? existing.tabId : (snap as TabSnapshot).tab_id;
      const d = await cmd<{ path?: string }>('pi_export_html', { tabId });
      if (!existing) {
        await cmd('tab_close', { tabId });
        useTabs.getState().removeTab(tabId);
      }
      toast.success(`已导出：${d.path ?? '(见工作目录)'}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const recentCwds = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ cwd: string; label: string }> = [];
    for (const g of sidebar) {
      if (!seen.has(g.cwd)) {
        seen.add(g.cwd);
        list.push({ cwd: g.cwd, label: g.label });
      }
    }
    return list.slice(0, 4);
  }, [sidebar]);

  /** 菜单项：会话行的全部操作都能从这儿够到（悬停图标放不下更多了）。 */
  const menuItems = useCallback(
    (m: SessionMeta): MenuItem[] => {
      const hasName = !!m.name;
      return [
        { id: 'open', label: '打开会话', onSelect: () => void openSession(m) },
        {
          id: 'title',
          label: hasName ? '重新生成标题' : '生成标题',
          hint: '调用模型，按会话内容起一个短标题',
          disabled: titling !== null,
          onSelect: () => void doGenerateTitle(m),
        },
        {
          id: 'title-preview',
          label: '看看会拿什么去生成',
          hint: '不调用模型，只列出取材的消息',
          disabled: titling !== null,
          onSelect: () => void openTitlePreview(m),
        },
        {
          id: 'rename',
          label: '重命名…',
          onSelect: () => {
            setRenaming(m);
            setRenameText(m.name ?? sessionTitle(m));
          },
        },
        { id: 'export', label: '导出 HTML', onSelect: () => void doExport(m) },
        { id: 'delete', label: '删除会话', danger: true, onSelect: () => doDelete(m) },
      ];
    },
    [doGenerateTitle, doDelete, doExport, openSession, titling],
  );

  return (
    <div className="pg-sidebar">
      {/* DSH 品牌行（docs/12 §5.3）：DSH 没有自绘标题栏，品牌落在侧栏顶部 */}
      <div className="pg-brand-row">
        <span className="pg-brand-logo" aria-hidden="true">🐷</span>
        <span className="pg-brand-name">Piggy</span>
        {/* 版本号是「关于与许可」的第三个入口（docs/04 §2.5）：系统菜单在
            macOS 上才有、命令面板要用户记得住名字，鼠标用户最自然会点这里。
            三个入口都只置 aboutOpen，界面只有一处（规矩 36）。 */}
        <button
          className="pg-brand-version"
          title="关于 Piggy 与许可"
          aria-label="关于 Piggy 与许可"
          onClick={() => setAboutOpen(true)}
        >
          v0.1.0
        </button>
        <span className="pg-brand-spacer" />
        <button className="pg-icon-btn" title="切换主题" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'color-mode' : 'lightbulb'} size={14} />
        </button>
        <button className="pg-icon-btn" title="收起侧栏（⌘B）" onClick={() => setSidebarOpen(false)}>
          <Icon name="layout-sidebar-left" size={14} />
        </button>
      </div>

      {/* 「看看会拿什么去生成」：不调用模型，先把素材列出来 */}
      <SessionTitlePreview
        open={preview !== null}
        info={preview?.info ?? null}
        error={preview?.error ?? null}
        onClose={() => setPreview(null)}
      />

      {/* 右键菜单：portal 到 body，避免被侧栏的 overflow 裁掉 */}
      <ContextMenu
        at={menu?.at ?? null}
        items={menu ? menuItems(menu.session) : []}
        onClose={() => setMenu(null)}
      />

      <button className="pg-sidebar-new" onClick={() => setNewProject({ open: true, cwd: '' })}>
        <Icon name="add" size={14} /> 新会话
      </button>
      <input
        ref={searchRef}
        className="pg-sidebar-search"
        placeholder="搜索会话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pg-sidebar-label">
        工作区
        <span className="pg-sidebar-label-count">{sidebar.length}</span>
      </div>
      <div className="pg-sidebar-list">
        {!loaded && <div className="pg-fg-dim pg-sidebar-pad">加载中…</div>}
        {loaded && sidebar.length === 0 && (
          <div className="pg-fg-dim pg-sidebar-pad">无会话（点「新会话」新建；终端 pi 建的会话首个回合后出现）</div>
        )}
        {sidebar.map((g) => {
          const collapsed = !!collapsedGroups[g.cwd];
          return (
            <div key={g.cwd} className="pg-group">
              <div
                className="pg-group-head"
                title={g.cwd}
                onClick={() => setCollapsedGroups((s) => ({ ...s, [g.cwd]: !collapsed }))}
              >
                <span className="pg-group-caret">
                  <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </span>
                <span className="pg-group-icon">
                  <Icon name={collapsed ? 'folder' : 'folder-opened'} size={14} />
                </span>
                <span className="pg-group-label">{g.label}</span>
                <span className="pg-group-count">{g.sessions.length}</span>
                <button
                  className="pg-group-new"
                  title={`在 ${g.label} 新建会话`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void newSession(g.cwd);
                  }}
                >
                  <Icon name="add" size={13} />
                </button>
              </div>
              {!collapsed &&
                g.visible.map((m) => {
                  const active = m.path === activeSessionFile;
                  const opened = openSessionFiles.has(m.path);
                  return (
                    <div
                      key={m.path}
                      className={`pg-session-row${active ? ' pg-active' : ''}`}
                      onClick={() => void openSession(m)}
                      onContextMenu={(e) => {
                        // 右键菜单是会话行操作的完整入口；悬停图标只放最常用的三个
                        e.preventDefault();
                        e.stopPropagation();
                        setMenu({ at: { x: e.clientX, y: e.clientY }, session: m });
                      }}
                      data-session-path={m.path}
                      title={m.cwd_missing ? `${m.path}（⚠ 项目目录已删除，打开会失败）` : m.path}
                    >
                      <span className="pg-session-title">
                        {opened && !active ? '• ' : ''}
                        {sessionTitle(m)}
                        {m.cwd_missing ? ' ⚠' : ''}
                      </span>
                      {/* 显示**创建**时间，与排序口径一致；最后活动时间放 title 里不丢信息 */}
                      <span
                        className="pg-session-time"
                        title={`创建于 ${new Date(createdMs(m)).toLocaleString()}\n最后活动 ${new Date(m.mtime_ms).toLocaleString()}`}
                      >
                        {relTime(createdMs(m))}
                      </span>
                      <span className="pg-session-ops">
                        <button
                          className="pg-session-titlegen"
                          title={m.name ? '重新生成标题' : '生成标题（调用模型）'}
                          aria-label={m.name ? '重新生成标题' : '生成标题'}
                          disabled={titling !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void doGenerateTitle(m);
                          }}
                        >
                          <Icon name="edit-sparkle" size={12} spin={titling === m.path} />
                        </button>
                        <button
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenaming(m);
                            setRenameText(m.name ?? sessionTitle(m));
                          }}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                        <button
                          title="导出 HTML"
                          onClick={(e) => {
                            e.stopPropagation();
                            void doExport(m);
                          }}
                        >
                          <Icon name="export" size={12} />
                        </button>
                        <button
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            doDelete(m);
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              {!collapsed && g.hiddenCount > 0 && (
                <button
                  className="pg-group-more"
                  onClick={() => setExpandedGroups((s) => ({ ...s, [g.cwd]: !s[g.cwd] }))}
                >
                  {expandedGroups[g.cwd] ? '收起' : `展开其余 ${g.hiddenCount} 个会话`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button className="pg-sidebar-settings" onClick={() => openSettingsTab()} title="设置">
        <Icon name="settings-gear" size={14} /> 设置
      </button>

      <Modal
        open={newProject.open}
        title="新建会话（选择项目目录）"
        okText="创建"
        cancelText="取消"
        onOk={submitNewSession}
        onCancel={() => setNewProject({ open: false, cwd: '' })}
        destroyOnHidden
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            style={{ flex: 1 }}
            placeholder="项目绝对路径（留空 = 用户主目录）"
            value={newProject.cwd}
            onChange={(e) => setNewProject({ open: true, cwd: e.target.value })}
            onPressEnter={submitNewSession}
            allowClear
          />
          <Button onClick={() => void browseCwd()}>选择目录…</Button>
        </div>
        {recentCwds.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="pg-fg-dim" style={{ fontSize: 11, marginBottom: 4 }}>
              最近的工作区
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {recentCwds.map((r) => (
                <Button
                  key={r.cwd}
                  size="small"
                  onClick={() => setNewProject((s) => ({ ...s, cwd: r.cwd }))}
                  title={r.cwd}
                >
                  {r.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        <p className="pg-fg-dim" style={{ marginTop: 10, fontSize: 12 }}>
          「选择目录…」打开系统目录框；留空则在用户主目录新建。
        </p>
      </Modal>

      <Modal
        open={!!renaming}
        title="重命名会话"
        okText="保存"
        cancelText="取消"
        onOk={() => void doRename()}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onPressEnter={() => void doRename()}
        />
      </Modal>
    </div>
  );
}

