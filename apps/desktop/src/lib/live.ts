/**
 * 实时块引擎 v2（docs/04 §4）：per-tab 实例。
 *
 * `pi:frame` → 直接 DOM 追加（appendData），不触发 React 渲染。
 *
 * ## 三条纪律（用户 2026-09-23 报「有时候不会滚动输出，会等到完成后再全部输出」之后定的）
 *
 * ① **文本是内容，DOM 节点只是视图。**
 *    累积的文本活在 `pending` 里（每个 contentIndex 的 kind/label/全文），节点只是它当前的
 *    渲染目标。节点被摘掉时只 `detach()`，**一个字都不清**；节点回来时 `attach()` 按
 *    `pending` 原样重建。
 *
 *    为什么必须这样：实时行是转录里的**最后一行**，由虚拟化渲染 —— 读者往上滚出窗口、
 *    或它在窗口外时开始流式，这个节点就会被卸载；回来时 React 给的是**另一个新节点**。
 *    早先挂载点由 `[tabId, streaming]` 的 effect 决定：effect 不会因为"节点换了"再跑一次，
 *    于是引擎一直往**被摘掉的那个节点**写。界面上那一行从那一刻起空着（文本在看不见的
 *    节点里继续长），直到这一轮结束、整段消息由 store 一次性渲染出来。
 *
 * ② **没有布局就没有"底部"。**
 *    `clientHeight === 0`（节点不在文档里 / 面板被 dockview 摘出 DOM）时不写 `scrollTop`：
 *    0/0/0 的几何会被读成"已经贴着底"，对后台 tab 是白做工，对可见性切换是假基线。
 *
 * ③ **读者接管之后，引擎一个像素都不许自己滚**（`setFollowing(false)`）。
 *    引擎这条 rAF 贴底（离底 <120px 就贴）在读者往上滚时就是"每帧把人拽回底部"的元凶 ——
 *    用户 2026-09-23 报"一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下"。
 *    真浏览器实测（修复前）：`wheel(0,-120)` 之后每 25ms 采样一次，`gap` 恒为 0、
 *    位置只在跟着内容往上长。跟随意图由 `Transcript` 拥有（只有它知道滚动采样与读者手势），
 *    引擎只执行；`following` 默认 true（后台 tab 没有转录时也保持"贴底"语义）。
 */

import type { Frame } from '@piggy/pi-protocol';
import { firstLine, toolSummary, toolVariant, toolTitle, VARIANT_ICONS } from '@/features/chat/toolRowModel';

type UsageCb = (text: string) => void;

/** 一块的累积记录：节点死了也活着，`attach` 靠它重建视图。 */
interface PendingBlock {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  label?: string;
}

/**
 * 窄行的视图状态（思考 / 工具）。
 *
 * **标记逐条镜像 `DisclosureRow` + `ThinkingRow`/`ToolRow`**（`pg-thinkrow`/`pg-trow` +
 * `pg-drow*` + `pg-trow-sep/summary`）：几何、hover 露箭头、`[hidden]` 都由同一套 CSS 决定，
 * 于是"实时那一行"和"提交之后那一行"长得一模一样。这也是用户 2026-09-23 要的：
 * 实时块里的思考/工具不该是裸的原生三角和 `⚙ name…` 芯片。
 * 标题与摘要走 `features/chat/toolRowModel`（纯函数）——**同一个漏斗**，
 * 免得实时行写一套、提交行写另一套，两边慢慢漂。
 */
interface RowState {
  /** 外层（`pg-thinkrow` / `pg-trow`） */
  el: HTMLElement;
  head: HTMLElement;
  leading: HTMLElement;
  sep: HTMLElement;
  summary: HTMLElement;
  /** 正文容器（`[hidden]` 的那个）；工具行现在没有正文（结果还没来） */
  body: HTMLElement | null;
  icon: string;
  toolName?: string;
  open: boolean;
  /** 摘要节流：思考每帧都在长，摘要不必每帧重写（100ms 一次足够跟手） */
  summaryAt: number;
  /** 工具行：上一次尝试解析参数 JSON 的长度（避免每帧 JSON.parse） */
  argsTried: number;
}

/** 一块的视图状态：`sink` = 文本落点（text → `<p>`；thinking → 正文容器）。 */
interface BlockState {
  sink: HTMLElement;
  row: RowState | null;
}

/** codicon 字形（与 `Icon` 组件同一套类名）。 */
function iconEl(name: string, size = 14): HTMLElement {
  const i = document.createElement('i');
  i.className = `codicon codicon-${name}`;
  i.style.fontSize = `${size}px`;
  i.setAttribute('aria-hidden', 'true');
  return i;
}

/** 前导框：展开时恒为上箭头；折叠时是图标 + hover/聚焦才露面的下箭头（DSH `.chevronHover`）。 */
function renderLeading(leading: HTMLElement, name: string, open: boolean) {
  leading.replaceChildren();
  if (open) {
    leading.appendChild(iconEl('chevron-up'));
    return;
  }
  const box = document.createElement('span');
  box.className = 'pg-drow-icon';
  box.appendChild(iconEl(name));
  const chev = document.createElement('span');
  chev.className = 'pg-drow-chevron';
  chev.setAttribute('data-disclosure-chevron', '');
  chev.appendChild(iconEl('chevron-down'));
  leading.append(box, chev);
}

class LiveEngine {
  private container: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private blocks = new Map<number, BlockState>();
  private pending = new Map<number, PendingBlock>();
  private usageCb: UsageCb | null = null;
  private usageText = '';
  private usageLastEmit = -Infinity;
  private followRAF = 0;
  private disposed = false;
  /** 读者是否还在跟尾（见文件头 ③）：false 时 `follow()` 直接返回。 */
  private following = true;

  /**
   * 挂到当前 DOM 节点。同一个节点重复 attach 是幂等的（不重建、不清文本）。
   *
   * `scrollEl` 一般不用传：滚动容器由挂载点自己找（`[data-transcript-scroll]`），
   * 这样也免掉"父节点的 ref 有没有先挂上"这种顺序依赖。
   */
  attach(container: HTMLElement, scrollEl?: HTMLElement | null) {
    if (this.disposed) return;
    if (this.container === container) {
      if (scrollEl) this.scrollEl = scrollEl;
      return;
    }
    this.container = container;
    if (scrollEl) this.scrollEl = scrollEl;
    this.blocks.clear();
    container.textContent = '';
    for (const [ci, p] of this.pending) {
      const el = this.ensureBlock(ci, p.kind, p.label);
      // ⚠️ 工具块的 `pending.text` 是**参数 JSON**，不是给人看的正文：它只喂摘要
      // （`refreshRow`）。照搬 text/thinking 那样 append 进 DOM，会在那一行下面多出一行
      // 生 JSON（实测行高 48px，提交行是 24px）。
      if (el && p.text && p.kind !== 'tool') this.appendText(el, p.text);
      const block = this.blocks.get(ci);
      if (block?.row) this.refreshRow(block, p.kind, p.text);
    }
  }

  /** 跟随意图（Transcript 拥有，见文件头 ③）。 */
  setFollowing(next: boolean) {
    this.following = next;
    if (!next) cancelAnimationFrame(this.followRAF);
  }

  /** 节点被摘掉（虚拟化卸载 / 面板摘出 DOM / Transcript 卸载）：只丢视图，文本留着。 */
  detach() {
    this.container = null;
    this.scrollEl = null;
    this.blocks.clear();
    cancelAnimationFrame(this.followRAF);
  }

  /** 这一轮作废（转正/新一轮开始）：文本与视图一起清。 */
  reset() {
    this.pending.clear();
    this.blocks.clear();
    if (this.container) this.container.textContent = '';
  }

  /** tab 关闭：连实例一起退休。 */
  dispose() {
    this.detach();
    this.pending.clear();
    this.disposed = true;
    this.usageCb = null;
  }

  onUsage(cb: UsageCb | null) {
    this.usageCb = cb;
  }

  currentUsage(): string {
    return this.usageText;
  }

  handleFrame(frame: Frame) {
    if (this.disposed) return;
    for (const sig of frame.signals ?? []) {
      const ci = (sig as { contentIndex?: number }).contentIndex ?? 0;
      const kind = (sig as { type: string }).type;
      if (kind === 'text_start') this.ensureBlock(ci, 'text');
      else if (kind === 'thinking_start') this.ensureBlock(ci, 'thinking');
      else if (kind === 'toolcall_start') {
        const s = sig as { toolName?: string };
        this.ensureBlock(ci, 'tool', s.toolName ?? 'tool');
      }
    }
    for (const d of frame.text ?? []) {
      const el = this.ensureBlock(d.contentIndex, 'text');
      if (el) this.appendText(el, d.delta ?? '');
      this.note(d.contentIndex, 'text', d.delta ?? '');
    }
    for (const d of frame.thinking ?? []) {
      const el = this.ensureBlock(d.contentIndex, 'thinking');
      if (el) this.appendText(el, d.delta ?? '');
      this.note(d.contentIndex, 'thinking', d.delta ?? '');
      const block = this.blocks.get(d.contentIndex);
      if (block) this.refreshRow(block, 'thinking', this.pending.get(d.contentIndex)?.text ?? '');
    }
    for (const d of frame.toolArgs ?? []) {
      // 工具参数是 JSON 增量：累积起来（`pending`），够完整时抽一行摘要（见 refreshRow）
      this.note(d.contentIndex, 'tool', d.delta ?? '');
      const block = this.blocks.get(d.contentIndex);
      if (block) this.refreshRow(block, 'tool', this.pending.get(d.contentIndex)?.text ?? '');
    }
    if (frame.usage) {
      const u = frame.usage as { totalTokens?: number; cost?: { total?: number } };
      const tokens = u.totalTokens ?? 0;
      const cost = u.cost?.total;
      this.usageText =
        cost != null ? `${tokens.toLocaleString()} tok · $${cost.toFixed(4)}` : `${tokens.toLocaleString()} tok`;
      const now = performance.now();
      if (now - this.usageLastEmit > 1000) {
        this.usageLastEmit = now;
        this.usageCb?.(this.usageText);
      }
    }
    this.follow();
  }

  /* ---------- 内部 ---------- */

  private note(ci: number, kind: 'text' | 'thinking' | 'tool', text: string) {
    const p = this.pending.get(ci) ?? { kind, text: '' };
    p.kind = kind;
    p.text += text;
    this.pending.set(ci, p);
  }

  private ensureBlock(ci: number, kind: 'text' | 'thinking' | 'tool', label?: string): HTMLElement | null {
    const existing = this.blocks.get(ci);
    if (existing) return existing.sink;
    // 块的**形状**也要进 `pending`（不只是文本）：节点被摘掉后按它原样重建，
    // 否则 thinking 会重建成长文本、工具块会只剩个空壳。
    const prev = this.pending.get(ci);
    this.pending.set(ci, { kind, text: prev?.text ?? '', label: label ?? prev?.label });
    const c = this.container;
    if (!c) return null;
    const built =
      kind === 'text'
        ? this.buildText()
        : kind === 'thinking'
          ? this.buildThinking()
          : this.buildTool(label ?? this.pending.get(ci)?.label ?? 'tool');
    c.appendChild(built.root);
    this.blocks.set(ci, built.block);
    return built.block.sink;
  }

  private buildText(): { block: BlockState; root: HTMLElement } {
    const p = document.createElement('p');
    p.className = 'pg-live-text';
    return { block: { sink: p, row: null }, root: p };
  }

  /** 思考行：`思考 · 首行摘要`，点开是完整思考（默认折叠，与提交行同一套几何）。 */
  private buildThinking(): { block: BlockState; root: HTMLElement } {
    const { el, drow, head, leading, sep, summary } = this.buildRowShell(
      'pg-thinkrow',
      'pg-thinkrow-head',
      '思考',
    );
    el.setAttribute('data-thinking-row', '');
    const holder = document.createElement('div');
    holder.setAttribute('data-thinking-body', '1');
    holder.setAttribute('hidden', 'until-found');
    const body = document.createElement('div');
    body.className = 'pg-thinking-body';
    holder.appendChild(body);
    // ⚠️ 正文挂在 `.pg-drow` 里（与 `DisclosureRow` 同构）：`.pg-drow [hidden] { display:none }`
    // 靠这层选择器生效。挂到外层 `.pg-thinkrow` 上时折叠的正文照样占高度 —— 实测行高 32px
    // （提交行是 24px），正是这条挂错了。
    drow.appendChild(holder);
    const row: RowState = {
      el, head, leading, sep, summary, body: holder, icon: 'lightbulb',
      open: false, summaryAt: -Infinity, argsTried: 0,
    };
    this.wireToggle(row);
    this.syncRowChrome(row);
    return { block: { sink: body, row }, root: el };
  }

  /** 工具行：`运行命令 · 参数摘要`（摘要从流式参数里抽；结果还没来，所以没有正文）。 */
  private buildTool(toolName: string): { block: BlockState; root: HTMLElement } {
    const variant = toolVariant(toolName);
    const { el, head, leading, sep, summary } = this.buildRowShell(
      'pg-trow',
      'pg-trow-head',
      toolTitle(toolName, variant),
    );
    el.setAttribute('data-tool-row', '');
    el.setAttribute('data-tool', toolName);
    el.setAttribute('data-variant', variant);
    el.setAttribute('data-live-row', '');
    const row: RowState = {
      el, head, leading, sep, summary, body: null, icon: VARIANT_ICONS[variant], toolName,
      open: false, summaryAt: -Infinity, argsTried: 0,
    };
    this.syncRowChrome(row);
    // 工具行没有文本落点（参数只喂摘要）；`sink` 指向行本身，`appendText` 不会走到它
    return { block: { sink: el, row }, root: el };
  }

  /** 窄行的骨壳（镜像 `DisclosureRow` 的标记，见 `RowState` 的说明）。 */
  private buildRowShell(wrap: 'pg-thinkrow' | 'pg-trow', headClass: string, title: string) {
    const el = document.createElement('div');
    el.className = wrap;
    const drow = document.createElement('div');
    drow.className = 'pg-drow';
    const head = document.createElement('div');
    head.className = `pg-drow-head ${headClass}`;
    head.setAttribute('data-disclosure-row', '');
    const leading = document.createElement('span');
    leading.className = 'pg-drow-leading';
    leading.setAttribute('data-disclosure-leading', '');
    const titleEl = document.createElement('span');
    titleEl.className = 'pg-drow-title';
    titleEl.textContent = title;
    const sep = document.createElement('span');
    sep.className = 'pg-trow-sep';
    sep.setAttribute('aria-hidden', 'true');
    const summary = document.createElement('span');
    summary.className = 'pg-trow-summary';
    head.append(leading, titleEl, sep, summary);
    drow.appendChild(head);
    el.appendChild(drow);
    return { el, drow, head, leading, sep, summary };
  }

  /** 折叠开关（点整行 / Enter / Space），与 `DisclosureRow` 同一套语义。 */
  private wireToggle(row: RowState) {
    row.head.setAttribute('data-expandable', '');
    row.head.setAttribute('role', 'button');
    row.head.tabIndex = 0;
    const set = (open: boolean) => {
      row.open = open;
      if (open) {
        row.el.setAttribute('data-open', '');
        row.head.setAttribute('aria-expanded', 'true');
        row.body?.removeAttribute('hidden');
      } else {
        row.el.removeAttribute('data-open');
        row.head.setAttribute('aria-expanded', 'false');
        row.body?.setAttribute('hidden', 'until-found');
      }
      renderLeading(row.leading, row.icon, open);
      this.syncRowChrome(row);
    };
    row.head.addEventListener('click', () => set(!row.open));
    row.head.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      set(!row.open);
    });
    set(false);
  }

  /** 没有摘要时连分隔点一起藏起来（提交行也是这么做的：`collapsedContent` 为 null）。 */
  private syncRowChrome(row: RowState) {
    const has = (row.summary.textContent ?? '') !== '';
    row.sep.style.display = has ? '' : 'none';
    row.summary.style.display = has ? '' : 'none';
  }

  /**
   * 行内容的刷新（文本在长 / 参数在流）。
   *
   * 思考：摘要 = 首行（节流 100ms —— 每帧重写一条正在变长的行没有意义）。
   * 工具：参数是 JSON 增量，**够完整时**才解析（`trimEnd()` 以 `}` 结尾 + 长度变了才重试），
   * 抽一行摘要走 `toolSummary`（与提交行同一个漏斗）。
   */
  private refreshRow(block: BlockState, kind: 'text' | 'thinking' | 'tool', text: string) {
    const row = block.row;
    if (!row) return;
    if (kind === 'thinking') {
      const now = performance.now();
      if (now - row.summaryAt < 100) return;
      row.summaryAt = now;
      row.summary.textContent = firstLine(text);
      this.syncRowChrome(row);
      return;
    }
    if (kind !== 'tool') return;
    const trimmed = text.trimEnd();
    if (!trimmed.endsWith('}') || trimmed.length === row.argsTried) return;
    row.argsTried = trimmed.length;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // 半截 JSON：等下一帧
    }
    const variant = toolVariant(row.toolName);
    const summary = toolSummary(variant, args);
    if (!summary) return;
    row.summary.textContent = summary;
    row.summary.setAttribute('title', summary);
    row.summary.setAttribute('data-summary-source', 'args');
    this.syncRowChrome(row);
  }

  private appendText(el: HTMLElement, text: string) {
    const last = el.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE) {
      (last as Text).appendData(text);
    } else {
      el.appendChild(document.createTextNode(text));
    }
  }

  /** 滚动容器：挂载点自己找（见 `attach` 的说明）。 */
  private scroller(): HTMLElement | null {
    if (!this.scrollEl) {
      this.scrollEl = (this.container?.closest('[data-transcript-scroll]') as HTMLElement | null) ?? null;
    }
    return this.scrollEl;
  }

  private follow() {
    if (!this.following) return; // 读者接管了（见文件头 ③）
    const el = this.scroller();
    if (!el || !this.container) return;
    if (el.clientHeight <= 0) return; // 没有布局 → 没有"底部"（见文件头 ②）
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    cancelAnimationFrame(this.followRAF);
    this.followRAF = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

const engines = new Map<string, LiveEngine>();

/** tab 维度的 live 引擎（tab 关闭时 dispose） */
export function liveFor(tabId: string): LiveEngine {
  let e = engines.get(tabId);
  if (!e) {
    e = new LiveEngine();
    engines.set(tabId, e);
  }
  return e;
}

/** 一轮的边界：清掉累积文本（**不**建实例 —— 没流过式的 tab 不该被这条路径建出来） */
export function resetLive(tabId: string) {
  engines.get(tabId)?.reset();
}

export function disposeLive(tabId: string) {
  engines.get(tabId)?.dispose();
  engines.delete(tabId);
}
