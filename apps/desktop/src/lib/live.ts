/**
 * 实时块引擎 v2（docs/04 §4）：per-tab 实例。
 * `pi:frame` → 直接 DOM 追加（appendData），不触发 React 渲染；
 * 仅活动 tab 挂载（后台 tab 的帧丢弃视觉、保留 commit）。
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
  private disposed = false;

  mount(container: HTMLElement, scrollEl: HTMLElement) {
    if (this.disposed) return;
    this.container = container;
    this.scrollEl = scrollEl;
    for (const [ci, p] of this.pending) {
      const el = this.ensureBlock(ci, p.kind, p.label);
      if (el && p.text) this.appendText(el, p.text);
    }
  }

  unmount() {
    this.container = null;
    this.scrollEl = null;
    this.blocks.clear();
    this.pending.clear();
    cancelAnimationFrame(this.followRAF);
  }

  dispose() {
    this.unmount();
    this.disposed = true;
    this.usageCb = null;
  }

  onUsage(cb: UsageCb | null) {
    this.usageCb = cb;
  }

  reset() {
    this.blocks.clear();
    this.pending.clear();
    if (this.container) this.container.textContent = '';
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
    const c = this.container;
    if (!c) {
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

export function disposeLive(tabId: string) {
  engines.get(tabId)?.dispose();
  engines.delete(tabId);
}
