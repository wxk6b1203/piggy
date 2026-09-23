/** AppFrame（WP1，docs/04 §1）：外框 react-resizable-panels + 编辑区 dockview + bash 面板。
 *  对齐 DSH（docs/12 §1.5/§1.6）：**无自绘标题栏、无横贯底部状态栏**——
 *  品牌行在侧栏顶部，窗口级状态行在 Composer dock。 */
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useEffect, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { bootGate } from '@/lib/boot';
import { ensureTabListeners } from '@/lib/tabEvents';
import { windowEvents } from '@/lib/windowEvents';
import { useAppCommands } from '@/lib/appCommands';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { HelpOverlay } from '@/features/palette/HelpOverlay';
import { BashPanel } from './BashPanel';
import { useTabMsg } from '@/stores/messages';
import { useTabs, createTab } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { EditorArea, closeActivePanel, openSessionTab } from './EditorArea';
import { SessionsSidebar } from './SessionsSidebar';
import { RightBar } from './RightBar';
import { DialogRouter } from '@/features/dialogs/DialogRouter';

// boot 单例挂 globalThis：HMR 重载本模块时保活（模块级变量会被重置 → boot 重跑 → tab 重复创建）
interface PiggyBootGlobals {
  __piggyBootPromise?: Promise<void>;
}
const bg = globalThis as unknown as PiggyBootGlobals;

/** 启动流程（单例；StrictMode/HMR/重试安全） */
function startBoot(): Promise<void> {
  if (bg.__piggyBootPromise) return bg.__piggyBootPromise;
  bg.__piggyBootPromise = (async () => {
    // 单窗口语义：新 JS 上下文接管前，收割上一上下文的孤儿 worker（docs/02 §7.5）。
    // 该收割是**闸门**：createTab 也 await 它，否则恢复布局建的 tab 会被它关掉（lib/boot.ts）。
    await bootGate();
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
      bg.__piggyBootPromise = undefined;
      await createFreshTab();
    }
  })();
  return bg.__piggyBootPromise;
}

/** pi 二进制缺失等启动失败后的重试入口（横幅按钮，docs/02 §2.1） */
export function retryBoot() {
  bg.__piggyBootPromise = undefined;
  void startBoot();
}

/** @internal 仅供测试 */
export function resetBootForTest() {
  bg.__piggyBootPromise = undefined;
}

export function AppFrame() {
  useAppCommands();

  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const banner = useTabs((s) => s.banner);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const [bashOpen, setBashOpen] = useState(false);

  useEffect(() => {
    void startBoot();
    const offBash = windowEvents.on('toggle-bash-panel', () => setBashOpen((v: boolean) => !v));
    const offClose = windowEvents.on('close-active-tab', () => closeActivePanel());
    return () => {
      offBash();
      offClose();
    };
  }, []);

  const msgBanner = useTabMsg(activeTabId, (t) => t.banner);

  return (
    <div className="pg-app">
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
      <DialogRouter />
      <CommandPalette />
      <HelpOverlay />
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
