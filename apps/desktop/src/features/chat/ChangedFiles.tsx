/**
 * 「本轮文件改动」卡片（DSH `ChangedFiles`，docs/12 §3.5）。
 *
 * ⚠️ 不是一行 chips——DSH 已在 commit `f937f4e23b` 删掉旧的 `本轮文件改动` 行，
 * 换成这张回合尾卡片，标题 `已编辑 {count} 个文件`（折叠阈值 4 行）。
 *
 * 数据来源差异：DSH 由宿主服务端读 `ChangesSummary`；Piggy 从转录流里的
 * `edit` / `write` 类工具调用就地聚合（零额外进程，docs/04 §1.6 同一思路），
 * 因此只有**文件计数**是确定的，`+N/-M` 行数增量不臆造、直接不显示。
 */
import { useState } from 'react';
import type { ContentBlock } from '@piggy/pi-protocol';
import { Icon } from '@/features/common/Icon';
import { FileIcon } from '@/features/common/FileIcon';

/** pi 里会改动文件的工具名（与 pi 的 tool 命名对齐）。 */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'create', 'notebook_edit']);

const COLLAPSED_ROWS = 4; // DSH ChangedFiles.tsx:18

export interface ChangedFile {
  path: string;
}

/** 从一条助手消息的内容块里抽出被改动的文件（按出现顺序去重）。 */
export function changedFilesOf(blocks: ContentBlock[]): ChangedFile[] {
  const seen = new Set<string>();
  const out: ChangedFile[] = [];
  for (const b of blocks) {
    const blk = b as { type?: string; name?: string; arguments?: unknown };
    if (blk.type !== 'toolCall' || !blk.name || !WRITE_TOOLS.has(blk.name)) continue;
    const path = pathOf(blk.arguments);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path });
  }
  return out;
}

function pathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'filename']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export function ChangedFiles({ files, onOpen }: { files: ChangedFile[]; onOpen?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const foldable = files.length > COLLAPSED_ROWS;
  const visible = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;

  return (
    <div className="pg-changedfiles" data-changed-files>
      {/* 60px 头部：40px 图标砖 + 标题 + 统计 */}
      <button
        className="pg-cf-header"
        onClick={() => onOpen?.(files[0]!.path)}
        title={files.map((f) => f.path).join('\n')}
      >
        <span className="pg-cf-tile">
          <span className="pg-cf-tilemark">
            <Icon name="code" size={10} />
          </span>
        </span>
        <span className="pg-cf-titles">
          <span className="pg-cf-title">已编辑 {files.length} 个文件</span>
          <span className="pg-cf-stat">在侧边栏预览</span>
        </span>
      </button>

      <ul className="pg-cf-list">
        {visible.map((f) => (
          <li key={f.path}>
            <button className="pg-cf-row" onClick={() => onOpen?.(f.path)} title={f.path}>
              <FileIcon name={f.path} size={13} />
              <span className="pg-cf-path">{f.path}</span>
            </button>
          </li>
        ))}
      </ul>

      {foldable && (
        <button className="pg-cf-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `全部 ${files.length} 个文件`}
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
      )}
    </div>
  );
}
