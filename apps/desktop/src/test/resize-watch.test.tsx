// @vitest-environment jsdom
/**
 * 尺寸订阅（`lib/resizeWatch`）：**全应用共用一个 `ResizeObserver`**。
 *
 * 为什么值得单独钉住：转录区里每个代码块以前各建 1~2 个观察者（一次会话几百个），
 * 梯子再建一个。观察者多不只是开销 —— 每个都是"回调 → setState → 布局变 → 再通知"
 * 这条链上独立的一环，浏览器判定"循环没收敛"
 * （`ResizeObserver loop completed with undelivered notifications`）的机会随之变多，
 * 而这条警告在真机（WKWebView）上比门禁（Chromium）里吵得多（docs/03 §2.18b）。
 * 收成一个之后，一次投递跑完全部回调、React 合成一次渲染，链只有一圈。
 *
 * 红检方式（改坏哪一条会红）：把 `watchSize` 改成"每次调用都 `new ResizeObserver`"，
 * 第一、第六条立刻红；把退订写成空函数，第三条红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { resizeWatchLastFired, resizeWatchStats, watchSize } from '@/lib/resizeWatch';
import { installResizeObserverProbe, resizeProbeHint } from '@/lib/resizeProbe';
import { CodeBlock } from '@/features/chat/CodeBlock';
import { domContainer, mountDom, unmountDom } from './dom-render';

/** 记账桩：必须在任何组件挂载**之前**换掉全局（本文件模块作用域） */
class CountingObserver {
  observed = new Set<Element>();
  constructor(public cb: ResizeObserverCallback) {
    created.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  /** 测试里手动投递一次（jsdom 不会自己触发） */
  fire(...targets: Element[]) {
    const entries = targets.map((t) => ({ target: t }) as ResizeObserverEntry);
    this.cb(entries, this as unknown as ResizeObserver);
  }
}
const created: CountingObserver[] = [];
(globalThis as Record<string, unknown>).ResizeObserver = CountingObserver;

afterEach(async () => {
  await unmountDom();
});

describe('lib/resizeWatch', () => {
  it('环境没有 ResizeObserver 时不抛、不假装观察（老 WebKit / jsdom）', () => {
    delete (globalThis as Record<string, unknown>).ResizeObserver;
    try {
      const el = document.createElement('div');
      const off = watchSize(el, () => {});
      expect(() => {
        off();
        off(); // 幂等
      }).not.toThrow();
      expect(resizeWatchStats().instances).toBe(0);
    } finally {
      (globalThis as Record<string, unknown>).ResizeObserver = CountingObserver;
    }
  });

  it('观察多个元素只创建一个实例，且回调只发给对应元素', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const seen: string[] = [];
    const offA = watchSize(a, () => seen.push('a'));
    const offB = watchSize(b, () => seen.push('b'));

    expect(created).toHaveLength(1);
    expect(resizeWatchStats()).toEqual({ instances: 1, elements: 2 });
    expect(created[0]!.observed.size).toBe(2);

    act(() => created[0]!.fire(a));
    expect(seen).toEqual(['a']);
    act(() => created[0]!.fire(b));
    expect(seen).toEqual(['a', 'b']);
    // DEV 下探针要能说出"最后回调来自哪个调用点"
    expect(resizeWatchLastFired()).toContain('resize-watch.test');

    offA();
    offB();
    expect(resizeWatchStats().elements).toBe(0);
  });

  it('同一元素挂两个回调都会跑；退到只剩一个时只跑剩下的', () => {
    const el = document.createElement('div');
    const seen: string[] = [];
    const off1 = watchSize(el, () => seen.push('1'));
    const off2 = watchSize(el, () => seen.push('2'));
    act(() => created[0]!.fire(el));
    expect(seen.sort()).toEqual(['1', '2']);

    off1();
    seen.length = 0;
    act(() => created[0]!.fire(el));
    expect(seen).toEqual(['2']);
    expect(resizeWatchStats().elements).toBe(1);
    off2();
  });

  it('最后一个回调退掉才 unobserve（共用元素不能被人先撤了）', () => {
    const el = document.createElement('div');
    const off1 = watchSize(el, () => {});
    const off2 = watchSize(el, () => {});
    const inst = created[0]!;
    off1();
    expect(inst.observed.has(el)).toBe(true);
    off2();
    expect(inst.observed.has(el)).toBe(false);
    // 之后再订阅还是同一个实例（不新建）
    const off3 = watchSize(el, () => {});
    expect(created).toHaveLength(1);
    expect(inst.observed.has(el)).toBe(true);
    off3();
  });

  it('回调里退订自己，不打断同一次投递里的其他回调', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const seen: string[] = [];
    const offA = watchSize(a, () => {
      seen.push('a');
      offA();
    });
    const offB = watchSize(b, () => seen.push('b'));
    act(() => created[0]!.fire(a, b));
    expect(seen).toEqual(['a', 'b']);
    offB();
  });
});

describe('lib/resizeProbe：循环警告的"现场证人"', () => {
  it('我们建的算我们、别人建的算别人，创建点指到调用方', () => {
    installResizeObserverProbe(); // 幂等（main.tsx 启动时已经装过一次）
    const own = document.createElement('div');
    const offOwn = watchSize(own, () => {});
    // 模拟第三方：绕开 resizeWatch 直接 new（TanStack/dockview 就是这么干的）
    const foreign = new ResizeObserver(() => {});
    foreign.observe(document.createElement('div'));

    const hint = resizeProbeHint();
    expect(hint).toContain('RO 探针');
    expect(hint).toContain('resizeWatch'); // 我们的规模（实例数/元素数）
    expect(hint).toContain('其它地方创建'); // 第三方那一类
    expect(hint).toContain('resize-watch.test'); // 创建点指到本文件，不是"某处"
    offOwn();
    foreign.disconnect();
  });

  it('resizeWatch 自己建的实例不算"其它地方"（分类看完整路径，不看截断后的展示串）', async () => {
    // 换一套新模块：本文件前面那些用例已经建过共享实例，只有全新实例才走得到分类分支
    vi.resetModules();
    // 先把上一轮装上的探针摘掉：它的 `__piggyProbed` 标记会让新一轮直接返回（幂等保护）
    (globalThis as Record<string, unknown>).ResizeObserver = CountingObserver;
    const freshProbe = await import('@/lib/resizeProbe');
    const freshWatch = await import('@/lib/resizeWatch');
    freshProbe.resetResizeProbe();
    freshProbe.installResizeObserverProbe();

    const el = document.createElement('div');
    const off = freshWatch.watchSize(el, () => {});
    const hint = freshProbe.resizeProbeHint();
    expect(hint).toContain('其它地方：没建过');
    expect(hint).toContain('其中 1 处走的是 resizeWatch');
    expect(hint).not.toContain('resize-watch.test'); // 我们建的不许出现在"创建点"里
    off();
  });
});

describe('代码块不再各自建观察者', () => {
  it('三张卡片共用同一个实例，卸载后一个元素都不留', async () => {
    const before = created.length;
    mountDom(
      <>
        <CodeBlock code={'a\nb'} lang="go" />
        <CodeBlock code={'a\nb'} lang="go" />
        <CodeBlock code={'a\nb'} lang="go" />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(created.length - before).toBe(0); // 复用已有实例，不新建
    const stats = resizeWatchStats();
    expect(stats.instances).toBe(1);
    // 每张卡片至少盯住 `<pre>`（高亮 HTML 落地后还会多盯内容子节点）
    expect(stats.elements).toBeGreaterThanOrEqual(3);
    expect(domContainer().querySelectorAll('.pg-codeblock').length).toBe(3);

    await unmountDom();
    expect(resizeWatchStats().elements).toBe(0);
  });
});
