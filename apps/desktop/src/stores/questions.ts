/**
 * 待答提问的存放（docs/06 §7）。
 *
 * 请求与卡片分处两地：请求从 `pi:ui-req:<tab>` 事件来（`lib/tabEvents.ts`），卡片在
 * 转录的工具行里（`features/chat/QuestionCard.tsx`）。而"用户提交"要回到那个**还没被
 * 回答的请求 id** 上，所以按 `toolCallId` 存着它，等卡片来取。
 *
 * 换标签页 / 新一轮 / 回答完都要清：留着的话卡片会永远停在"等你回答"，
 * 而那个 `select` 请求早就不在了（用户点了提交只会得到一个沉默的失败）。
 */
import { create } from 'zustand';
import { parseAskTitle } from '@/lib/questionChannel';

export interface PendingQuestion {
  /** 宿主侧的请求 id（回答时原样回给 pi） */
  requestId: string;
  tabId: string;
  /** 插件说要问的那个工具调用（卡片按它对上号） */
  toolCallId: string;
}

interface QuestionState {
  /** toolCallId → 待答请求 */
  pending: Record<string, PendingQuestion>;
  /** 认信封：是提问卡的 select 就登记，返回 true（调用方**不要**再弹普通选择框） */
  accept(req: { id: string; method: string; title?: unknown }, tabId: string): boolean;
  /** 取待答请求（卡片用） */
  get(toolCallId: string): PendingQuestion | undefined;
  /** 回答完了 / 这一轮结束了：忘掉它 */
  settle(toolCallId: string): void;
  /** 换标签页或新一轮时清掉这个 tab 的待答请求 */
  clearTab(tabId: string): void;
}

export const useQuestions = create<QuestionState>()((set, get) => ({
  pending: {},

  accept(req, tabId) {
    const toolCallId = parseAskTitle(req.title);
    if (toolCallId === null) return false;
    set((s) => ({
      pending: { ...s.pending, [toolCallId]: { requestId: req.id, tabId, toolCallId } },
    }));
    return true;
  },

  get(toolCallId) {
    return get().pending[toolCallId];
  },

  settle(toolCallId) {
    set((s) => {
      if (!(toolCallId in s.pending)) return s;
      const next = { ...s.pending };
      delete next[toolCallId];
      return { pending: next };
    });
  },

  clearTab(tabId) {
    set((s) => {
      const next: Record<string, PendingQuestion> = {};
      for (const [id, p] of Object.entries(s.pending)) if (p.tabId !== tabId) next[id] = p;
      return { pending: next };
    });
  },
}));
