/**
 * Composer 工具行里的下拉选择器外壳（权限档位 / 模型 + thinking 共用）。
 *
 * 视觉对齐 DSH `.select`：透明底、r8、h28、菜单面 r12 + elevation-prominent。
 * 刻意不用 antd `Popover`：它自带内边距/箭头/动效，要压回 DSH 的几何得写一堆覆盖样式；
 * 这里的菜单只有"一列可选项"，自己画更短也更可控。点击外部 / Esc 关闭。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { windowEvents } from '@/lib/windowEvents';
import { Icon, type IconName } from '@/features/common/Icon';

export interface PickerItem {
  id: string;
  label: string;
  /** 次要说明（渲染在标签右侧，dim 色） */
  hint?: string;
  /** 补充说明（第二行小字） */
  detail?: string;
  icon?: IconName;
  /**
   * 自定义图标节点（真实应用图标是 `<img>`，不是 codicon 字形）。
   * 给了它就优先于 `icon` —— 「打开方式」的菜单用它放宿主抠出来的应用图标。
   */
  iconNode?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** 分组标题（同一 group 只在首项前渲染一次） */
  group?: string;
}

export interface PickerProps {
  /** 触发按钮内容 */
  children: ReactNode;
  items: PickerItem[];
  onPick: (id: string) => void;
  title?: string;
  /** 菜单宽度 */
  width?: number;
  /**
   * 弹出方向：`up`（默认，Composer 在窗口底部，向上弹）/ `down`（会话头部，向下弹）。
   * 会话头部的「打开方式」在窗口顶部，向上弹会顶出可视区。
   */
  side?: 'up' | 'down';
  /** 触发按钮的 className / title / 是否禁用 */
  className?: string;
  buttonTitle?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
  /** 菜单底部固定说明 */
  footer?: ReactNode;
  /** 展开状态变化（用于按需拉取菜单数据） */
  onOpenChange?: (open: boolean) => void;
  /**
   * 外部唤起信号名（`windowEvents`）。命令面板（⌘L 选模型 / ⌘E 循环思考）没有自己的按钮，
   * 靠发这个信号让这里展开真正的菜单——而不是让命令变成一个没人听的 emit。
   */
  openSignal?: string;
}

export function Picker({
  children,
  items,
  onPick,
  title,
  width = 300,
  side = 'up',
  className,
  buttonTitle,
  disabled,
  loading,
  emptyText = '无可选项',
  footer,
  onOpenChange,
  openSignal,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; up?: number; down?: number } | null>(null);

  const setOpenAndNotify = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // 外部唤起（命令面板）：只在"打开"方向生效，避免和点击切换打架
  useEffect(() => {
    if (!openSignal) return;
    return windowEvents.on(openSignal, () => {
      setOpen(true);
      onOpenChange?.(true);
    });
    // onOpenChange 是每次渲染新建的闭包，故意不进依赖（否则会反复重订阅）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  // 关闭：点击外部 / Esc。默认向上弹（锚点在窗口底部，用 bottom 定位）；
  // side='down' 时改成从锚点下缘往下（会话头部）。
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos(
        side === 'down'
          ? { left, down: r.bottom + 6 }
          : { left, up: window.innerHeight - r.top + 6 },
      );
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpenAndNotify(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenAndNotify(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, width, side]);

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={className}
        title={buttonTitle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpenAndNotify(!open)}
      >
        {children}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="pg-picker-menu"
              role="listbox"
              aria-label={title}
              style={{
                left: pos.left,
                width,
                ...(pos.down === undefined ? { bottom: pos.up } : { top: pos.down }),
              }}
            >
              {title ? <div className="pg-picker-title">{title}</div> : null}
              {loading ? <div className="pg-picker-note">加载中…</div> : null}
              {!loading && items.length === 0 ? <div className="pg-picker-note">{emptyText}</div> : null}
              <div className="pg-picker-list">
                {items.map((it) => {
                  const header = it.group && it.group !== lastGroup ? it.group : null;
                  lastGroup = it.group ?? lastGroup;
                  return (
                    <div key={it.id}>
                      {header ? <div className="pg-picker-group">{header}</div> : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={!!it.active}
                        className={`pg-picker-item${it.active ? ' pg-picker-item-active' : ''}`}
                        disabled={it.disabled}
                        onClick={() => {
                          setOpenAndNotify(false);
                          onPick(it.id);
                        }}
                      >
                        {it.iconNode ?? (it.icon ? <Icon name={it.icon} size={13} /> : null)}
                        <span className="pg-picker-label">{it.label}</span>
                        {it.hint ? <span className="pg-picker-hint">{it.hint}</span> : null}
                        {it.active ? <Icon name="check" size={13} /> : null}
                      </button>
                      {it.detail ? <div className="pg-picker-detail">{it.detail}</div> : null}
                    </div>
                  );
                })}
              </div>
              {footer ? <div className="pg-picker-footer">{footer}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
