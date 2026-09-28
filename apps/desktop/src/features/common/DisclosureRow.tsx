/**
 * 窄行折叠（DSH `ui-primitives/src/DisclosureRow.tsx` + `DisclosureRow.module.css`）。
 *
 * 转录里**默认折起来的一行**都走这个组件：工具调用、思考、以及后续同类行。
 * 几何逐条照抄 DSH（那套数字是它的设计稿定死的，别在这里"差不多"）：
 *
 * ```text
 * 行高 24px · [16px 前导框] margin-right 6px [标题 13px/24px，flex:none] [内容…]
 * 折叠时前导框显示**图标**，hover/聚焦时换成**下箭头**（两个绝对定位叠着切 opacity）
 * 展开时前导框恒为**上箭头**；整行可点（role=button + Enter/Space）
 * ```
 *
 * 两条与 DSH 的**有意差异**：
 *
 * 1. DSH 的 `ToolRow` 只在展开时挂载正文（`{open && children}`），折叠时正文不在 DOM 里；
 *    这里用 `hidden="until-found"`（+ `beforematch`）把正文**留在 DOM 里但不可见**——
 *    于是 Ctrl+F 能搜到、读屏与复制也拿得到。这是本仓既有的一条纪律
 *    （"折叠 ≠ 不渲染"，见 CodeBlock 的 `pg-codeblock-more`），DSH 那边靠
 *    `useSearchableHidden` 在**分组**层做到了同一件事，我们把它下沉到行。
 * 2. 前导图标用 `Icon` 的 codicon 名（本仓图标体系），不引 DSH 的图标包。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/features/common/Icon';

export interface DisclosureRowProps {
  /** 前导图标（16px 框，字形 14px） */
  icon: ReactNode;
  /** 标题（`运行命令` / `思考` / …） */
  title: string;
  /** 展开状态（受控） */
  open: boolean;
  /** 有正文可展开（false = 前导框固定显示图标、整行不可点） */
  expandable: boolean;
  onToggle: () => void;
  /** 标题右侧的内容（DSH 是 `[2×2 圆点] gap8 [摘要 flex:1 ellipsis]`） */
  collapsedContent?: ReactNode;
  /** 展开时标题右侧也保留 `collapsedContent`（工具行要，思考行不要） */
  keepContentWhenOpen?: boolean;
  /** 额外的类名钩子（门禁与单测用 `data-*` 断言几何） */
  rowClassName?: string;
  className?: string;
  /** 折叠正文的 `data-*` 标记（门禁据此找正文） */
  bodyProps?: Record<string, string | undefined>;
  children?: ReactNode;
}

/** 折叠正文：留在 DOM 里、Ctrl+F 可搜（`hidden="until-found"` + `beforematch`）。 */
function SearchableHidden({
  hidden,
  reveal,
  bodyProps,
  children,
}: {
  hidden: boolean;
  reveal: () => void;
  bodyProps?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (hidden) {
      // 焦点还在里面（例如刚用键盘走到正文里的链接）就先别藏，改由 reveal 打开
      if (el.contains(el.ownerDocument.activeElement)) {
        reveal();
        return;
      }
      el.setAttribute('hidden', 'until-found');
    } else {
      el.removeAttribute('hidden');
    }
  }, [hidden, reveal]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 浏览器"在页面里找到"命中折叠区时会发 beforematch → 展开它（DSH 同款）
    const onBeforeMatch = () => reveal();
    el.addEventListener('beforematch', onBeforeMatch);
    return () => el.removeEventListener('beforematch', onBeforeMatch);
  }, [reveal]);
  return (
    <div ref={ref} {...bodyProps}>
      {children}
    </div>
  );
}

export function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  collapsedContent,
  keepContentWhenOpen = false,
  rowClassName,
  className,
  bodyProps,
  children,
}: DisclosureRowProps) {
  const bodyId = useId();
  const rowExpands = expandable;
  const [focused, setFocused] = useState(false);

  const reveal = useCallback(() => {
    if (!open && expandable) onToggle();
  }, [open, expandable, onToggle]);

  return (
    <div className={`pg-drow${className ? ` ${className}` : ''}`} data-open={open || undefined}>
      <div
        className={`pg-drow-head${rowClassName ? ` ${rowClassName}` : ''}`}
        data-disclosure-row
        data-expandable={rowExpands || undefined}
        role={rowExpands ? 'button' : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
        aria-controls={rowExpands ? bodyId : undefined}
        onFocus={rowExpands ? () => setFocused(true) : undefined}
        onBlur={rowExpands ? () => setFocused(false) : undefined}
        onClick={rowExpands ? onToggle : undefined}
        onKeyDown={
          rowExpands
            ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onToggle();
              }
            : undefined
        }
      >
        <span className="pg-drow-leading" data-disclosure-leading>
          {open ? (
            <Icon name="chevron-up" size={14} />
          ) : (
            <>
              <span className="pg-drow-icon">{icon}</span>
              {/* 折叠时 hover/聚焦才露面（DSH `.chevronHover`） */}
              {rowExpands ? (
                <span
                  className="pg-drow-chevron"
                  data-disclosure-chevron={focused ? 'focus' : undefined}
                >
                  <Icon name="chevron-down" size={14} />
                </span>
              ) : null}
            </>
          )}
        </span>
        <span className="pg-drow-title">{title}</span>
        {keepContentWhenOpen || !open ? collapsedContent : null}
      </div>
      {expandable ? (
        <SearchableHidden hidden={!open} reveal={reveal} bodyProps={{ id: bodyId, ...bodyProps }}>
          {children}
        </SearchableHidden>
      ) : null}
    </div>
  );
}
