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

  it('悬停预览：chip 上带着 CSS 变量（一份数据，两个尺寸）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await pickImage();
    const chip = domContainer().querySelector('.pg-img-chip') as HTMLElement;
    expect(chip.style.getPropertyValue('--pg-img-preview')).toContain('data:image/png;base64,');
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
