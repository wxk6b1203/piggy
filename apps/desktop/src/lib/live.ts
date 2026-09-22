/**
 * 实时块引擎（docs/04 §4 渲染分帧核心）：
 * `pi:frame:*` → 直接 DOM 追加（appendData），不触发 React 渲染；
 * `message_start/end` 边界 reset；usage 走 1Hz 节流回调（状态栏订阅）。
 */
import type { Frame } from '@piggy/pi-protocol';

type UsageCb = (text: string) => void;

class LiveEngine {
  private container: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private blocks = new Map<number, HTMLElement>();
  private pending = new Map<number, { kind: 'text' | 'thinking' | 'tool'; text: string; label?: string }>();
  private usageCb: UsageCb | null = null;
  private usageText = '';
  private usageLastEmit = -Infinity;
  private followRAF = 0;

  mount(container: HTMLElement, scrollEl: HTMLElement) {
    this.container = container;
    this.scrollEl = scrollEl;
    // 冲刷 mount 前累积的内容
    for (const [ci, p] of this.pending) {
      const el = this.ensureBlock(ci, p.kind, p.label);
      if (el && p.text) this.appendText(el, p.text);
    }
  }

  unmount() {
    this.container = null;
    this.scrollEl = null;
    this.blocks.clear(); // 旧容器节点作废（pending 保留，mount 时重建）
    cancelAnimationFrame(this.followRAF);
  }

  onUsage(cb: UsageCb | null) {
    this.usageCb = cb;
  }

  reset() {
    this.blocks.clear();
    this.pending.clear();
    if (this.container) this.container.textContent = '';
  }

  handleFrame(frame: Frame) {
    // 1. 块边界信号 → 创建块结构
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
    // 2. 文本增量 → appendData（O(1)，无 DOM 重建）
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
    // 3. usage → 1Hz 节流
    if (frame.usage) {
      const u = frame.usage as {
        totalTokens?: number;
        cost?: { total?: number };
      };
      const tokens = u.totalTokens ?? 0;
      const cost = u.cost?.total;
      this.usageText = cost != null ? `${tokens.toLocaleString()} tok · $${cost.toFixed(4)}` : `${tokens.toLocaleString()} tok`;
      const now = performance.now();
      if (now - this.usageLastEmit > 1000) {
        this.usageLastEmit = now;
        this.usageCb?.(this.usageText);
      }
    }
    this.follow();
  }

  currentUsage(): string {
    return this.usageText;
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
    const c = this.container;
    if (!c) {
      // 未挂载：只记内容，mount 时重建
      this.pending.set(ci, { kind, text: this.pending.get(ci)?.text ?? '', label });
      return null;
    }
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
    // thinking 块写到 body 容器
    const target = el.classList.contains('pg-live-thinking')
      ? (el.querySelector('.pg-thinking-body') as HTMLElement | null) ?? el
      : el;
    // 文本节点追加（appendData O(1)）；无文本节点则创建
    const last = target.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE) {
      (last as Text).appendData(text);
    } else {
      target.appendChild(document.createTextNode(text));
    }
  }

  /** 底部跟随：用户上滚即暂停（docs/04 §4.3） */
  private follow() {
    if (!this.scrollEl || !this.container) return;
    const el = this.scrollEl;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    cancelAnimationFrame(this.followRAF);
    this.followRAF = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

export const live = new LiveEngine();
