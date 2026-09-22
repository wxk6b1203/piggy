/**
 * messagesStore（docs/03 §3.2）：结构态 normalized，只由 pi:commit 驱动（低频权威）。
 * 流式文本不进 React 状态（live 引擎直写 DOM，docs/04 §4）。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { AgentMessage, PiEvent } from '@piggy/pi-protocol';

export interface MessageView {
  id: string;
  role: string;
  message: AgentMessage;
}

interface MessagesState {
  byId: Record<string, MessageView>;
  ids: string[];
  streaming: boolean;
  queue: { steering: string[]; followUp: string[] };
  toolRuns: Record<string, { toolName: string; running: boolean; isError?: boolean }>;
  banner: string | null;
  hydrated: boolean;

  hydrate(messages: AgentMessage[]): void;
  applyCommit(ev: { type: string } & Record<string, unknown>): void;
  setStreaming(b: boolean): void;
}

let seq = 0;
const nextId = (role: string) => `${role}-${Date.now()}-${seq++}`;

function tsKey(m: AgentMessage): string {
  const ts = (m as { timestamp?: number }).timestamp;
  return `${(m as { role?: string }).role}:${ts ?? Math.random()}`;
}

function contentText(m: AgentMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

export const useMessages = create<MessagesState>()(
  immer((set, get) => ({
    byId: {},
    ids: [],
    streaming: false,
    queue: { steering: [], followUp: [] },
    toolRuns: {},
    banner: null,
    hydrated: false,

    hydrate(messages) {
      set((s) => {
        s.byId = {};
        s.ids = [];
        for (const m of messages) {
          const id = nextId((m as { role?: string }).role ?? 'msg');
          s.byId[id] = { id, role: (m as { role?: string }).role ?? 'msg', message: m };
          s.ids.push(id);
        }
        s.hydrated = true;
      });
    },

    applyCommit(ev) {
      const e = ev as PiEvent & { type: string };
      switch (e.type) {
        case 'message_start': {
          const role = ((e as unknown as { message?: AgentMessage }).message as { role?: string })?.role;
          if (role === 'assistant') {
            // 新 assistant 消息开始：live 块清屏（docs/04 §4.3）
            import('@/lib/live').then(({ live }) => live.reset());
          }
          break;
        }
        case 'message_end': {
          const m = (e as unknown as { message: AgentMessage }).message;
          const role = (m as { role?: string }).role;
          if (!role || role === 'system') break;
          const key = tsKey(m);
          // 去重：同 role+timestamp 已存在则跳过（M0 契约：message_end 权威且可能重复，docs/02 §7.5）
          if (get().ids.some((id) => tsKey(get().byId[id]!.message) === key)) break;
          set((s) => {
            const id = nextId(role);
            s.byId[id] = { id, role, message: m };
            s.ids.push(id);
          });
          break;
        }
        case 'agent_start':
          set((s) => {
            s.streaming = true;
          });
          break;
        case 'agent_settled':
          set((s) => {
            s.streaming = false;
            s.banner = null;
          });
          break;
        case 'queue_update': {
          const q = e as unknown as { steering: string[]; followUp: string[] };
          set((s) => {
            s.queue = { steering: [...q.steering], followUp: [...q.followUp] };
          });
          break;
        }
        case 'tool_execution_start': {
          const t = e as unknown as { toolCallId: string; toolName: string };
          set((s) => {
            s.toolRuns[t.toolCallId] = { toolName: t.toolName, running: true };
          });
          break;
        }
        case 'tool_execution_end': {
          const t = e as unknown as { toolCallId: string; isError?: boolean };
          set((s) => {
            const run = s.toolRuns[t.toolCallId];
            if (run) {
              run.running = false;
              run.isError = t.isError ?? false;
            }
          });
          break;
        }
        case 'compaction_start':
          set((s) => {
            s.banner = '⟳ 正在压缩上下文…';
          });
          break;
        case 'compaction_end':
          set((s) => {
            s.banner = null;
          });
          break;
        case 'auto_retry_start':
          set((s) => {
            s.banner = '↻ 自动重试中…';
          });
          break;
        case 'auto_retry_end':
          set((s) => {
            s.banner = null;
          });
          break;
        case 'piggy:resync': {
          // 崩溃复活游标补齐（docs/02 §7.5）：合并未见过的条目
          const entries = (e as unknown as { entries?: Array<{ type: string; message?: AgentMessage }> })
            .entries ?? [];
          set((s) => {
            for (const entry of entries) {
              if (entry.type !== 'message' || !entry.message) continue;
              const m = entry.message;
              const role = (m as { role?: string }).role;
              if (!role || role === 'system') continue;
              const key = tsKey(m);
              if (s.ids.some((id) => tsKey(s.byId[id]!.message) === key)) continue;
              const id = nextId(role);
              s.byId[id] = { id, role, message: m };
              s.ids.push(id);
            }
          });
          break;
        }
        default:
          break;
      }
    },

    setStreaming(b) {
      set((s) => {
        s.streaming = b;
      });
    },
  })),
);

export { contentText };
