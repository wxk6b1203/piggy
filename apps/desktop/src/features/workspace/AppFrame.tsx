/** AppFrame（WP1，docs/04 §1）：外框 react-resizable-panels + 编辑区 dockview + bash 面板 + 状态栏 */
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useEffect, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { ensureTabListeners } from '@/lib/tabEvents';
import { windowEvents } from '@/lib/windowEvents';
import { useAppCommands } from '@/lib/appCommands';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { HelpOverlay } from '@/features/palette/HelpOverlay';
import { BashPanel } from './BashPanel';
import { useTabMsg } from '@/stores/messages';
import { useTabs, createTab } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { EditorArea, openSessionTab } from './EditorArea';
import { SessionsSidebar } from './SessionsSidebar';
import { RightBar } from './RightBar';
import { ModelThinkingControls } from './ModelThinking';
import { DialogRouter } from '@/features/dialogs/DialogRouter';

let bootPromise: Promise<void> | null = null;

/** 启动流程（单例；StrictMode/重试安全） */
function startBoot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // 单窗口语义：新 JS 上下文接管前，收割上一上下文的孤儿 worker（docs/02 §7.5）
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
      bootPromise = null;
      await createFreshTab();
    }
  })();
  return bootPromise;
}

/** pi 二进制缺失等启动失败后的重试入口（横幅按钮，docs/02 §2.1） */
export function retryBoot() {
  bootPromise = null;
  void startBoot();
}

/** @internal 仅供测试 */
export function resetBootForTest() {
  bootPromise = null;
}

export function AppFrame() {
  useAppCommands();

  const tabs = useTabs((s) => s.tabs);
  const order = useTabs((s) => s.order);
  const activeTabId = useTabs((s) => s.activeTabId);
  const banner = useTabs((s) => s.banner);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const [bashOpen, setBashOpen] = useState(false);

  useEffect(() => {
    void startBoot();
    const off = windowEvents.on('toggle-bash-panel', () => setBashOpen((v: boolean) => !v));
    return off;
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
          onClick={() => setSidebarOpen(!sidebarOpen)}
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
      {(banner ?? msgBanner) && (
        <div
          className="pg-banner"
          role={banner?.startsWith('启动失败') ? 'button' : undefined}
          onClick={banner?.startsWith('启动失败') ? () => retryBoot() : undefined}
          style={banner?.startsWith('启动失败') ? { cursor: 'pointer' } : undefined}
          title={banner?.startsWith('启动失败') ? '点击重试' : undefined}
        >
          {banner ?? msgBanner}
          {banner?.startsWith('启动失败') ? '（点击重试）' : ''}
        </div>
      )}
      <div className="pg-frame">
        <Group orientation="horizontal" className="pg-group-h">
          {sidebarOpen && (
            <>
              <Panel defaultSize="20%" minSize="13%" maxSize="38%" className="pg-pane-sidebar">
                <SessionsSidebar />
              </Panel>
              <Separator className="pg-sash" />
            </>
          )}
          <Panel minSize="40%">
            <Group orientation="vertical" className="pg-group-v">
              <Panel minSize="30%">
                <EditorArea />
              </Panel>
              {bashOpen && (
                <>
                  <Separator className="pg-sash" />
                  <Panel defaultSize="35%" minSize="15%" maxSize="75%">
                    <BashPanel tabId={activeTabId} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          <Separator className="pg-sash" />
          <Panel defaultSize="18%" minSize="13%" maxSize="34%">
            <RightBar tabId={activeTabId} />
          </Panel>
        </Group>
      </div>
      <footer className="pg-statusbar">
        <span>
          {order.length} 会话 tab · {active ? active.cwd : ''}
        </span>
        <StatusSlots />
        <span className="pg-hint">M1 WP1–8</span>
      </footer>
      <DialogRouter />
      <CommandPalette />
      <HelpOverlay />
    </div>
  );
}

function StatusSlots() {
  const slots = useUi((s) => s.statusSlots);
  const entries = Object.entries(slots);
  if (entries.length === 0) return null;
  return (
    <span className="pg-status-slots">
      {entries.map(([k, v]) => (
        <span key={k} className="pg-status-slot" title={k}>
          {v}
        </span>
      ))}
    </span>
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
