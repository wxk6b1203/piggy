// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { liveFor } from '@/lib/live';

/** 实时块引擎（docs/04 §4 渲染分帧）：直写 DOM、不触发 React；per-tab 实例 */
describe('LiveEngine（per-tab）', () => {
  /* 每个用例一个 tab：引擎是模块级 Map 存活的，共用 tabId 会让上一个用例的
     `pending` 漏进下一个（实测：漏了两个字，断言看起来像功能坏了）。 */
  let seq = 0;
  const eng = () => liveFor(`lt-${(seq += 1)}`);

  /** 一份"转录滚动容器 + 实时行节点"的最小结构（滚动容器靠属性自证，见 `lib/live`）。 */
  function node() {
    const scroll = document.createElement('div');
    scroll.setAttribute('data-transcript-scroll', '');
    const container = document.createElement('div');
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    return { scroll, container };
  }

  function mounted() {
    const e = eng();
    const { scroll, container } = node();
    e.attach(container);
    return { e, scroll, container };
  }

  /**
   * 给节点装上假几何（jsdom 里 clientHeight/scrollHeight 恒为 0），并**数写入次数**
   * ——"没有布局时一个 scrollTop 都不写"只有数写入才看得见（写 0 与不写，值是一样的）。
   */
  function geometry(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    let top = 0;
    let sets = 0;
    const g = {
      set(next: { scrollHeight: number; clientHeight: number }) {
        Object.defineProperty(el, 'scrollHeight', { value: next.scrollHeight, configurable: true });
        Object.defineProperty(el, 'clientHeight', { value: next.clientHeight, configurable: true });
      },
      sets: () => sets,
    };
    g.set({ scrollHeight, clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        sets += 1;
        top = v;
      },
    });
    return g;
  }

  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  it('text 增量直写文本节点（appendData 语义）', () => {
    const { e, container } = mounted();
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'Hello' }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: ' ' }, { contentIndex: 0, delta: 'Piggy' }] });
    const p = container.querySelector('.pg-live-text') as HTMLElement;
    expect(p.textContent).toBe('Hello Piggy');
    const textNodes = Array.from(p.childNodes).filter((n) => n.nodeType === 3);
    expect(textNodes.length).toBe(1);
  });

  it('thinking 与 toolcall 信号建块', () => {
    const { e, container } = mounted();
    e.handleFrame({
      signals: [
        { type: 'thinking_start', contentIndex: 1 },
        { type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'bash' },
      ],
      thinking: [{ contentIndex: 1, delta: 'hmm' }],
    });
    expect(container.querySelector('.pg-live-thinking')).toBeTruthy();
    expect((container.querySelector('.pg-thinking-body') as HTMLElement).textContent).toBe('hmm');
    expect(container.querySelector('.pg-live-toolchip')!.textContent).toContain('bash');
  });

  it('attach 前到达的帧在 attach 后冲刷（竞态安全，用全新 tab 验证 pending 存活）', () => {
    const e = eng();
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'buffered' }] });
    // 手动 attach（不走 helper 的 reset：本用例验证的正是 pending 的存活）
    const { container } = node();
    e.attach(container);
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('buffered');
  });

  /**
   * 用户 2026-09-23 报「有时候不会滚动输出，会等到完成后再全部输出」的**单元级**复现。
   *
   * 实测路径（浏览器门禁）：读者往上滚，实时行被虚拟化卸载 → 回到底部时 React 给的是
   * **另一个新节点**。引擎若还绑在旧节点上，界面上那一行就一直是空的，直到这一轮结束
   * 整段消息由 store 一次性渲染。契约：`detach` 只丢视图，文本留在 `pending`，
   * `attach` 到新节点时按它重建。
   */
  it('节点被摘掉再挂到新节点：卸载期间的文本一个字不丢（实时行被虚拟化卸载的真实路径）', () => {
    const e = eng();
    const first = node();
    e.attach(first.container);
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: '前半段' }] });

    e.detach(); // ← 滚动出窗口：React 报 null
    e.handleFrame({ text: [{ contentIndex: 0, delta: '后半段' }] }); // 不在窗口里也照收

    const second = node(); // ← 回到窗口：React 给的是**新节点**
    e.attach(second.container);
    const p = second.container.querySelector('.pg-live-text') as HTMLElement;
    expect(p.textContent).toBe('前半段后半段');

    // 之后的增量继续写到**新**节点（旧的从此不再是视图）
    e.handleFrame({ text: [{ contentIndex: 0, delta: '，还在流' }] });
    expect(p.textContent).toBe('前半段后半段，还在流');
  });

  it('块的形状（thinking / 工具名）也随 pending 重建，不是只留文本', () => {
    const e = eng();
    const first = node();
    e.attach(first.container);
    e.handleFrame({
      signals: [
        { type: 'text_start', contentIndex: 0 },
        { type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'edit' },
      ],
      text: [{ contentIndex: 0, delta: '说一句' }],
    });
    e.detach();
    const second = node();
    e.attach(second.container);
    expect((second.container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('说一句');
    expect(second.container.querySelector('.pg-live-toolchip')!.textContent).toContain('edit');
  });

  it('同一个节点重复 attach 幂等（不重建、不重复文本）', () => {
    const { e, container } = mounted();
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: '一次' }] });
    e.attach(container);
    expect(container.querySelectorAll('.pg-live-text').length).toBe(1);
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('一次');
  });

  it('reset 清空（message_end 转正后 / 新一轮开始）：连 pending 一起清', () => {
    const { e, container } = mounted();
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'x' }] });
    e.reset();
    expect(container.textContent).toBe('');
    // 清的是累积文本，不只是当前节点：换节点 attach 也不该把上一轮带出来
    e.detach();
    const fresh = node();
    e.attach(fresh.container);
    expect(fresh.container.textContent).toBe('');
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'y' }] });
    expect((fresh.container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('y');
  });

  /**
   * 纪律 ②：`clientHeight === 0`（节点不在文档里 / 面板被 dockview 摘出 DOM）
   * 时不许写 scrollTop —— 0/0/0 会被读成"已经贴着底"，那是假基线。
   */
  it('没有布局（0/0/0）一个 scrollTop 都不写；有了布局、且读者在底部附近才贴底', async () => {
    const { e, scroll, container } = mounted();
    const g = geometry(scroll, 0, 0); // 被摘出 DOM 的读数：三个都是 0
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'hidden' }] });
    await frame();
    expect(g.sets(), '没有布局还写 scrollTop（0/0/0 被读成"已经贴着底"）').toBe(0);

    // 回到前台：真实几何 + 读者本来就在底部附近 → 必须贴到**新的**底
    g.set({ scrollHeight: 3000, clientHeight: 400 });
    scroll.scrollTop = 2600;
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'visible' }] });
    expect(container.textContent).toContain('visible');
    await frame(); // follow 走 rAF
    expect(scroll.scrollTop).toBe(3000);

    // 离底很远（读者在自己读）→ 不许把他拽下去
    scroll.scrollTop = 100;
    const before = g.sets();
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'more' }] });
    await frame();
    expect(g.sets(), '读者离底很远还被拽下去了').toBe(before);
    expect(scroll.scrollTop).toBe(100);
  });

  /**
   * 纪律 ③（用户 2026-09-23 报"一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下"）：
   * 引擎的 rAF 贴底在读者接管之后必须停手 —— 否则它每帧把人拽回底部（真浏览器实测：
   * 滚轮往上 120px 之后每一帧 gap 都回到 0）。
   */
  it('读者接管（setFollowing(false)）之后一个像素都不写；交还跟随才继续贴底', async () => {
    const { e, scroll } = mounted();
    geometry(scroll, 3000, 400);
    scroll.scrollTop = 2600; // 底部附近
    e.setFollowing(false);
    const g = geometry(scroll, 3000, 400); // 重装几何（顺带把写入计数清零）
    scroll.scrollTop = 2600;
    e.handleFrame({ text: [{ contentIndex: 0, delta: '读者在看别处' }] });
    await frame();
    expect(g.sets(), '读者接管之后引擎还在自己滚').toBe(1); // 只有我们手动设的那一次
    expect(scroll.scrollTop).toBe(2600);

    // 交还跟随（读者滚回底部 / 点「回到底部」）→ 下一帧继续贴底
    e.setFollowing(true);
    e.handleFrame({ text: [{ contentIndex: 0, delta: '继续跟' }] });
    await frame();
    expect(scroll.scrollTop).toBe(3000);
  });

  it('usage 1Hz 节流回调', () => {
    const { e, scroll } = mounted();
    scroll.remove();
    const seen: string[] = [];
    e.onUsage((t) => seen.push(t));
    e.handleFrame({ usage: { totalTokens: 100, cost: { total: 0.5 } } });
    e.handleFrame({ usage: { totalTokens: 200, cost: { total: 0.75 } } }); // 节流窗口内
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('100');
    e.onUsage(null);
  });
});
