/** Extension UI 请求队列（docs/02 §8）：同一 tab 串行弹窗 */
import { create } from 'zustand';

export interface UiRequest {
  id: string;
  method: string;
  [key: string]: unknown;
}

interface DialogState {
  current: UiRequest | null;
  queue: UiRequest[];
  push(req: UiRequest): void;
  next(): void;
}

export const useDialogs = create<DialogState>()((set, get) => ({
  current: null,
  queue: [],
  push(req) {
    if (!get().current) set({ current: req });
    else set((s) => ({ queue: [...s.queue, req] }));
  },
  next() {
    set((s) => {
      const [head, ...rest] = s.queue;
      return { current: head ?? null, queue: rest };
    });
  },
}));
