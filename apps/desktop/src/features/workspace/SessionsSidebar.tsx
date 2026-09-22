/** 会话侧栏（WP2，docs/04 §1.5）：项目分组 + 相对时间 + 搜索 + 新建/删除/导出/重命名 */
import { useEffect, useState } from 'react';
import { message as antdMessage, Modal, Input } from 'antd';
import { cmd } from '@/lib/ipc';
import { createTab, useTabs } from '@/stores/tabs';
import { useSessions, sessionTitle, relTime, type SessionMeta } from '@/stores/sessions';
import { openSessionTab, openSettingsTab } from './EditorArea';

export function SessionsSidebar() {
  const groups = useSessions((s) => s.groups);
  const loaded = useSessions((s) => s.loaded);
  const load = useSessions((s) => s.load);
  const removeLocal = useSessions((s) => s.removeLocal);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<SessionMeta | null>(null);
  const [renameText, setRenameText] = useState('');
  const [newProject, setNewProject] = useState<{ open: boolean; cwd: string }>({ open: false, cwd: '' });

  useEffect(() => {
    void load();
  }, [load]);

  const tabs = useTabs((s) => s.tabs);
  const activeFiles = new Set(Object.values(tabs).map((t) => t.sessionFile));
  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      sessions: q
        ? g.sessions.filter(
            (m) =>
              sessionTitle(m).toLowerCase().includes(q) ||
              (m.session_id ?? '').toLowerCase().includes(q),
          )
        : g.sessions,
    }))
    .filter((g) => g.sessions.length > 0);

  const openSession = async (m: SessionMeta) => {
    try {
      const snap = await createTab({ sessionPath: m.path, cwd: m.cwd ?? undefined });
      await openSessionTab(snap, sessionTitle(m));
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const newSession = async (cwd: string) => {
    try {
      const snap = await createTab({ cwd, name: '新会话' });
      await openSessionTab(snap, '新会话');
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const doRename = async () => {
    if (!renaming) return;
    try {
      await cmd('session_rename', { path: renaming.path, name: renameText });
      antdMessage.success('已重命名');
      setRenaming(null);
      void load();
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const doDelete = (m: SessionMeta) => {
    Modal.confirm({
      title: '删除会话',
      content: `「${sessionTitle(m)}」将移入系统回收站。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await cmd('session_delete', { path: m.path });
          removeLocal(m.path);
          antdMessage.success('已移入回收站');
        } catch (e) {
          antdMessage.error(String(e));
        }
      },
    });
  };

  const doExport = async (m: SessionMeta) => {
    try {
      // 导出需要打开会话的 worker：借 rename 的临时 worker 语义 → 先开再导
      const snap = await createTab({ sessionPath: m.path, cwd: m.cwd ?? undefined });
      const d = await cmd<{ path?: string }>('pi_export_html', { tabId: snap.tab_id });
      await cmd('tab_close', { tabId: snap.tab_id });
      useTabs.getState().removeTab(snap.tab_id);
      antdMessage.success(`已导出：${d.path ?? '(见工作目录)'}`);
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  return (
    <div className="pg-sidebar">
      <div className="pg-sidebar-actions">
        <button className="pg-btn pg-btn-primary pg-sidebar-new" onClick={() => setNewProject({ open: true, cwd: '' })}>
          ⊕ 新会话
        </button>
        <button className="pg-btn" onClick={() => openSettingsTab()} title="设置">
          ⚙
        </button>
      </div>
      <input
        className="pg-sidebar-search"
        placeholder="搜索会话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pg-sidebar-list">
        {!loaded && <div className="pg-fg-dim pg-sidebar-pad">加载中…</div>}
        {loaded && filtered.length === 0 && (
          <div className="pg-fg-dim pg-sidebar-pad">无会话（会话在首个回合后落盘）</div>
        )}
        {filtered.map((g) => (
          <div key={g.cwd} className="pg-group">
            <div className="pg-group-head" title={g.cwd}>
              <span className="pg-group-icon">📁</span>
              <span className="pg-group-label">{g.label}</span>
              <button
                className="pg-group-new"
                title={`在 ${g.label} 新建会话`}
                onClick={() => void newSession(g.cwd)}
              >
                +
              </button>
            </div>
            {g.sessions.map((m) => {
              const active = activeFiles.has(m.path);
              return (
                <div
                  key={m.path}
                  className={`pg-session-row${active ? ' pg-active' : ''}`}
                  onClick={() => void openSession(m)}
                  title={m.path}
                >
                  <span className="pg-session-title">{sessionTitle(m)}</span>
                  <span className="pg-session-time">{relTime(m.mtime_ms)}</span>
                  <span className="pg-session-ops">
                    <button
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenaming(m);
                        setRenameText(m.name ?? sessionTitle(m));
                      }}
                    >
                      ✎
                    </button>
                    <button
                      title="导出 HTML"
                      onClick={(e) => {
                        e.stopPropagation();
                        void doExport(m);
                      }}
                    >
                      ⇪
                    </button>
                    <button
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        doDelete(m);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <Modal
        open={newProject.open}
        title="新建会话（输入项目目录）"
        okText="创建"
        cancelText="取消"
        onOk={() => {
          const cwd = newProject.cwd.trim() || undefined;
          setNewProject({ open: false, cwd: '' });
          void newSession(cwd ?? '');  // 留空 = Rust 侧默认 HOME
        }}
        onCancel={() => setNewProject({ open: false, cwd: '' })}
        destroyOnHidden
      >
        <Input
          placeholder="项目绝对路径（留空 = 用户主目录；目录选择器 WP5）"
          value={newProject.cwd}
          onChange={(e) => setNewProject({ open: true, cwd: e.target.value })}
        />
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
        <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} onPressEnter={() => void doRename()} />
      </Modal>
    </div>
  );
}

