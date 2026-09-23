/**
 * 图标（docs/13）：直接复用 VS Code 官方图标字体 @vscode/codicons。
 *
 * 与 VS Code 的关系：VS Code 自身在 build 时把 `@vscode/codicons/dist/codicon.ttf`
 * 拷进 `src/vs/base/browser/ui/codicons/codicon/`（build/gulpfile.editor.ts:39-41），
 * Piggy 直接依赖同一个 npm 包，字形与 VS Code 完全一致。
 *
 * 注意：字体为 CC-BY-4.0（需署名），CSS 包装为 MIT；署名见 THIRD_PARTY_NOTICES.md。
 */
import type { CSSProperties } from 'react';
import type { IconName } from './codicon-names';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 字号（px）；codicon 基线按 16px 设计，缩小后仍对齐良好。 */
  size?: number;
  /** 持续旋转（loading/sync 类）。 */
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
  /** 有 title 时图标语义化为可访问元素；无 title 时对读屏隐藏（纯装饰）。 */
  title?: string;
}

export function Icon({ name, size = 16, spin = false, className = '', style, title }: IconProps) {
  const cls = `codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${className ? ` ${className}` : ''}`;
  return (
    <i
      className={cls}
      style={size === 16 ? style : { fontSize: size, ...style }}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  );
}
