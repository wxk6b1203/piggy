/**
 * 实时块引擎 v2（docs/04 §4）：per-tab 实例。
 *
 * `pi:frame` → 直接 DOM 追加（appendData），不触发 React 渲染。
 *
 * ## 两条纪律（用户 2026-09-23 报「有时候不会滚动输出，会等到完成后再全部输出」之后定的）
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
 */

import type { Frame } from '@piggy/pi-protocol';

type UsageCb = (text: string) => void;

/** 一块的累积记录：节点死了也活着，`attach` 靠它重建视图。 */
interface PendingBlock {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  label?: string;
}

class LiveEngine {
  private container: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private blocks = new Map<number, HTMLElement>();
  private pending = new Map<number, PendingBlock>();
  private usageCb: UsageCb | null = null;
  private usageText = '';
  private usageLastEmit = -Infinity;
  private followRAF = 0;
  private disposed = false;

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
      if (el && p.text) this.appendText(el, p.text);
    }
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
    }
    for (const d of frame.toolArgs ?? []) {
      this.note(d.contentIndex, 'tool', '');
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
    if (existing) return existing;
    // 块的**形状**也要进 `pending`（不只是文本）：节点被摘掉后按它原样重建，
    // 否则 thinking 会重建成长文本、工具块会只剩个空壳。
    const prev = this.pending.get(ci);
    this.pending.set(ci, { kind, text: prev?.text ?? '', label: label ?? prev?.label });
    const c = this.container;
    if (!c) return null;
    let el: HTMLElement;
    if (kind === 'text') {
      el = document.createElement('p');
      el.className = 'pg-live-text';
    } else if (kind === 'thinking') {
      el = document.createElement('details');
      el.className = 'pg-live-thinking';
      const summary = document.createElement('summary');
      summary.textContent = '◈ thinking';
      el.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'pg-thinking-body';
      el.appendChild(body);
    } else {
      el = document.createElement('div');
      el.className = 'pg-live-toolchip';
      el.textContent = `⚙ ${label}…`;
    }
    c.appendChild(el);
    this.blocks.set(ci, el);
    return el;
  }

  private appendText(el: HTMLElement, text: string) {
    const target = el.classList.contains('pg-live-thinking')
      ? (el.querySelector('.pg-thinking-body') as HTMLElement | null) ?? el
      : el;
    const last = target.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE) {
      (last as Text).appendData(text);
    } else {
      target.appendChild(document.createTextNode(text));
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
