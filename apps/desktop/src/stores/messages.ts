/**
 * messagesStore v2（M1 多 tab，docs/03 §3.2）：结构态 per-tab normalized，
 * 只由 pi:commit 驱动；流式文本不进 React 状态（live 引擎直写 DOM）。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type { AgentMessage } from '@piggy/pi-protocol';

// keys 去重集合用 Set 存放（05 §4.4），immer 需启用 MapSet 插件
enableMapSet();

export interface MessageView {
  id: string;
  role: string;
  message: AgentMessage;
}

export interface TabMessages {
  byId: Record<string, MessageView>;
  ids: string[];
  /** role:timestamp 去重键集合（O(1) 查询；05 §4.4 数据结构纪律——万条会话不可 O(n²)） */
  keys: Set<string>;
  streaming: boolean;
  queue: { steering: string[]; followUp: string[] };
  toolRuns: Record<string, { toolName: string; running: boolean; isError?: boolean }>;
  banner: string | null;
  hydrated: boolean;
  /* ── 分页（docs/03 §2.19）：打开会话只载入尾部一页，往上的历史按需再读 ── */
  /** 已载入的第一行在会话文件里的字节偏移（`null` = 没有文件游标，例如退回 get_messages） */
  pageCursor: number | null;
  /** 前面还有更早的历史 */
  hasMore: boolean;
  /** 「加载更早」正在进行 */
  loadingOlder: boolean;
}

const emptyTab = (): TabMessages => ({
  byId: {},
  ids: [],
  keys: new Set(),
  streaming: false,
  queue: { steering: [], followUp: [] },
  toolRuns: {},
  banner: null,
  hydrated: false,
  pageCursor: null,
  hasMore: false,
  loadingOlder: false,
});

/** 一页的元信息（与 Rust `transcript::Page` 的 `startOffset` / `hasMore` 对齐）。 */
export interface PageMeta {
  cursor: number | null;
  hasMore: boolean;
}

interface MessagesState {
  tabs: Record<string, TabMessages>;
  ensure(tabId: string): TabMessages;
  hydrate(tabId: string, messages: AgentMessage[]): void;
  /** 打开会话的第一页（**重置**该 tab 的消息） */
  hydratePage(tabId: string, messages: AgentMessage[], meta: PageMeta): void;
  /** 更早的一页接到最前面；返回真正新增的行数（调用方据此修正滚动位置） */
  prependPage(tabId: string, messages: AgentMessage[], meta: PageMeta): number;
  setLoadingOlder(tabId: string, loading: boolean): void;
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

/**
 * 把一条消息登记进 tab；去重命中或角色不该显示时返回 `null`。
 *
 * 抽出来是为了让"追加"（新消息）与"预置"（更早的一页）走**同一套**去重键与行构造，
 * 两边各写一遍就会分叉（历史上分页最典型的 bug 就是首尾重复一行）。
 */
function register(tab: TabMessages, m: AgentMessage): string | null {
  const role = (m as { role?: string }).role;
  if (!role || role === 'system') return null;
  const key = tsKey(m);
  if (tab.keys.has(key)) return null;
  const id = nextId(role);
  tab.byId[id] = { id, role, message: m };
  tab.keys.add(key);
  return id;
}

function pushMessage(tab: TabMessages, m: AgentMessage): boolean {
  const id = register(tab, m);
  if (!id) return false;
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
        tab.keys = new Set();
        for (const m of messages) {
          pushMessage(tab, m);
        }
        tab.hydrated = true;
        // 一次性 hydrate（无文件游标的兜底路径）没有"更早"可翻
        tab.pageCursor = null;
        tab.hasMore = false;
        tab.loadingOlder = false;
      });
    },

    hydratePage(tabId, messages, meta) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.byId = {};
        tab.ids = [];
        tab.keys = new Set();
        for (const m of messages) {
          pushMessage(tab, m);
        }
        tab.hydrated = true;
        tab.pageCursor = meta.cursor;
        tab.hasMore = meta.hasMore;
        tab.loadingOlder = false;
      });
    },

    prependPage(tabId, messages, meta) {
      let added = 0;
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        const front: string[] = [];
        for (const m of messages) {
          const id = register(tab, m);
          if (!id) continue;
          front.push(id);
          added += 1;
        }
        if (front.length > 0) tab.ids = [...front, ...tab.ids];
        tab.pageCursor = meta.cursor;
        tab.hasMore = meta.hasMore;
        tab.loadingOlder = false;
      });
      return added;
    },

    setLoadingOlder(tabId, loading) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.loadingOlder = loading;
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
