/** AppFrame（WP1，docs/04 §1）：外框 react-resizable-panels + 编辑区 dockview + 状态栏 */
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cmd } from '@/lib/ipc';
import { useEffect, useState } from 'react';
import { useTabMsg } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { EditorArea, openSessionTab } from './EditorArea';
import { SessionsSidebar } from './SessionsSidebar';
import { RightBar } from './RightBar';
import { ModelThinkingControls } from '@/features/chat/ModelThinking';
import { DialogRouter } from '@/features/dialogs/DialogRouter';
import { createTab } from '@/stores/tabs';
import { ensureTabListeners } from '@/lib/tabEvents';

let bootPromise: Promise<void> | null = null;

export function AppFrame() {
  const activeTabId = useTabs((s) => s.activeTabId);
  const order = useTabs((s) => s.order);
  const tabs = useTabs((s) => s.tabs);
  const banner = useTabs((s) => s.banner);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [stats] = useState('');

  // 启动：恢复布局（EditorArea.initEditorArea 处理 dockview 部分）；无会话面板则建新 tab
  // 单例 promise：StrictMode 双 effect 只执行一次（docs/09 M0 修正记录）
  useEffect(() => {
    if (!bootPromise) {
      bootPromise = (async () => {
        // 单窗口语义：新 JS 上下文接管前，收割上一上下文的孤儿 worker（02 §7.5）
        try {
          await cmd('boot_reset');
        } catch {
          /* 首启无遗留 */
        }
        interface LayoutJson {
          dockview?: { panels?: Record<string, { params?: { kind?: string } }> };
        }
        try {
          const l = await cmd<LayoutJson>('layout_load');
          const hasSession = Object.values(l?.dockview?.panels ?? {}).some(
            (p) => p.params?.kind === 'session',
          );
          if (!hasSession) await createFreshTab();
        } catch {
          await createFreshTab();
        }
      })();
    }
  }, []);

  const active = activeTabId ? tabs[activeTabId] : null;
  const msgBanner = useTabMsg(activeTabId, (t) => t.banner);
  const streaming = useTabMsg(activeTabId, (t) => t.streaming);

  return (
    <div className="pg-app">
      <header className="pg-titlebar">
        <button
          className="pg-btn pg-rail-toggle"
          title="切换侧栏（⌘B）"
          onClick={() => setSidebarOpen((v) => !v)}
        >
          ☰
        </button>
        <span className="pg-logo">🐷 Piggy</span>
        <ModelThinkingControls tabId={activeTabId} />
        {streaming ? <span className="pg-streaming-dot" /> : null}
        <span className={`pg-wstate pg-wstate-${active?.workerState ?? 'ready'}`}>
          {active?.workerState ?? 'ready'}
        </span>
        <button className="pg-btn" onClick={toggleTheme} title="切换主题">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      {(banner ?? msgBanner) && <div className="pg-banner">{banner ?? msgBanner}</div>}
      <div className="pg-frame">
        <Group orientation="horizontal" className="pg-group-h">
          {sidebarOpen && (
            <>
              <Panel defaultSize={20} minSize={12} maxSize={38} className="pg-pane-sidebar">
                <SessionsSidebar />
              </Panel>
              <Separator className="pg-sash" />
            </>
          )}
          <Panel minSize={30}>
            <EditorArea />
          </Panel>
          <Separator className="pg-sash" />
          <Panel defaultSize={18} minSize={12} maxSize={34}>
            <RightBar tabId={activeTabId} />
          </Panel>
        </Group>
      </div>
      <footer className="pg-statusbar">
        <span>
          {order.length} 会话 tab · {active ? active.cwd : ''}
        </span>
        <span className="pg-hint">{stats || 'M1 WP1-4'}</span>
      </footer>
      <DialogRouter />
    </div>
  );
}

async function createFreshTab() {
  try {
    const snap = await createTab({ name: '新会话' });
    ensureTabListeners(snap.tab_id);
    await openSessionTab(snap, '新会话');
  } catch (e) {
    useTabs.getState().setBanner(`启动失败：${String(e)}`);
  }
}
