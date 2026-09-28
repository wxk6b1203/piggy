/**
 * Seti 文件图标（docs/13 §7 排名 #8）——直接复用 VS Code 内置的 Seti 图标字体，
 * 与 VS Code 资源管理器里的文件图标同源同形。
 *
 * 解析优先级（与 VS Code 的图标主题一致）：完整文件名 → 扩展名 → 语言 → 默认文件图标。
 * 映射表由 `scripts/sync-seti-icons.mjs` 从 VS Code 检出生成。
 */
import { SETI_DEFS, SETI_EXT, SETI_LANG, SETI_NAME, SETI_FILE } from './seti-icons';
import { baseName } from '@/lib/paths';

export interface FileIconProps {
  /** 文件名或路径（取 basename 参与匹配） */
  name: string;
  /** 目录则用文件夹图标 */
  isDir?: boolean;
  /** 已展开的目录（视觉上换一个文件夹字形） */
  open?: boolean;
  size?: number;
  className?: string;
}

/** 目录图标没有独立字体字形，用 codicon 的文件夹（保持与其余 UI 一致）。 */
export function FileIcon({ name, isDir, open, size = 14, className }: FileIconProps) {
  if (isDir) {
    return (
      <span
        className={`pg-fileicon pg-fileicon-dir${className ? ` ${className}` : ''}`}
        style={{ fontSize: size }}
        aria-hidden="true"
      >
        {/* 目录沿用 codicons，避免再引一套文件夹字体 */}
        <i className={`codicon codicon-${open ? 'folder-opened' : 'folder'}`} style={{ fontSize: size }} />
      </span>
    );
  }

  const def = resolve(name);
  if (!def) {
    return (
      <span className={`pg-fileicon${className ? ` ${className}` : ''}`} style={{ fontSize: size }} aria-hidden="true">
        <i className="codicon codicon-file" style={{ fontSize: size }} />
      </span>
    );
  }

  return (
    <span
      className={`pg-fileicon${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, color: def.f }}
      aria-hidden="true"
    >
      {def.c}
    </span>
  );
}

/** 文件名 → Seti 定义；匹配不到返回 undefined（调用方回退到 codicon）。 */
export function resolve(name: string): { c: string; f?: string } | undefined {
  const base = baseName(name);
  const lower = base.toLowerCase();

  const byName = SETI_NAME[lower];
  if (byName && SETI_DEFS[byName]) return SETI_DEFS[byName];

  // 多重扩展名（.d.ts / .test.tsx）要逐段回退
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const ext = parts.slice(i).join('.');
    const byExt = SETI_EXT[ext];
    if (byExt && SETI_DEFS[byExt]) return SETI_DEFS[byExt];
  }

  const byLang = SETI_LANG[lower];
  if (byLang && SETI_DEFS[byLang]) return SETI_DEFS[byLang];

  return SETI_DEFS[SETI_FILE];
}
