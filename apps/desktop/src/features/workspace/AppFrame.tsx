/** AppFrame（WP1，docs/04 §1）：外框 react-resizable-panels + 编辑区 dockview + bash 面板。
 *  对齐 DSH（docs/12 §1.5/§1.6）：**无自绘标题栏、无横贯底部状态栏**——
 *  品牌行在侧栏顶部，窗口级状态行在 Composer dock。 */
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useEffect, useRef } from 'react';
import { cmd } from '@/lib/ipc';
import { bootGate } from '@/lib/boot';
import { windowEvents } from '@/lib/windowEvents';
import { useAppCommands } from '@/lib/appCommands';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { HelpOverlay } from '@/features/palette/HelpOverlay';
import { BottomPanel } from './BottomPanel';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { EditorArea, closeActivePanel, openSessionTabOptimistic } from './EditorArea';
import { SessionsSidebar } from './SessionsSidebar';
import { SidebarRail } from './SidebarRail';
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

/**
 * 折叠态右栏的宽度 = 图标轨宽度（px）。
 *
 * ⚠️ **必须与 `styles.css` 的 `.pg-rightrail { width: 40px }` 同值**：折叠时 Panel 收成
 * 这么宽，里面正好只剩那条轨（内容在 RightBar 里是卸载掉的）。两处对不上就是
 * "轨被裁掉几像素"或"旁边多一条空白"——所以 `ui:startup` 右栏折叠那一段量的是
 * **真实几何**（折叠宽 === 轨宽），改了一处忘了另一处会直接变红。
 */
const RIGHT_RAIL_W = 40;

export function AppFrame() {
  useAppCommands();

  const activeTabId = useTabs((s) => s.activeTabId);
  const banner = useTabs((s) => s.banner);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const rightpanelOpen = useUi((s) => s.rightpanelOpen);
  /* 底部面板（终端 / bash）的开合在 store：`Ctrl+`` / ⌘J / 会话头部图标 / 命令面板
     都要能开它，AppFrame 只负责画几何（docs/04 §1.7）。 */
  const panelOpen = useUi((s) => s.panelOpen);
  const rightPanel = useRef<PanelImperativeHandle | null>(null);

  /* 右栏开合：store → 面板几何。
     用库自己的 `collapsible`（而不是像左栏那样条件渲染整个 Panel）有两个原因：
      ① 折叠后要**留下图标轨**，而轨就在 Panel 里面，Panel 不能整个消失；
      ② 条件增删 Panel 会让 react-resizable-panels 重新计算相邻面板索引
         （jsdom 下必抛 `Panel constraints not found for index 3`，真浏览器虽然干净，
         但没必要为同一件事养两条不同的机制）。
     按钮 / ⌘\ / 命令面板三条入口都只写 store，**这里是指挥几何的唯一一处**。 */
  useEffect(() => {
    const p = rightPanel.current;
    if (!p) return;
    if (rightpanelOpen) p.expand();
    else p.collapse();
  }, [rightpanelOpen]);

  useEffect(() => {
    void startBoot();
    const offClose = windowEvents.on('close-active-tab', () => closeActivePanel());
    return () => {
      offClose();
    };
  }, []);

  /* 这条 banner 只留给**应用级**的事（启动失败、worker 反复崩）。
      ⚠️ 会话级的状态（正在重试 / 正在压缩）**不走这里**（用户 2026-09-25："本会话内的提示，
      不要展示全局，展示在会话内即可"）—— 它们是转录里的一行（`NoticeView`），
      于是切到别的标签时不会再被别的会话的状态打扰。 */
  return (
    <div className="pg-app">
      {banner && (
        <div
          className="pg-banner"
          role={banner.startsWith('启动失败') ? 'button' : undefined}
          onClick={banner.startsWith('启动失败') ? () => retryBoot() : undefined}
          style={banner.startsWith('启动失败') ? { cursor: 'pointer' } : undefined}
          title={banner.startsWith('启动失败') ? '点击重试' : undefined}
        >
          {banner}
          {banner.startsWith('启动失败') ? '（点击重试）' : ''}
        </div>
      )}
      <div className="pg-frame">
        {/* 折叠后必须留下可点的东西：一条 56px 图标轨（DSH SIDEBAR_COLLAPSED，docs/12 §1.5）。
            此前这里是 `{sidebarOpen && <Panel>}`，折叠 = 什么都不剩 = 无处展开。 */}
        {!sidebarOpen && <SidebarRail />}
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
              {panelOpen && (
                <>
                  <Separator className="pg-sash" />
                  <Panel defaultSize="35%" minSize="12%" maxSize="75%">
                    <BottomPanel tabId={activeTabId} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          <Separator className="pg-sash" />
          <Panel
            defaultSize="18%"
            minSize="13%"
            maxSize="34%"
            collapsible
            collapsedSize={RIGHT_RAIL_W}
            collapsedThreshold={RIGHT_RAIL_W}
            panelRef={rightPanel}
            /* 面板 → store：用户拖 sash 把右栏拖到折叠阈值以下（或从折叠态拖出来）时，
               store 得跟着走。不同步的话图标按钮会说反话 —— 界面明明收起来了，
               按钮还写着"收起右栏"，点它调 collapse() 又是个空操作（已折叠），
               用户看到的是"按钮坏了"。 */
            onResize={() => {
              const collapsed = rightPanel.current?.isCollapsed() ?? false;
              const open = useUi.getState().rightpanelOpen;
              if (collapsed && open) useUi.getState().setRightpanelOpen(false);
              else if (!collapsed && !open) useUi.getState().setRightpanelOpen(true);
            }}
          >
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
    /* 启动首屏：占位标签会立刻出现（`openSessionTabOptimistic` 内部走 `createTabGuarded`
       → `ensureTab` 会装监听器），失败时由 banner 说话。 */
    await openSessionTabOptimistic({ name: '新会话' }, '新会话');
  } catch (e) {
    useTabs.getState().setBanner(`启动失败：${String(e)}`);
  }
}
