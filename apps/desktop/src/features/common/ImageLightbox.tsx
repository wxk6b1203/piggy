/**
 * 图片灯箱（04 §5.3）：点开看大图。
 *
 * 为什么自己写而不是用 antd 的 `Image` / `Image.PreviewGroup`：
 * `features/chat/**` 是 antd 禁区，而"点开大图"必须由**拥有图片的那个组件**触发
 * （它手上才有 blob/asset URL）。所以这里是一个零依赖的 portal 覆盖层：
 * 点击图片 → 铺满视口、`object-fit: contain` 居中；`Esc` / 点背景 / 点关闭按钮 → 关。
 *
 * 两个实现要点：
 * - **portal 到 `document.body`**：转录行有自己的层叠上下文与 `overflow`，
 *   留在行内会被裁掉（图片行在虚拟窗口里随时可能被卸载）；
 * - **`Esc` 只走 keydown、且 `stopPropagation`**：会话里 `Esc` 是"中断这一轮"，
 *   看大图时按 `Esc` 只该关图片，不能顺手把 agent 也停了。
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/**
 * 打开浮层时冻结页面的**选中与滚动**（2026-10-15 用户："点开预览之后，有可能拖动
 * 选中底下的字，能不能不让选中"）。
 *
 * 光靠覆盖层挡不住两件事：
 * - **选中**：`user-select` 是跨元素的 —— 在覆盖层上按下、拖到覆盖层之外，
 *   选区会继续长到下面的转录里。所以必须把 `user-select: none` 加到**根元素**上，
 *   关掉时再原样恢复（不是简单清空：别人可能本来就设过）。
 * - **滚动**：在覆盖层上拖动会"滚动链"到背后的转录（`overscroll-behavior` 只管
 *   自己这一层，挡不住整页滚动），所以同时锁 `body` 的 `overflow`。
 *
 * 用 **DOM 属性**而不是模块级计数器：同一时刻可能有多个浮层（灯箱 + 悬停预览），
 * 计数器写错就会留下"永远解不开的锁"；属性是幂等状态，而且谁都能读、卸载后不留残留。
 */
/**
 * 当前有几层浮层压着（灯箱 + 预览可能同时存在）。
 *
 * 为什么是**引用计数**而不是"给 body 打个标记"：标记方案分不清"这是第二个锁"与
 * "这是第一个锁"，一旦谁先解锁就把标记删了，后面的解锁全成了空操作 ——
 * 页面就永久停在"选不中字"的状态（单测 `锁是幂等的` 就是钉这条的）。
 */
let lockDepth = 0;
/** 加锁前的原值（只有第一个加锁的人记，最后一个解锁的人恢复）。 */
let prevUserSelect = '';
let prevBodyOverflow = '';

/** 打开浮层时冻结页面的选中与滚动。返回解锁函数（可重复调用）。 */
export function lockPage(): () => void {
  if (lockDepth === 0) {
    prevUserSelect = document.documentElement.style.userSelect;
    prevBodyOverflow = document.body.style.overflow;
  }
  lockDepth += 1;
  document.documentElement.style.userSelect = 'none';
  document.body.style.overflow = 'hidden';
  return () => {
    lockDepth = Math.max(0, lockDepth - 1);
    // 还有别的浮层压着 → 什么都不做（锁继续保持）
    if (lockDepth > 0) return;
    document.documentElement.style.userSelect = prevUserSelect;
    document.body.style.overflow = prevBodyOverflow;
  };
}

export interface ImageLightboxProps {
  /** 图片源（blob: 或 asset 协议 URL）；为空时什么都不渲染 */
  src: string | null;
  /** 关掉（`null` 或回调） */
  onClose: () => void;
  /** 无障碍名（一般是文件名） */
  alt?: string;
}

export function ImageLightbox({ src, onClose, alt = '' }: ImageLightboxProps) {
  /* ⚠️ `onClose` 走 ref，**不进 effect 依赖**（2026-10-15，被单测逼出来的真 bug）：
     调用方几乎总是传内联箭头函数（`onClose={() => setLightbox(null)}`），把它放进依赖
     会让 effect 每次渲染都重跑一遍 —— 于是 `lockPage()`/`unlock()` 反复叠加，
     卸载时留下一把**解不开的锁**（页面再也选不中字、body 也锁着滚动）。
     锁的依赖只能是"浮层开没开"这一件事。 */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!src) return;
    const unlock = lockPage();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 别让"关图片"变成"中断这一轮"（Composer 的 Esc 会 abort）
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unlock();
    };
  }, [src]);

  if (!src) return null;
  return createPortal(
    <div
      className="pg-lightbox"
      data-image-lightbox=""
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `图片预览：${alt}` : '图片预览'}
      onClick={onClose}
    >
      <button type="button" className="pg-lightbox-close" aria-label="关闭图片预览" onClick={onClose}>
        <Icon name="close" size={18} />
      </button>
      {/* 点图片本身不关（只有点背景才关） */}
      <img className="pg-lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
