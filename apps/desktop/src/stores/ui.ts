/** uiStore：主题、面板/帮助开关、状态栏槽位、扩展 Widgets、composer 草稿（docs/03 §3.2） */
import { create } from 'zustand';
import { isMock } from '@/lib/mockBackend';
import { immer } from 'zustand/middleware/immer';

export type ThemeName = 'dark' | 'light';

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('pg.theme')) as ThemeName | null;

interface UiState {
  theme: ThemeName;
  toggleTheme(): void;

  paletteOpen: boolean;
  setPaletteOpen(b: boolean): void;
  helpOpen: boolean;
  setHelpOpen(b: boolean): void;

  sidebarOpen: boolean;
  setSidebarOpen(b: boolean): void;

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

  sidebarOpen: true,
  setSidebarOpen(b) {
    set({ sidebarOpen: b });
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
