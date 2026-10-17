/** uiStore：主题、面板/帮助开关、状态栏槽位、扩展 Widgets、composer 草稿（docs/03 §3.2） */
import { create } from 'zustand';
import { isMock } from '@/lib/mockBackend';
import { immer } from 'zustand/middleware/immer';

export type ThemeName = 'dark' | 'light';

/** 底部面板的两个 pane（docs/04 §1.7）：真实终端 / pi 的 bash 直执行。 */
export type PanelPane = 'terminal' | 'bash';

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('pg.theme')) as ThemeName | null;

interface UiState {
  theme: ThemeName;
  toggleTheme(): void;

  paletteOpen: boolean;
  setPaletteOpen(b: boolean): void;
  helpOpen: boolean;
  setHelpOpen(b: boolean): void;

  /** 「关于 Piggy 与许可」（docs/03 §2.17）：三个入口共用一个状态 */
  aboutOpen: boolean;
  setAboutOpen(b: boolean): void;

  sidebarOpen: boolean;
  setSidebarOpen(b: boolean): void;

  /** 右栏开合（命令 `rightpanel.toggle`，⌘\；docs/04 §1.2、docs/07 §2.1）。
   *  与左栏一样**不持久化**：跨重启记忆属于 docs/04 §1.8 的"按项目记两侧栏"，
   *  等那块落地时左右一起接，不要先给右栏开一个 localStorage 的后门。 */
  rightpanelOpen: boolean;
  setRightpanelOpen(b: boolean): void;

  /**
   * 底部面板（终端 / bash）——**开合与当前 pane 都在这里**（2026-10-17）。
   *
   * 为什么从 AppFrame 的 `useState` 提上来：`Ctrl+`` / ⌘J / 会话头部那颗图标按钮 /
   * 命令面板都要能开它，而 `useState` 只有 AppFrame 自己够得着（此前靠
   * `windowEvents.emit('toggle-bash-panel')` 这条一次性事件桥）。提到 store 之后只有一份真相，
   * 门禁也能直接读状态。
   */
  panelOpen: boolean;
  panelPane: PanelPane;
  /** 开/合面板；给了 pane 就顺带切过去（已开且同 pane = 关掉，VS Code 的 Ctrl+` 同义）。 */
  togglePanel(pane?: PanelPane): void;
  setPanelPane(pane: PanelPane): void;
  setPanelOpen(open: boolean): void;

  /** extension setStatus 槽位（docs/02 §8） */
  statusSlots: Record<string, string>;
  setStatusSlot(key: string, text: string | null): void;

  /** extension setWidget（per tab，docs/02 §8；aboveEditor 语义） */
  widgets: Record<string, string[]>;
  setWidget(tabId: string, lines: string[] | null): void;

  /** composer 草稿（set_editor_text / 队列还原写入） */
  drafts: Record<string, string>;
  setDraft(tabId: string, text: string): void;
}

export const useUi = create<UiState>()(
  immer((set, get) => ({
  theme: stored ?? 'dark',
  toggleTheme() {
    const next: ThemeName = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('pg.theme', next);
    set({ theme: next });
  },

  paletteOpen: false,
  setPaletteOpen(b) {
    set({ paletteOpen: b });
  },
  helpOpen: false,
  setHelpOpen(b) {
    set({ helpOpen: b });
  },

  aboutOpen: false,
  setAboutOpen(b) {
    set({ aboutOpen: b });
  },

  sidebarOpen: true,
  setSidebarOpen(b) {
    set({ sidebarOpen: b });
  },

  rightpanelOpen: true,
  setRightpanelOpen(b) {
    set({ rightpanelOpen: b });
  },

  panelOpen: false,
  panelPane: 'terminal',
  togglePanel(pane) {
    set((s) => {
      if (pane === undefined) {
        s.panelOpen = !s.panelOpen;
        return;
      }
      if (s.panelOpen && s.panelPane === pane) {
        s.panelOpen = false;
        return;
      }
      s.panelOpen = true;
      s.panelPane = pane;
    });
  },
  setPanelPane(pane) {
    set({ panelPane: pane, panelOpen: true });
  },
  setPanelOpen(open) {
    set({ panelOpen: open });
  },

  statusSlots: {},
  setStatusSlot(key, text) {
    set((s) => {
      if (text === null) delete s.statusSlots[key];
      else s.statusSlots[key] = text;
    });
  },

  widgets: {},
  setWidget(tabId, lines) {
    set((s) => {
      if (lines === null) delete s.widgets[tabId];
      else s.widgets[tabId] = lines;
    });
  },

  drafts: {},
  setDraft(tabId, text) {
    set((s) => {
      s.drafts[tabId] = text;
    });
  },  }))
);
// mock 环境：调试钩子（Playwright/控制台可读写 UI 状态）
if (typeof window !== 'undefined' && isMock) {
  (window as unknown as Record<string, unknown>).__piggyUi = useUi;
}
