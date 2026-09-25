/**
 * 右键菜单（docs/04 §2.4）。
 *
 * Piggy 之前**没有任何右键菜单**：会话行只有三个悬停图标（改名/导出/删除），
 * 再多一个就挤成一片。所以这里建一套最小可用的：
 *
 * * 渲染到 `document.body` 的 portal —— 会话行在可滚动的侧栏里，
 *   留在原地会被 `overflow: hidden` 裁掉；
 * * **贴边内收**：在屏幕右下角右键时菜单要往左上翻，而不是被视口切掉一半
 *   （这是右键菜单最常见的坏法，且 jsdom 量不到，见 docs/15 规矩 32）；
 * * Escape / 点外面 / 滚动 / 改窗口大小都关；
 * * 键盘可用：打开即聚焦，↑↓ 移动，Enter 选中，Home/End 到两端。
 *   鼠标能做的事键盘也要能做（docs/07 的同一条原则）。
 *
 * 不做子菜单、不做快捷键提示列——用到再说，先保证上面几条是真的。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label: string;
  /** 右侧灰色说明（比如"将调用模型"）；也当 title 用 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: MenuAnchor | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 先按原坐标渲染再量尺寸：菜单宽度取决于最长那一条的文案，
  // 猜一个固定宽度会在长文案上贴不住边。
  const [pos, setPos] = useState<MenuAnchor | null>(null);
  const [active, setActive] = useState(0);

  const enabled = items.filter((i) => !i.disabled);

  useLayoutEffect(() => {
    if (!at || !ref.current) {
      setPos(null);
      return;
    }
    const box = ref.current.getBoundingClientRect();
    const margin = 6;
    const maxX = Math.max(margin, window.innerWidth - box.width - margin);
    const maxY = Math.max(margin, window.innerHeight - box.height - margin);
    // 贴边内收：宁可盖住一点触发处，也不要被视口切掉
    setPos({ x: Math.min(Math.max(margin, at.x), maxX), y: Math.min(Math.max(margin, at.y), maxY) });
  }, [at, items.length]);

  // 打开就把焦点收进来：不然 Escape 与方向键都落在底下的会话行上。
  //
  // ⚠️ 必须等 `pos` 算完（`ready`）：第一帧是 `visibility: hidden` 的测尺寸帧，
  // **隐藏元素 focus() 会静默失败**——菜单看着正常、键盘却完全用不了。
  // 这个坑是浏览器门禁量出来的（jsdom 里 focus 不做可见性判断，永远"通过"）。
  const ready = pos !== null;
  useEffect(() => {
    if (!at || !ready) return;
    setActive(0);
    ref.current?.focus();
  }, [at, ready]);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    // capture 阶段：侧栏、工作区里任何一层滚动都该关掉，不然菜单会浮在原地
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [at, onClose]);

  const run = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return;
      onClose();
      void item.onSelect();
    },
    [onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (enabled.length === 0) return;
    const move = (delta: number) => {
      e.preventDefault();
      const cur = enabled.findIndex((i) => i.id === items[active]?.id);
      const next = (cur + delta + enabled.length) % enabled.length;
      setActive(items.indexOf(enabled[next]!));
    };
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') {
      e.preventDefault();
      setActive(items.indexOf(enabled[0]!));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(items.indexOf(enabled[enabled.length - 1]!));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = items[active];
      if (it) run(it);
    }
  };

  if (!at || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      className="pg-menu"
      role="menu"
      tabIndex={-1}
      data-pg-menu
      aria-label="会话操作"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        left: pos?.x ?? at.x,
        top: pos?.y ?? at.y,
        // 量尺寸那一帧先藏起来，避免看到菜单从错误位置跳一下
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          data-menu-item={it.id}
          className={`pg-menu-item${it.danger ? ' is-danger' : ''}${i === active ? ' is-active' : ''}`}
          disabled={it.disabled}
          title={it.hint}
          onMouseEnter={() => setActive(i)}
          onClick={() => run(it)}
        >
          <span className="pg-menu-label">{it.label}</span>
          {it.hint && <span className="pg-menu-hint">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
