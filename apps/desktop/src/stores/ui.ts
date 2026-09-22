/** uiStore（M0 子集）：主题（完整布局状态 = M1 uiStore，docs/03 §3.2） */
import { create } from 'zustand';

export type ThemeName = 'dark' | 'light';

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('pg.theme')) as ThemeName | null;

interface UiState {
  theme: ThemeName;
  toggleTheme(): void;
}

export const useUi = create<UiState>()((set, get) => ({
  theme: stored ?? 'dark',
  toggleTheme() {
    const next: ThemeName = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('pg.theme', next);
    set({ theme: next });
  },
}));
