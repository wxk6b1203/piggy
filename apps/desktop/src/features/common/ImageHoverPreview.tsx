/**
 * 悬停图片预览（04 §7）：鼠标移到缩略图上时，跟着光标显示一张**按原图宽高比**的预览。
 *
 * ## 为什么不是 CSS `::after` + `background-image`
 *
 * 第一版就是那么写的（一个固定 160×160 的 `::after` 方块 + `background-image`），
 * 2026-10-15 用户反馈"没生效"。三个真实原因，单靠 CSS 一个都解决不了：
 *
 * 1. **透明/深色的图等于没显示**：`background-image` 没有边框也没有底色，
 *    一张透明 PNG（或内容本身是深色的图）在深色界面上就是一片空白 —— 看起来像没触发；
 * 2. **跟随不了鼠标**：伪元素只能贴在自己的宿主上，没法跟着光标走；
 * 3. **会被裁掉**：待发图片条是 `overflow-x: auto` 的滚动容器（而且它就在屏幕最底部），
 *    伪元素长在上面一点就会被裁。
 *
 * 所以改成**真实元素 + `position: fixed` + portal**：fixed 不受任何祖先的 `overflow`
 * 约束，尺寸按原图宽高比算（有上下限，见下），并且带边框与投影，透明图也看得见。
 *
 * ## 尺寸口径（用户："放大一点点但是不要太多"）
 *
 * 长边限制在 {@link PREVIEW_MIN}–{@link PREVIEW_MAX} 之间**等比**缩放：
 * 大图缩到 200，小图最多放到 128（不把小图标拉成大果冻）。比例始终是原图的。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { lockPage } from './ImageLightbox';

/**
 * 预览长边的上下限（px）。
 *
 * 这是"看清是哪张图"，不是看图器（看大图走灯箱），所以上限压在视口高度的一半以内，
 * 免得在屏幕底部输入框那里弹出半屏。2026-10-15 用户口径：96–140 偏小 → 调到 128–200。
 */
export const PREVIEW_MIN = 128;
export const PREVIEW_MAX = 200;
/** 与光标的间距，避免预览盖住指针本身。 */
const CURSOR_GAP = 14;
/** 与视口边缘留的余量。 */
const EDGE = 8;

export interface PreviewAnchor {
  /** 光标位置（视口坐标） */
  x: number;
  y: number;
  /** 原图尺寸（naturalWidth/Height）；未知时按 1:1 方块处理 */
  w: number;
  h: number;
}

/** 按原图宽高比算预览尺寸：长边夹在 [PREVIEW_MIN, PREVIEW_MAX]，比例不变。 */
export function previewSize(w: number, h: number): { w: number; h: number } {
  const sw = w > 0 ? w : 1;
  const sh = h > 0 ? h : 1;
  const long = Math.max(sw, sh);
  // 大图缩到上限、小图放大到下限，中间的原样；两边都夹住，所以长边必落在区间内
  const scale = Math.max(PREVIEW_MIN / long, Math.min(1, PREVIEW_MAX / long));
  return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

/**
 * 窗口在光标哪一侧、放得下放不下。
 *
 * 默认在光标**右上方**（`left: x + GAP`、`bottom: y - GAP`）—— 输入框在屏幕底部，
 * 往上飘才有空间。右侧放不下就翻到左边，上方放不下就翻到下面。
 * 抽成纯函数是为了让这四个方向都能被单测穷举（jsdom 没有真实布局）。
 */
export function anchorStyle(a: PreviewAnchor): { left: number; top: number } {
  const { w, h } = previewSize(a.w, a.h);
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const left = a.x + CURSOR_GAP + w + EDGE > vw ? a.x - CURSOR_GAP - w : a.x + CURSOR_GAP;
  const above = a.y - CURSOR_GAP - h;
  const top = above < EDGE ? a.y + CURSOR_GAP : above;
  return {
    left: Math.max(EDGE, Math.min(left, vw - w - EDGE)),
    top: Math.max(EDGE, Math.min(top, vh - h - EDGE)),
  };
}

export interface ImageHoverPreviewProps {
  src: string;
  /** 原图尺寸（算预览尺寸用；未知就传 0） */
  naturalW?: number;
  naturalH?: number;
  anchor: PreviewAnchor | null;
  alt?: string;
}

/** 光标在图片上时渲染的预览层；`anchor` 为 `null` 时什么都不渲染。 */
export function ImageHoverPreview({ src, anchor, alt = '' }: ImageHoverPreviewProps) {
  const open = anchor !== null;
  /* 预览在的时候一样要挡住"拖选底下的字"（同 `ImageLightbox` 的理由）。
     `pointer-events: none` 让指针事件穿过预览，所以拖选确实会落到下面的转录上。 */
  useEffect(() => {
    if (!open) return;
    return lockPage();
  }, [open]);

  if (!anchor) return null;
  const size = previewSize(anchor.w, anchor.h);
  const pos = anchorStyle(anchor);
  return createPortal(
    <img
      className="pg-img-preview"
      data-image-preview=""
      src={src}
      alt={alt}
      style={{ width: size.w, height: size.h, left: pos.left, top: pos.top }}
    />,
    document.body,
  );
}
