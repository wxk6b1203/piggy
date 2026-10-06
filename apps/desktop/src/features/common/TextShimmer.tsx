/**
 * 运行中文字的扫光（DSH `ui-primitives/src/TextShimmer.tsx` + `.module.css` 的移植）。
 *
 * ## 它解决什么
 *
 * "这一行还在跑"要能被看见，但不能靠改字号/行高/颜色 —— 那些一动，行就会在完成时
 * 跳一下。DSH 的做法是**把文字复制一份叠在上面**，用一个移动的渐变遮罩扫过去：
 * 真文字留在原位（可选择、可读屏、可复制），装饰副本 `aria-hidden` + `inert`，
 * 只负责那一道亮光。几何完全不变。
 *
 * ## 与 DSH 的差别（只有 API 外壳）
 *
 * · 不用 `clsx`，类名拼字符串（本仓没有那个依赖）；
 * · `inert` 直接用布尔（React 19 支持；DSH 那边写 `''` 是 React 18 的兼容写法）；
 * · 颜色走本仓令牌：底色继承行的标题色，扫光用 `--pg-fg`（最亮那一档）。
 *
 * 嵌套语义照抄：一行的标题与摘要都套在自己的 `TextShimmer` 里，**只有最外层**渲染装饰
 * 副本（内层通过 context 认出来，只出文字）—— 否则一行里会出现多道不同步的扫光。
 */
import { createContext, memo, useContext, type ReactNode } from 'react';

/** `undefined` = 不在扫光里；`false` = 外层真文字；`true` = 外层的装饰副本。 */
const DecorativeCopy = createContext<boolean | undefined>(undefined);

export interface TextShimmerProps {
  children: ReactNode;
  /** 是否在动（嵌套实例沿用外层所在行的状态） */
  active?: boolean | undefined;
  className?: string | undefined;
  /** 同时加在真文字与装饰副本上的排版类（两者必须完全对齐） */
  contentClassName?: string | undefined;
}

function TextContent({ children, className }: Pick<TextShimmerProps, 'children' | 'className'>) {
  const decorative = useContext(DecorativeCopy);
  // 装饰副本里用 `data-shimmer-text` + CSS `content: attr(...)` 出字：
  // 这样它不参与布局测量，也不会被选中/读屏
  const generated = decorative === true && typeof children === 'string';
  return (
    <span
      className={`pg-shimmer-text${className ? ` ${className}` : ''}`}
      data-shimmer-text={generated ? children : undefined}
    >
      {generated ? null : children}
    </span>
  );
}

export const TextShimmer = memo(function TextShimmer({
  children,
  active = false,
  className,
  contentClassName,
}: TextShimmerProps) {
  const decorative = useContext(DecorativeCopy);
  // 嵌套：只出文字（整行的扫光由最外层那一个负责）
  if (decorative !== undefined) return <TextContent className={className}>{children}</TextContent>;
  const content = typeof children === 'string' ? <TextContent>{children}</TextContent> : children;
  return (
    <span className={`pg-shimmer${className ? ` ${className}` : ''}`} data-shimmer={active || undefined}>
      <DecorativeCopy.Provider value={false}>
        <span className={`pg-shimmer-content${contentClassName ? ` ${contentClassName}` : ''}`}>{content}</span>
      </DecorativeCopy.Provider>
      {active ? (
        <span className="pg-shimmer-decoration" aria-hidden="true" inert>
          <span className="pg-shimmer-sweep">
            <DecorativeCopy.Provider value>
              <span
                className={`pg-shimmer-content pg-shimmer-highlight${
                  contentClassName ? ` ${contentClassName}` : ''
                }`}
              >
                {content}
              </span>
            </DecorativeCopy.Provider>
          </span>
        </span>
      ) : null}
    </span>
  );
});
