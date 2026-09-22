/** bash 面板输出缓冲（WP8） */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface BashState {
  output: Record<string, string>;
  append(tabId: string, delta: string): void;
  clear(tabId: string): void;
}

export const useBash = create<BashState>()(
  immer((set) => ({
  output: {},
  append(tabId, delta) {
    set((s) => {
      s.output[tabId] = (s.output[tabId] ?? '') + delta;
    });
  },
  clear(tabId) {
    set((s) => {
      delete s.output[tabId];
    });
  },  }))
);