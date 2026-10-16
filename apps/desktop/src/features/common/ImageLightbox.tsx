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
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface ImageLightboxProps {
  /** 图片源（blob: 或 asset 协议 URL）；为空时什么都不渲染 */
  src: string | null;
  /** 关掉（`null` 或回调） */
  onClose: () => void;
  /** 无障碍名（一般是文件名） */
  alt?: string;
}

export function ImageLightbox({ src, onClose, alt = '' }: ImageLightboxProps) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 别让"关图片"变成"中断这一轮"（Composer 的 Esc 会 abort）
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [src, onClose]);

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
