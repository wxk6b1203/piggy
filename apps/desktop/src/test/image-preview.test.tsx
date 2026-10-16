// @vitest-environment jsdom
/**
 * 图片预览（2026-10-15 用户："这个图片框从左侧起放置，鼠标移动上去显示缩略图，点开展示大图"）。
 *
 * 三件事各有一条用例：
 *   ① 待发图片条**左起**排（不再居中/换行把输入卡顶高）；
 *   ② 缩略图是**按钮**（Tab 可达 + 读屏有名字），点它**开灯箱**；
 *   ③ 灯箱的关闭语义：`Esc` 与点背景都关，而且 **`Esc` 不许冒泡去中断会话**
 *      （Composer 的 `Esc` 是 abort，看大图时按 Esc 绝不能顺手把 agent 停了）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));

import { SessionWorkspaceComposer } from '@/features/chat/Composer';
import { ImageLightbox } from '@/features/common/ImageLightbox';
import {
  ImageHoverPreview,
  PREVIEW_MAX,
  PREVIEW_MIN,
  anchorStyle,
  previewSize,
} from '@/features/common/ImageHoverPreview';
import { useMessages } from '@/stores/messages';
import { useQueue } from '@/stores/queue';
import { domContainer, mountDom, unmountDom } from './dom-render';

const TAB = 't-img';
/** 1×1 PNG（最短的合法 base64），`fileToPendingImage` 产出的就是这个形状 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useQueue.setState({ tabs: {} });
  useMessages.setState({ tabs: {} });
  useMessages.getState().ensure(TAB);
});

afterEach(async () => {
  await unmountDom();
});

/**
 * 造一张"已选好、待发送"的图片。
 *
 * 走**文件选择**这条路（隐藏 `<input type="file">` 的 `change`）而不是粘贴：
 * jsdom 里没有 `ClipboardEvent`/`DataTransfer`（实测 undefined），
 * 硬造粘贴事件等于在测我自己造的假事件；文件那条路的 handler 只读 `e.target.files`，
 * 是同一个 `fileToPendingImage`，覆盖到的代码完全一样。
 */
async function pickImage(name = 'shot.png'): Promise<void> {
  const input = domContainer().querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], name, {
    type: 'image/png',
  });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('待发图片（Composer）', () => {
  it('左起排：条容器在输入卡里且不是居中的', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage();
    const strip = domContainer().querySelector('[data-pending-images]') as HTMLElement;
    expect(strip).not.toBeNull();
    // 几何留给 CSS（jsdom 不算布局），这里钉的是**结构**：
    // 条容器是 `.pg-composer` 的直接子节点，且缩略图在最前面（= 视觉上的最左）
    expect(strip.parentElement?.className).toContain('pg-composer');
    expect(strip.querySelector('.pg-img-thumb-btn')).not.toBeNull();
    expect(strip.firstElementChild?.querySelector('.pg-img-thumb')).not.toBeNull();
  });

  it('缩略图是按钮：可访问名带文件名，点它开灯箱', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage('架构图.png');
    const btn = domContainer().querySelector('.pg-img-thumb-btn') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('查看图片 架构图.png');

    expect(document.querySelector('[data-image-lightbox]')).toBeNull();
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    const box = document.querySelector('[data-image-lightbox]');
    expect(box).not.toBeNull();
    expect(box!.getAttribute('role')).toBe('dialog');
    // 灯箱里那张是原图（同一个 data URL），不是 28px 缩略图
    const big = box!.querySelector('.pg-lightbox-img') as HTMLImageElement;
    expect(big.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('悬停显示预览层，并且**跟着鼠标走**', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage();
    expect(document.querySelector('[data-image-preview]')).toBeNull();

    const btn = domContainer().querySelector('.pg-img-thumb-btn') as HTMLElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 300, clientY: 800 }));
      await Promise.resolve();
    });
    const preview = document.querySelector('[data-image-preview]') as HTMLImageElement;
    expect(preview).not.toBeNull();
    expect(preview.src.startsWith('data:image/png;base64,')).toBe(true);
    // 预览是"真实元素 + portal 到 body"：这样才能 fixed 跟随、且不被滚动容器裁掉
    expect(preview.parentElement).toBe(document.body);
    const at = (el: HTMLElement): { left: number; top: number } => ({
      left: Number.parseFloat(el.style.left),
      top: Number.parseFloat(el.style.top),
    });
    const first = at(preview);

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500, clientY: 700 }));
      await Promise.resolve();
    });
    const moved = at(document.querySelector('[data-image-preview]') as HTMLElement);
    expect(moved.left).not.toBe(first.left);
    expect(moved.top).not.toBe(first.top);

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-image-preview]')).toBeNull();
  });

  it('移除按钮仍在，且移除后条消失', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage();
    await act(async () => {
      (domContainer().querySelector('.pg-img-remove') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(domContainer().querySelector('[data-pending-images]')).toBeNull();
  });
});

describe('灯箱的关闭语义', () => {
  it('Esc 关闭，并且**不冒泡**（否则会顺手中断这一轮）', async () => {
    const onClose = vi.fn();
    const parent = vi.fn();
    mountDom(
      // 模拟 Composer 的 Esc 监听：灯箱必须把它挡在门外
      <div onKeyDown={parent}>
        <ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} alt="x" />
      </div>,
    );
    expect(document.querySelector('[data-image-lightbox]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 事件被 stopPropagation 拦在灯箱那一层：会话层的 handler 不该收到
    expect(parent).not.toHaveBeenCalled();
  });

  it('点背景关闭；点图片本身不关', async () => {
    const onClose = vi.fn();
    mountDom(<ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} alt="x" />);
    const box = document.querySelector('[data-image-lightbox]') as HTMLElement;

    await act(async () => {
      (box.querySelector('.pg-lightbox-img') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      box.click();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('src 为空时什么都不渲染（没开灯箱就不该有覆盖层）', () => {
    mountDom(<ImageLightbox src={null} onClose={() => {}} />);
    expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  });
});

/* ────────────────── 预览的尺寸与定位（纯函数，jsdom 里没有真实布局） ────────────────── */

describe('预览尺寸：按原图宽高比、长边夹在上下限', () => {
  it('大图缩到上限，比例不变（横图 / 竖图各一条）', () => {
    const wide = previewSize(1600, 900);
    expect(Math.max(wide.w, wide.h)).toBe(PREVIEW_MAX);
    expect(Math.abs(wide.w / wide.h - 1600 / 900)).toBeLessThan(0.02);

    const tall = previewSize(600, 1800);
    expect(Math.max(tall.w, tall.h)).toBe(PREVIEW_MAX);
    expect(Math.abs(tall.w / tall.h - 600 / 1800)).toBeLessThan(0.02);
  });

  it('小图放到下限为止，不把小图标拉成大果冻', () => {
    const tiny = previewSize(16, 16);
    expect(Math.max(tiny.w, tiny.h)).toBe(PREVIEW_MIN);
    expect(tiny.w).toBe(tiny.h);
  });

  it('中间尺寸原样（长边落在区间内就不缩放）；尺寸未知时给一个方形下限', () => {
    // 长边 180 落在 [PREVIEW_MIN, PREVIEW_MAX] 里 → 1:1 用原尺寸
    expect(previewSize(180, 140)).toEqual({ w: 180, h: 140 });
    const unknown = previewSize(0, 0);
    expect(unknown.w).toBe(PREVIEW_MIN);
    expect(unknown.h).toBe(PREVIEW_MIN);
  });
});

describe('预览定位：贴着光标，四个方向都不出屏', () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  it('默认在光标右上方（输入框在屏幕底部，往上飘才有空间）', () => {
    const pos = anchorStyle({ x: 200, y: vh - 20, w: 400, h: 300 });
    expect(pos.left).toBeGreaterThan(200);
    expect(pos.top).toBeLessThan(vh - 20);
  });

  it('右边放不下就翻到左边', () => {
    const pos = anchorStyle({ x: vw - 10, y: 400, w: 400, h: 300 });
    expect(pos.left).toBeLessThan(vw - 10);
    expect(pos.left + previewSize(400, 300).w).toBeLessThanOrEqual(vw);
  });

  it('上方放不下就翻到下面', () => {
    const pos = anchorStyle({ x: 300, y: 4, w: 400, h: 300 });
    expect(pos.top).toBeGreaterThan(4);
  });
});

/* ────────────────── 打开预览时不许选中底下的字 ────────────────── */

describe('看大图时页面被冻结（用户："拖动选中底下的字，能不能不让选中"）', () => {
  afterEach(() => {
    // 用例之间别把锁带走
    document.documentElement.style.userSelect = '';
    document.body.style.overflow = '';

  });

  it('打开灯箱：根元素禁选中 + body 锁滚动；关掉后**原样**恢复', async () => {
    document.documentElement.style.userSelect = 'text'; // 假装别人本来就设过
    mountDom(<ImageLightbox src="data:image/png;base64,AAA" onClose={() => {}} />);

    expect(document.documentElement.style.userSelect).toBe('none');
    expect(document.body.style.overflow).toBe('hidden');
    // 灯箱自己那一层也要禁（在它身上起手的拖选不该产生选区）
    const box = document.querySelector('[data-image-lightbox]') as HTMLElement;
    expect(box).not.toBeNull();

    await unmountDom();
    expect(document.documentElement.style.userSelect).toBe('text');
    expect(document.body.style.overflow).toBe('');
  });

  it('悬停预览打开期间同样禁选中（预览是 pointer-events:none，拖选会直接落到转录上）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage();
    const btn = domContainer().querySelector('.pg-img-thumb-btn') as HTMLElement;

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 300, clientY: 700 }));
      await Promise.resolve();
    });
    expect(document.documentElement.style.userSelect).toBe('none');

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(document.documentElement.style.userSelect).toBe('');
  });

  it('锁是幂等的：两个浮层叠加时，最后一个关掉才解锁', async () => {
    mountDom(
      <>
        <ImageLightbox src="data:image/png;base64,AAA" onClose={() => {}} />
        <ImageHoverPreview src="data:image/png;base64,AAA" anchor={{ x: 10, y: 10, w: 40, h: 40 }} />
      </>,
    );
    expect(document.documentElement.style.userSelect).toBe('none');

    await unmountDom();
    // 两个都卸载之后必须恢复干净（不能留下"永远解不开的锁"）
    expect(document.documentElement.style.userSelect).toBe('');
    expect(document.body.style.overflow).toBe('');

  });
});
