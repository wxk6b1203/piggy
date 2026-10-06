/**
 * messagesStore v2（M1 多 tab，docs/03 §3.2）：结构态 per-tab normalized。
 *
 * ## 流式的文本也在这里（2026-09-24 重整）
 *
 * 早先流式文本走 `lib/live` 的 DOM 引擎：帧直接 `appendData` 进一个 `[data-live]`
 * 节点，绕过 React。那条路带来三类**结构性**错误，全部实测复现过（见
 * `src/test/transcript-live.test.tsx`）：
 *
 * ① **两套渲染器 = 内容出现两遍**。提交（`message_end`）把权威消息交给本 store
 *    由 React 再渲染一次，而 DOM 引擎里那一份不会自己消失 —— 用户看到"思考/运行命令
 *    先逐步长出来，最后又打印一遍"（截图里同一行连着出现两次）。
 * ② **块按 `contentIndex` 编号，而它在 pi 里是**每条助手消息**内重新从 0 开始的**
 *    （`AssistantMessageEvent.contentIndex`）。一轮里第二条助手消息的思考被追加进
 *    第一条的思考行（两段文字连成一句），它的工具调用被追加进第一条的工具行 ——
 *    界面上是"错乱"，还**静默吃掉**一个工具行。
 * ③ 节点身份依赖（`attach`/`detach`、虚拟化卸载、dockview 摘 DOM）本身就是一堆补丁。
 *
 * 现在的模型与 DSH 同构（`ui-conversation` 的 assistant Definition）：**流式的这一行
 * 就是转录里的那一行**。`message_start` 建一个 `live` 槽位的占位行并进 `ids`；
 * 帧按 `contentIndex` 往槽位里累加；`message_end` 只把 `message` 换成权威内容、
 * 清掉 `live` —— **行的 id 与下标都不变**，于是 React 不重建组件、不重排、不重复。
 *
 * 代价是"更新不再只来自 pi:commit"（本条注释取代了旧口径）：帧会改 store。它是安全的，
 * 因为 ① 写入只发生在 `pendingId` 那一行的 `live.blocks` 上，`ids` 身份不动；
 * ② 每帧的订阅面只有那一行（选择器返回自己那一行的切片，其余行引用不变 → 不重渲染）。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type { AgentMessage, Frame } from '@piggy/pi-protocol';
import { diffTotals, patchOfResult } from '@/lib/diff';
import type { OutlineTurn } from '@/features/chat/turnRailItems';

// keys 去重集合用 Set 存放（05 §4.4），immer 需启用 MapSet 插件
enableMapSet();

/**
 * 一个**流式块**：`contentIndex` 槽位里的累积内容。
 *
 * `kind` 由块边界信号（`text_start` / `thinking_start` / `toolcall_start`）定，
 * 之后同一槽位的 delta 只往 `text` 里追加。工具块的 `text` 是**参数 JSON 原文**
 * （不是给人看的正文）：够完整时解析进 `args`，行摘要与提交行走同一个 `toolRowModel`。
 */
export interface LiveBlock {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  /** 工具块：`toolcall_start` 给的名字与调用 id */
  toolName?: string;
  toolCallId?: string;
  /** 工具块：参数 JSON 解析成功后的对象（半截不解析，见 {@link parseToolArgs}） */
  args?: Record<string, unknown>;
  /** 上次尝试解析时的（trimEnd 后）长度：避免每帧 `JSON.parse` 同一个半截串 */
  argsLength?: number;
}

/** 工具结果（`toolResult` 消息索引；工具行要拿它和调用配对）。 */
export interface ToolResultView {
  toolName: string;
  text: string;
  isError: boolean;
  /**
   * 这条结果改动了几行（`+added/−removed`，来自 `details.patch` 的 hunk）。
   * 不是文件改动（bash / read…）或没有 patch（pi 的 `write`）就是 `null` —— 不臆造 0。
   */
  changed?: { added: number; removed: number } | null;
  /**
   * 结果的结构化副产品（pi `ToolResultMessage.details`）。
   *
   * 为什么要留着它：`edit` 工具把**实际落盘的改动**放在这里
   * （`{ diff, patch, firstChangedLine }`，pi `core/tools/edit.ts`），
   * 而正文只有一句"Applied 1 edit to …"。界面要显示 diff，只能从这儿拿 ——
   * 从调用参数（`edits[].oldText/newText`）自己算一遍是**猜**：
   * 模糊匹配、行尾归一化、`replace_all` 之后真正的结果都可能与参数不同。
   */
  details?: unknown;
}

/**
 * 会话内提示行（用户 2026-09-25："本会话内的提示，比如重试中这种，不要展示全局，
 * 展示在会话内即可"）。
 *
 * DSH 里这两件事本来就是**对话流里的节点**：模型重试是 `model-retry` 节点
 * （`MessageItem.tsx` 的 `ModelRetryItem`），压缩是压缩标记行 / 运行中的
 * `GenericCommandCard`。Piggy 此前把它做成一条**全局 banner**（挂在应用顶部 +
 * 输入框上方），于是一边在看别的标签、别的会话，一边被"A 会话正在重试"打扰。
 *
 * 现在它是一行**真实的行**（进 `ids`/`byId`）：位置、间距、虚拟化、跟随都与别的行一致，
 * 而且只出现在**它所属的那个会话**里。
 */
export interface NoticeView {
  kind: 'retry' | 'compaction';
  /** 重试：第几次 / 上限 / 这次等了多久（pi `auto_retry_start` 的字段） */
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  /** 重试：上一次失败的原因（pi `errorMessage`） */
  errorMessage?: string;
  /** 压缩：触发原因（`manual` / `threshold`） */
  reason?: string;
}

export interface MessageView {
  id: string;
  role: string;
  message: AgentMessage;
  /**
   * 这一行在会话文件里的起始字节偏移。
   * 分页读来的行带偏移（刻度梯靠它把"轮次轮廓"和"已载入的行"对上）；
   * 实时 `pi:commit` 追加的行没有 → `null`。
   */
  offset: number | null;
  /**
   * **流式中**这一行的槽位（`contentIndex` → 块）。只有 `pendingId` 那一行有；
   * 转正时清掉，行本身留在原位（同一个 id、同一个下标）。
   */
  live?: (LiveBlock | undefined)[];
  /** 会话内提示行（`role === 'notice'`）：见 {@link NoticeView} */
  notice?: NoticeView;
}

/**
 * 参数 JSON 够完整才解析（半截 `{"comm` 不解析）。
 *
 * 判据是"以 `}` 结尾"且长度变了：前者说明括号可能闭合了，后者避免每帧重解析
 * 同一个半截串（流式时同一槽位每 16ms 就被追加一次）。
 */
function parseToolArgs(block: LiveBlock): void {
  if (block.kind !== 'tool') return;
  const trimmed = block.text.trimEnd();
  if (!trimmed.endsWith('}') || trimmed.length === block.argsLength) return;
  block.argsLength = trimmed.length;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      block.args = parsed as Record<string, unknown>;
    }
  } catch {
    // 半截 JSON（还能再长）：留着下一次
  }
}

/**
 * 一页里的一行（`session_page` 的返回形状）。
 * 也接受裸消息（老测试与 `get_messages` 兜底路径）——见 {@link rowMessage}。
 */
export type PageRow = AgentMessage | { role?: string; message: AgentMessage; offset?: number | null };

/** 从 `PageRow` 里取出真正的消息对象。 */
function rowMessage(row: PageRow): AgentMessage {
  const inner = (row as { message?: unknown }).message;
  if (inner && typeof inner === 'object') return inner as AgentMessage;
  return row as AgentMessage;
}

/** 从 `PageRow` 里取出偏移（裸消息 → `null`）。 */
function rowOffset(row: PageRow): number | null {
  const off = (row as { offset?: unknown }).offset;
  return typeof off === 'number' ? off : null;
}

export interface TabMessages {
  byId: Record<string, MessageView>;
  ids: string[];
  /** role:timestamp 去重键集合（O(1) 查询；05 §4.4 数据结构纪律——万条会话不可 O(n²)） */
  keys: Set<string>;
  streaming: boolean;
  queue: { steering: string[]; followUp: string[] };
  toolRuns: Record<string, { toolName: string; running: boolean; isError?: boolean }>;
  /**
   * 工具调用索引：`toolCallId → { name, args }`。
   *
   * 为什么需要它：工具**结果**行只带 `toolCallId` / `toolName`，**参数在上一条助手消息里**
   * （`content: [{type:'toolCall', id, name, arguments}]`）。DSH 的窄行是
   * `运行命令 · pnpm test` —— 摘要取自**调用参数**（`tool-call-model.ts` 的 `SUMMARY_KEYS`），
   * 所以必须在某一层把两者 join 起来。放在 store（`register()` 是**所有**行的唯一入口：
   * hydrate / 分页 / 实时 commit 都经过它）比在渲染层每次重算省事，也不会漏路径。
   */
  toolCalls: Record<string, { name: string; args?: Record<string, unknown> }>;
  /**
   * 工具结果索引：`toolCallId → 结果`。
   *
   * 与 {@link TabMessages.toolCalls} 对称：助手消息里的 `toolCall` 块渲染成**一行**
   * （`ToolRow`/`TodoRow`），结果到达时**并进那一行**（`text`/`isError` 就地更新），
   * 而不是另起一行。于是"运行命令 · pnpm test"从工具名到达那一刻就在，一直活到结果落地
   * —— DSH 的工具行就是这个生命周期（`tool.ts` 的 `match` 从第一个具名 delta 建行，
   * 结果到达只改 `status`，React key 不变、不重挂）。
   */
  toolResults: Record<string, ToolResultView>;
  /** 正在流式的那一行（`byId` 里的 id）；没有就是 `null` */
  pendingId: string | null;
  /**
   * **权威内容的版本号**：只在 `pi:commit` 时 +1（帧不动它）。
   *
   * 给"从 store 现算一遍"的派生值当依赖用（例如 `todoBaselines` 要顺着消息扫一遍）。
   * 用它而不是订阅 `byId`：流式时 `byId` 每 16ms 换一次引用，订阅它等于让转录每帧重渲染。
   */
  commitSeq: number;
  hydrated: boolean;
  /* ── 分页（docs/03 §2.19）：打开会话只载入尾部一页，往上的历史按需再读 ── */
  /** 已载入的第一行在会话文件里的字节偏移（`null` = 没有文件游标，例如退回 get_messages） */
  pageCursor: number | null;
  /** 前面还有更早的历史 */
  hasMore: boolean;
  /** 「加载更早」正在进行 */
  loadingOlder: boolean;
  /** 已载入窗口的**读完位置**（向下续页的游标；`null` = 没有） */
  windowEnd: number | null;
  /** 「继续往下」正在进行 */
  loadingNewer: boolean;
  /**
   * 已载入窗口**下面**还有更新的内容（换窗之后为 true，回到最新后为 false）。
   * 换窗（跳到很久以前的那一轮）时旧窗口被丢掉，所以中间那段不在内存里 ——
   * 这正是"跳一次不会把整段历史读进来"的关键（docs/03 §2.19）。
   */
  hasNewer: boolean;
  /**
   * 整段会话的轮次轮廓（`session_outline`，docs/03 §2.19）：
   * 刻度梯据此画出**全部**轮次，已载入的那些再被真实行覆盖。
   * `null` = 没有轮廓（没有会话文件 / 读不出来）→ 刻度只画已载入的部分。
   */
  outline: OutlineTurn[] | null;
}

const emptyTab = (): TabMessages => ({
  byId: {},
  ids: [],
  keys: new Set(),
  streaming: false,
  queue: { steering: [], followUp: [] },
  toolRuns: {},
  toolCalls: {},
  toolResults: {},
  pendingId: null,
  commitSeq: 0,
  hydrated: false,
  pageCursor: null,
  hasMore: false,
  loadingOlder: false,
  windowEnd: null,
  loadingNewer: false,
  hasNewer: false,
  outline: null,
});

/** 一页的元信息（与 Rust `transcript::Page` 的 `startOffset` / `hasMore` 对齐）。 */
export interface PageMeta {
  cursor: number | null;
  hasMore: boolean;
  /** 换窗时为 true（后面还有更新的内容，界面给「回到最新」）。缺省沿用当前值。 */
  hasNewer?: boolean;
  /** 本页读完位置（向下续页游标）。缺省沿用当前值。 */
  end?: number | null;
}

interface MessagesState {
  tabs: Record<string, TabMessages>;
  ensure(tabId: string): TabMessages;
  hydrate(tabId: string, messages: AgentMessage[]): void;
  /** 打开会话的第一页（**重置**该 tab 的消息） */
  hydratePage(tabId: string, rows: PageRow[], meta: PageMeta): void;
  /** 更早的一页接到最前面；返回真正新增的行数（调用方据此修正滚动位置） */
  prependPage(tabId: string, rows: PageRow[], meta: PageMeta): number;
  setLoadingOlder(tabId: string, loading: boolean): void;
  setLoadingNewer(tabId: string, loading: boolean): void;
  /** 向下续页：更**新**的一页接到最后面；返回真正新增的行数 */
  appendPage(tabId: string, rows: PageRow[], meta: { end: number; hasNewer: boolean }): number;
  /** 整段会话的轮次轮廓（刻度梯用；`null` = 没有） */
  setOutline(tabId: string, turns: OutlineTurn[] | null): void;
  /** 一帧流式数据（`pi:frame`）：往**流式那一行**的槽位里累加 */
  applyFrame(tabId: string, frame: Frame): void;
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
/** 助手消息里的 `toolCall` 块 → `toolCalls` 索引（工具行摘要要用调用参数，见类型注释）。 */
function indexToolCalls(tab: TabMessages, m: AgentMessage): void {
  const content = (m as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (b?.type !== 'toolCall' || !b.id) continue;
    const args =
      b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments)
        ? (b.arguments as Record<string, unknown>)
        : undefined;
    tab.toolCalls[b.id] = { name: b.name ?? '', args };
  }
}

/** `toolResult` 消息 → `toolResults` 索引（工具行就地把结果接上，见类型注释）。 */
function indexToolResult(tab: TabMessages, m: AgentMessage): void {
  const r = m as {
    toolCallId?: string;
    toolName?: string;
    content?: unknown;
    isError?: boolean;
    details?: unknown;
  };
  if (!r.toolCallId) return;
  /* 改动统计**在索引时算一次**（不是在每次渲染时算）：patch 解析是纯字符串扫描，
     一条结果只付一次；渲染层只读 `changed`。 */
  const patch = patchOfResult(r.toolName ?? '', r.details);
  tab.toolResults[r.toolCallId] = {
    toolName: r.toolName ?? '',
    text: contentText(m),
    isError: r.isError === true,
    details: r.details,
    changed: patch ? diffTotals(patch.hunks) : null,
  };
}

/**
 * 把一条消息登记进 tab；去重命中、角色不该显示、**或者它的结果已经并进调用行**时返回 `null`。
 *
 * 抽出来是为了让"追加"（新消息）与"预置"（更早的一页）走**同一套**去重键与行构造，
 * 两边各写一遍就会分叉（历史上分页最典型的 bug 就是首尾重复一行）。
 *
 * 工具结果**不单独成行**：它属于上一条助手消息里那个 `toolCall` 块（那一行已经在了，
 * 只是还没有结果）。只有调用**不在当前窗口**里时（分页从半途开始、`get_messages` 兜底
 * 路径）才退化成单独一行 —— 那时没有别的地方能显示它。
 */
function register(tab: TabMessages, m: AgentMessage, offset: number | null = null): string | null {
  const role = (m as { role?: string }).role;
  if (!role || role === 'system') return null;
  // 索引先做：即使这条消息因为去重被丢掉（例如重载同一页），调用参数也已经在表里
  if (role === 'assistant') indexToolCalls(tab, m);
  const key = tsKey(m);
  if (tab.keys.has(key)) return null;
  tab.keys.add(key);
  if (role === 'toolResult') {
    const callId = (m as { toolCallId?: string }).toolCallId;
    indexToolResult(tab, m);
    if (callId && tab.toolCalls[callId]) return null; // 并进调用行
  }
  const id = nextId(role);
  tab.byId[id] = { id, role, message: m, offset };
  return id;
}

function pushMessage(tab: TabMessages, m: AgentMessage): boolean {
  const id = register(tab, m);
  if (!id) return false;
  tab.ids.push(id);
  return true;
}

/** 追加一页里的一行（带文件偏移，刻度梯要用）。 */
function pushRow(tab: TabMessages, row: PageRow): boolean {
  const id = register(tab, rowMessage(row), rowOffset(row));
  if (!id) return false;
  tab.ids.push(id);
  return true;
}

/**
 * 提示行的行 id：**每类提示只占一行**（`notice:<kind>`）。
 *
 * 重试会连着来好几次（`auto_retry_start` 每次都发），压缩也可能反复触发；
 * 每次都 push 一行的话，转录尾部会堆出一串"正在重试"的化石。
 * 用固定 id 就地改内容：行还在原位，React 也不重建组件。
 */
const NOTICE_ID: Record<NoticeView['kind'], string> = {
  retry: 'notice:retry',
  compaction: 'notice:compaction',
};

/** 建/改一条提示行（已经在就改内容，不新增行、不改下标）。 */
function pushNotice(tab: TabMessages, notice: NoticeView): void {
  const id = NOTICE_ID[notice.kind];
  const row = tab.byId[id];
  if (row) {
    row.notice = notice;
    return;
  }
  tab.byId[id] = {
    id,
    role: 'notice',
    // 这一行的"消息"是空的：它表达的是**正在进行的状态**，不是会话内容
    message: { role: 'notice' } as unknown as AgentMessage,
    offset: null,
    notice,
  };
  tab.ids.push(id);
}

/** 撤掉一条提示行（结束/成功/取消都走这里：它只表示"正在…"）。 */
function dropNotice(tab: TabMessages, kind: NoticeView['kind']): void {
  const id = NOTICE_ID[kind];
  if (!tab.byId[id]) return;
  delete tab.byId[id];
  tab.ids = tab.ids.filter((x) => x !== id);
}

/**
 * 换整页（打开会话 / 换窗 / 退回 `get_messages`）：行、去重键与**两个索引**一起重置。
 *
 * 索引必须跟着清：`toolCalls` 是"这个调用在窗口里"的判据（`register` 靠它决定
 * 工具结果并进哪一行）。留着上一窗口的条目，换窗之后那些"调用不在窗口里"的结果行
 * 会被误判成"已经并过了"而**整行消失**（分页 + 工具密集的会话里必现）。
 */
function resetRows(tab: TabMessages): void {
  tab.byId = {};
  tab.ids = [];
  tab.keys = new Set();
  tab.toolCalls = {};
  tab.toolResults = {};
  tab.pendingId = null;
}

/**
 * 流式槽位 → 内容块（只在"这一轮没有正常转正"这种异常路径上用，见 {@link beginPending}）。
 *
 * 形状与 pi 的 `AssistantMessage.content` 对齐，于是它可以原样交给 `MessageView` 渲染。
 */
function materializeLive(blocks: readonly (LiveBlock | undefined)[]): unknown[] {
  const out: unknown[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.kind === 'text') out.push({ type: 'text', text: b.text });
    else if (b.kind === 'thinking') out.push({ type: 'thinking', thinking: b.text });
    else out.push({ type: 'toolCall', id: b.toolCallId ?? '', name: b.toolName ?? 'tool', arguments: b.args ?? {} });
  }
  return out;
}

/**
 * 开一条流式的助手行（`message_start`）：占位内容 + `live` 槽位，**行立即进 `ids`**。
 *
 * 行进得早是这套模型的关键：`message_end` 转正时只是把 `message` 换掉、`live` 清掉，
 * id 与下标都不动，于是 React 不重挂、不重排（DSH 的 `assistant-step` 同构：
 * 流式与落定是同一个 node，只有 `status` 变）。
 */
function beginPending(tab: TabMessages, m: AgentMessage): void {
  // 上一轮如果还留着没转正的行（掉了 message_end）：把它**就地落定**（内容照用户看到的存下来）
  // 再开新的一行 —— 直接丢掉等于把已经显示出来的字吃掉。
  const staleId = tab.pendingId;
  const stale = staleId ? tab.byId[staleId] : undefined;
  if (stale) {
    stale.message = {
      role: 'assistant',
      content: materializeLive(stale.live ?? []),
      timestamp: (stale.message as { timestamp?: number }).timestamp,
    } as AgentMessage;
    delete stale.live;
    tab.pendingId = null;
  }
  const id = nextId('assistant');
  tab.byId[id] = {
    id,
    role: 'assistant',
    message: { ...(m ?? {}), role: 'assistant', content: [] } as AgentMessage,
    offset: null,
    live: [],
  };
  tab.ids.push(id);
  tab.pendingId = id;
}

/**
 * 转正（`message_end`）：把权威消息放进**同一行**，清掉流式槽位。
 *
 * @returns 是否吃掉了这一条（`true` = 已经落在 pending 行上，调用方不要再新增一行）
 */
function finishPending(tab: TabMessages, m: AgentMessage): boolean {
  const id = tab.pendingId;
  const row = id ? tab.byId[id] : undefined;
  if (!row) return false;
  row.message = m;
  delete row.live;
  tab.pendingId = null;
  /* 顺手补两件 `register()` 会做的事：**调用索引**与**去重键**。流式那一行是
     `beginPending` 建的、没走过 `register`，少了这两步会出两种错：
       · 没有 `toolCalls[callId]` → 随后的 `toolResult` 被当成"调用不在窗口里"，
         于是**又**渲染出一行工具行（同一个调用出现两行）；
       · 没有去重键 → 重载同一页（换窗回来 / resync）时这一条会再插一次。 */
  indexToolCalls(tab, m);
  tab.keys.add(tsKey(m));
  return true;
}

/** 撤掉流式的这一行（resync / 换整页这类"权威数据要重来"的路径用它）。 */
function dropPending(tab: TabMessages): void {
  const id = tab.pendingId;
  if (!id) return;
  delete tab.byId[id];
  tab.ids = tab.ids.filter((rowId) => rowId !== id);
  tab.pendingId = null;
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
        resetRows(tab);
        for (const m of messages) {
          pushMessage(tab, m);
        }
        tab.hydrated = true;
        // 一次性 hydrate（无文件游标的兜底路径）没有"更早"可翻，也没有"更新"可言
        tab.pageCursor = null;
        tab.hasMore = false;
        tab.hasNewer = false;
        tab.windowEnd = null;
        tab.loadingOlder = false;
        tab.loadingNewer = false;
        tab.outline = null;
      });
    },

    hydratePage(tabId, rows, meta) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        resetRows(tab);
        for (const row of rows) {
          pushRow(tab, row);
        }
        tab.hydrated = true;
        tab.pageCursor = meta.cursor;
        tab.hasMore = meta.hasMore;
        tab.hasNewer = meta.hasNewer ?? false;
        tab.windowEnd = meta.end ?? null;
        tab.loadingOlder = false;
        tab.loadingNewer = false;
      });
    },

    prependPage(tabId, rows, meta) {
      let added = 0;
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        const front: string[] = [];
        for (const row of rows) {
          const id = register(tab, rowMessage(row), rowOffset(row));
          if (!id) continue;
          front.push(id);
          added += 1;
        }
        if (front.length > 0) tab.ids = [...front, ...tab.ids];
        tab.pageCursor = meta.cursor;
        tab.hasMore = meta.hasMore;
        // hasNewer 不变：往上加页不影响"下面还有更新的"
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

    setLoadingNewer(tabId, loading) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.loadingNewer = loading;
      });
    },

    appendPage(tabId, rows, meta) {
      let added = 0;
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        for (const row of rows) {
          if (pushRow(tab, row)) added += 1;
        }
        tab.windowEnd = meta.end;
        tab.hasNewer = meta.hasNewer;
        tab.loadingNewer = false;
        // hasMore（上面还有没有）不变：往下加页不影响窗口起点
      });
      return added;
    },

    setOutline(tabId, turns) {
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.outline = turns;
      });
    },

    /**
     * 一帧流式数据（`pi:frame`，≤60Hz）。
     *
     * 只碰 `pendingId` 那一行的 `live` 槽位：
     *   · `signals` 先跑（块边界：`*_start` / `toolcall_start`）—— 建槽位、定块的形状；
     *   · 再按 `contentIndex` 往对应槽位追加 delta。
     *
     * 槽位编号就是 pi 的 `contentIndex`，**每条助手消息从 0 重新开始**
     * （这正是旧 DOM 引擎按 `contentIndex` 全局编号时"两条消息串成一行"的根因）。
     */
    applyFrame(tabId, frame) {
      set((s) => {
        const tab = s.tabs[tabId];
        if (!tab || tab.hasNewer) return; // 换窗期间窗口不在尾部：不建流式行（见 message_start）
        if (!tab.pendingId) return; // 没有流式行（帧走在 message_start 前）：丢掉，别造半截节点
        const row = tab.byId[tab.pendingId];
        if (!row) return;
        const blocks = (row.live ??= []);
        const ensure = (
          ci: number,
          kind: LiveBlock['kind'],
          toolName?: string,
          toolCallId?: string,
        ): LiveBlock => {
          const exist = blocks[ci];
          if (exist) return exist;
          const fresh: LiveBlock = { kind, text: '', toolName, toolCallId };
          blocks[ci] = fresh;
          return fresh;
        };
        for (const sig of frame.signals ?? []) {
          const s2 = sig as { type?: string; contentIndex?: number; toolName?: string; id?: string };
          const ci = s2.contentIndex ?? 0;
          if (s2.type === 'text_start') ensure(ci, 'text');
          else if (s2.type === 'thinking_start') ensure(ci, 'thinking');
          else if (s2.type === 'toolcall_start') ensure(ci, 'tool', s2.toolName ?? 'tool', s2.id);
        }
        for (const d of frame.text ?? []) ensure(d.contentIndex, 'text').text += d.delta ?? '';
        for (const d of frame.thinking ?? []) ensure(d.contentIndex, 'thinking').text += d.delta ?? '';
        for (const d of frame.toolArgs ?? []) {
          const b = ensure(d.contentIndex, 'tool');
          b.text += d.delta ?? '';
          parseToolArgs(b);
        }
      });
    },

    applyCommit(tabId, ev) {
      const e = ev as { type: string } & Record<string, unknown>;
      set((s) => {
        const tab = (s.tabs[tabId] ??= emptyTab());
        tab.commitSeq += 1;
        switch (e.type) {
          case 'message_start': {
            // 换窗期间（`hasNewer`）窗口不在尾部：流式那一行会出现在**几轮之前**的位置上
            // （用户正在看历史）。回到最新时整页重载，那时自然带上。
            if (tab.hasNewer) break;
            const m = (e as unknown as { message?: AgentMessage }).message;
            if ((m as { role?: string })?.role === 'assistant') beginPending(tab, m as AgentMessage);
            break;
          }
          case 'message_end': {
            // 换窗期间（`hasNewer`）窗口不在尾部：把新消息塞进来会插在**错误的上下文**里
            // （用户正在看几轮之前的历史）。回到最新时整页重载，那时自然带上。
            if (tab.hasNewer) break;
            const m = (e as unknown as { message: AgentMessage }).message;
            // 助手消息：落进**已经在显示的那一行**（不新增行、不改下标）
            if ((m as { role?: string })?.role === 'assistant' && finishPending(tab, m)) break;
            pushMessage(tab, m);
            break;
          }
          case 'agent_start':
            tab.streaming = true;
            break;
          case 'agent_settled': {
            tab.streaming = false;
            // 一轮落定：还在挂着的提示行（重试/压缩）一并撤掉 —— 它们的语义就是"正在…"。
            // pi 正常会给 end 事件；worker 崩/被毙时给不出，这里兜底，免得化石行留在转录里。
            dropNotice(tab, 'retry');
            dropNotice(tab, 'compaction');
            break;
          }
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
          /* 压缩与重试：pi 的事件说的都是**进程内的状态**，界面把它落成**会话里的一行**
             （见 `NoticeView`）。字段直接从 pi 的事件带过来（`auto_retry_start` 的
             attempt/maxAttempts/delayMs/errorMessage），不在这里编文案。 */
          case 'compaction_start':
            pushNotice(tab, {
              kind: 'compaction',
              reason: (e as { reason?: string }).reason || undefined,
            });
            break;
          case 'compaction_end':
            dropNotice(tab, 'compaction');
            break;
          case 'auto_retry_start': {
            const r = e as unknown as {
              attempt?: number;
              maxAttempts?: number;
              delayMs?: number;
              errorMessage?: string;
            };
            pushNotice(tab, {
              kind: 'retry',
              attempt: r.attempt,
              maxAttempts: r.maxAttempts,
              delayMs: r.delayMs,
              errorMessage: r.errorMessage,
            });
            break;
          }
          case 'auto_retry_end':
            dropNotice(tab, 'retry');
            break;
          case 'piggy:resync': {
            // resync 是**权威全量**（worker 崩/休眠后补齐上下文）：流式那一行连同它的
            // 半截文本一起撤掉 —— 它要么在 entries 里以权威消息的身份回来，要么本来就没落盘。
            dropPending(tab);
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

/**
 * 一行的切片订阅（转录里每个行组件用它）。
 *
 * 选择器**只返回这一行自己的对象**：immer 让没改到的行保持引用不变，于是流式那 60Hz
 * 的写入只让那一行重渲染（DSH 的 seat 订阅自己的 node，同构）。
 */
export function useRowMsg(tabId: string | null, rowId: string): MessageView | undefined {
  return useStore(useMessages, (s) => (tabId ? s.tabs[tabId]?.byId[rowId] : undefined));
}

/**
 * 已载入窗口里**每条工具调用的改动行数**（`callId → {added, removed}`）。
 *
 * 改动卡片要显示 `+N −M`，而卡片渲染在助手行里：它既不该在渲染时解析 patch
 * （每次重渲染都白扫一遍），也不该订阅整个 `toolResults`（流式时每帧换引用 →
 * 每个助手行每帧重渲染）。所以在**提交**时算一次，按 `commitSeq` 当依赖
 * （与 `todoBaselines` 同一套口径）。
 */
export function changedStatsOf(tabId: string): Record<string, { added: number; removed: number }> {
  const out: Record<string, { added: number; removed: number }> = {};
  const tab = useMessages.getState().tabs[tabId];
  if (!tab) return out;
  for (const [callId, result] of Object.entries(tab.toolResults)) {
    if (result.changed) out[callId] = result.changed;
  }
  return out;
}

/** 工具结果切片（工具行用它就地接上结果）。 */
export function useToolResult(tabId: string | null, callId: string | undefined): ToolResultView | undefined {
  return useStore(useMessages, (s) =>
    tabId && callId ? s.tabs[tabId]?.toolResults[callId] : undefined,
  );
}
