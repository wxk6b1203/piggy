/**
 * 窄行折叠（DSH `ui-primitives/src/DisclosureRow.tsx` + `DisclosureRow.module.css`）。
 *
 * 转录里**默认折起来的一行**都走这个组件：工具调用、思考、清单、以及后续同类行。
 * 几何逐条照抄 DSH（那套数字是它的设计稿定死的，别在这里"差不多"）：
 *
 * ```text
 * 行高 24px · [16px 前导框] margin-right 6px [标题 13px/24px，flex:none] [内容…]
 * 折叠时前导框显示**图标**，hover/聚焦时换成**下箭头**（两个绝对定位叠着切 opacity）
 * 展开时前导框恒为**上箭头**；整行可点（role=button + Enter/Space）
 * ```
 *
 * ## 折叠 = 正文**不挂载**（2026-09-24 改为与 DSH 一致）
 *
 * DSH 就是 `{open && children}`：折叠时正文不在 DOM 里。本仓此前用
 * `hidden="until-found"` + `beforematch` 把它留在 DOM 里（想让 Ctrl+F 搜到折叠内容），
 * 那是自己发明的路子 —— 代价是每一折叠行都要渲染一遍长正文（一屏几十个工具结果时
 * 是实打实的 DOM 与样式开销），而且滚动搜索命中折叠区还要靠 `beforematch` 这种边缘特性。
 * 现在照 DSH：**折叠 = 不渲染**。Ctrl+F 搜不到折叠内容，与 DSH 一致。
 *
 * 保留的只有一处非行为差异：前导图标用 `Icon` 的 codicon（本仓图标体系），
 * 不引 DSH 的图标包。
 */
import { useState, type ReactNode } from 'react';
import { Icon } from '@/features/common/Icon';
import { TextShimmer } from '@/features/common/TextShimmer';

export interface DisclosureRowProps {
  /** 前导图标（16px 框，字形 14px） */
  icon: ReactNode;
  /** 标题（`运行命令` / `思考` / …） */
  title: string;
  /** 这一行**正在跑**（DSH 同名 prop）：标题与折叠内容一起套文字扫光，几何不变 */
  running?: boolean | undefined;
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

export function DisclosureRow({
  icon,
  title,
  running = false,
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
  const rowExpands = expandable;
  const [focused, setFocused] = useState(false);

  return (
    <div className={`pg-drow${className ? ` ${className}` : ''}`} data-open={open || undefined}>
      <div
        className={`pg-drow-head${rowClassName ? ` ${rowClassName}` : ''}`}
        data-disclosure-row
        data-expandable={rowExpands || undefined}
        role={rowExpands ? 'button' : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
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
        <TextShimmer active={running} className="pg-drow-text">
          <TextShimmer className="pg-drow-title">{title}</TextShimmer>
          {keepContentWhenOpen || !open ? collapsedContent : null}
        </TextShimmer>
      </div>
      {/* DSH：折叠 = 正文不挂载（`{open && children}`）。`bodyProps` 是本仓给测试/门禁
          留的标记，跟着正文一起出现、一起消失。 */}
      {open && expandable ? <div {...bodyProps}>{children}</div> : null}
    </div>
  );
}
