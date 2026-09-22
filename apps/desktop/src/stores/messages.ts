/**
 * messagesStore v2（M1 多 tab，docs/03 §3.2）：结构态 per-tab normalized，
 * 只由 pi:commit 驱动；流式文本不进 React 状态（live 引擎直写 DOM）。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { AgentMessage } from '@piggy/pi-protocol';

export interface MessageView {
  id: string;
  role: string;
  message: AgentMessage;
}

export interface TabMessages {
  byId: Record<string, MessageView>;
  ids: string[];
  streaming: boolean;
  queue: { steering: string[]; followUp: string[] };
  toolRuns: Record<string, { toolName: string; running: boolean; isError?: boolean }>;
  banner: string | null;
  hydrated: boolean;
}

const emptyTab = (): TabMessages => ({
  byId: {},
  ids: [],
  streaming: false,
  queue: { steering: [], followUp: [] },
  toolRuns: {},
  banner: null,
  hydrated: false,
});

interface MessagesState {
  tabs: Record<string, TabMessages>;
  ensure(tabId: string): TabMessages;
  hydrate(tabId: string, messages: AgentMessage[]): void;
  applyCommit(tabId: string, ev: { type: string } & Record<string, unknown>): void;
  remove(tabId: string): void;
}

let seq = 0;
const nextId = (role: string) => `${role}-${Date.now()}-${seq++}`;

function tsKey(m: AgentMessage): string {
  const ts = (m as { timestamp?: number }).timestamp;
  return `${(m as { role?: string }).role}:${ts ?? Math.random()}`;
}

export function contentText(m: AgentMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

function pushMessage(tab: TabMessages, m: AgentMessage): boolean {
  const role = (m as { role?: string }).role;
  if (!role || role === 'system') return false;
  const key = tsKey(m);
  if (tab.ids.some((id) => tsKey(tab.byId[id]!.message) === key)) return false;
  const id = nextId(role);
  tab.byId[id] = { id, role, message: m };
  tab.ids.push(id);
  return true;
}

export const useMessages = create<MessagesState>()(
  immer((set, get) => ({
    tabs: {},

    ensure(tabId) {
      if (!get().tabs[tabId]) {
        set((s) => {
          s.tabs[tabId] = emptyTab();
        });
      }
      return get().tabs[tabId]!;
    },

    hydrate(tabId, messages) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.byId = {};
        tab.ids = [];
        for (const m of messages) {
          pushMessage(tab, m);
        }
        tab.hydrated = true;
      });
    },

    applyCommit(tabId, ev) {
      const e = ev as { type: string } & Record<string, unknown>;
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        switch (e.type) {
          case 'message_start': {
            const role = ((e as unknown as { message?: AgentMessage }).message as { role?: string })?.role;
            if (role === 'assistant') {
              // 实时块清屏由 live 引擎在渲染侧处理（转正提交即替换）
            }
            break;
          }
          case 'message_end': {
            const m = (e as unknown as { message: AgentMessage }).message;
            pushMessage(tab, m);
            break;
          }
          case 'agent_start':
            tab.streaming = true;
            break;
          case 'agent_settled':
            tab.streaming = false;
            tab.banner = null;
            break;
          case 'queue_update': {
            const q = e as unknown as { steering: string[]; followUp: string[] };
            tab.queue = { steering: [...q.steering], followUp: [...q.followUp] };
            break;
          }
          case 'tool_execution_start': {
            const t = e as unknown as { toolCallId: string; toolName: string };
            tab.toolRuns[t.toolCallId] = { toolName: t.toolName, running: true };
            break;
          }
          case 'tool_execution_end': {
            const t = e as unknown as { toolCallId: string; isError?: boolean };
            const run = tab.toolRuns[t.toolCallId];
            if (run) {
              run.running = false;
              run.isError = t.isError ?? false;
            }
            break;
          }
          case 'compaction_start':
            tab.banner = '⟳ 正在压缩上下文…';
            break;
          case 'compaction_end':
            tab.banner = null;
            break;
          case 'auto_retry_start':
            tab.banner = '↻ 自动重试中…';
            break;
          case 'auto_retry_end':
            tab.banner = null;
            break;
          case 'piggy:resync': {
            const entries =
              (e as unknown as { entries?: Array<{ type: string; message?: AgentMessage }> }).entries ?? [];
            for (const entry of entries) {
              if (entry.type !== 'message' || !entry.message) continue;
              pushMessage(tab, entry.message);
            }
            break;
          }
          default:
            break;
        }
      });
    },

    remove(tabId) {
      set((s) => {
        delete s.tabs[tabId];
      });
    },
  })),
);

/** per-tab selector hook（空态稳定引用，避免重渲染风暴） */
import { useStore } from 'zustand';
const EMPTY = emptyTab();
Object.freeze(EMPTY);
export function useTabMsg<T>(tabId: string | null, sel: (t: TabMessages) => T): T {
  return useStore(useMessages, (s) => sel((tabId ? s.tabs[tabId] : null) ?? EMPTY));
}
