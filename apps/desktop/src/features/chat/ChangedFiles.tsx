/**
 * 「本轮文件改动」卡片（DSH `ChangedFiles`，docs/12 §3.5）。
 *
 * ⚠️ 不是一行 chips——DSH 已在 commit `f937f4e23b` 删掉旧的 `本轮文件改动` 行，
 * 换成这张回合尾卡片，标题 `已编辑 {count} 个文件`（折叠阈值 4 行）。
 *
 * ## 加删行数（用户 2026-09-25："DSH 可以展示 DIFF，我们能不能也搞"）
 *
 * DSH 的 `+407 −198` 与每行的 `+13 −5` 来自**宿主**读的工作区快照（`ChangesSummary`）。
 * Piggy 没有那个服务，但也不需要：pi 的 `edit` 结果 `details.patch` 就是**实际落盘**的
 * 统一 patch，加删行数从里面数出来（`lib/diff.ts` 的 `diffTotals`，在索引结果时算一次）。
 * 因此：
 *   · 有 patch 的文件 → 亮出 `+N −M`；
 *   · 没有 patch 的文件（`write` 覆盖写、参数里只有路径）→ **一个数字都不显示**，
 *     绝不拿"文件计数"冒充行数（那正是这张卡片早先只敢显示文件数的原因）。
 *
 * 交互差异：点击开一个**新标签页**（Piggy 没有 DSH 那种右栏预览面板）：
 * 有 diff 的开 **diff 标签**（`openDiffTab`），没有 diff 的退回文件预览
 * （`openPreviewTab`，与右栏文件树同一条路）。
 */
import { useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { FileIcon } from '@/features/common/FileIcon';

const COLLAPSED_ROWS = 4; // DSH ChangedFiles.tsx:18

export interface ChangedFile {
  path: string;
  /** 这条改动的工具调用 id（diff 标签页按它去结果索引里取 patch） */
  callId?: string;
  /** 加/删行数（`details.patch` 数出来的；没有 patch 就是 null） */
  added?: number | null;
  removed?: number | null;
}

/** 这张卡片的加删总计。 */
function totals(files: readonly ChangedFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { added, removed };
}

/** `+N −M` 两个数字（DSH `ChangedFiles.tsx` 的 `Counts`）。 */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="pg-cf-added">+{added}</span>
      <span className="pg-cf-deleted">-{removed}</span>
    </>
  );
}

export function ChangedFiles({
  files,
  onOpen,
}: {
  files: ChangedFile[];
  /** 打开某一条改动（有 callId → diff 标签；否则文件预览） */
  onOpen?: (file: ChangedFile) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const foldable = files.length > COLLAPSED_ROWS;
  const visible = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;
  const sum = totals(files);
  const anyCounts = files.some((f) => f.added != null || f.removed != null);

  return (
    <div className="pg-changedfiles" data-changed-files>
      {/* 60px 头部：40px 图标砖 + 标题 + 统计 */}
      <button
        className="pg-cf-header"
        onClick={() => onOpen?.(files[0]!)}
        title={files.map((f) => f.path).join('\n')}
      >
        <span className="pg-cf-tile">
          <span className="pg-cf-tilemark">
            <Icon name="code" size={10} />
          </span>
        </span>
        <span className="pg-cf-titles">
          <span className="pg-cf-title">已编辑 {files.length} 个文件</span>
          {/* DSH 这句写的是「在侧边栏预览」——它的右栏就是文档预览面板。
              Piggy 没有那个面板，点击是**开一个新标签页**，所以这句照实写。 */}
          <span className="pg-cf-stat">
            {anyCounts ? (
              <span className="pg-cf-counts">
                <Counts added={sum.added} removed={sum.removed} />
              </span>
            ) : null}
            <span className="pg-cf-hint">在标签页中打开</span>
          </span>
        </span>
      </button>

      <ul className="pg-cf-list">
        {visible.map((f) => (
          <li key={f.path}>
            <button className="pg-cf-row" onClick={() => onOpen?.(f)} title={f.path}>
              <FileIcon name={f.path} size={13} />
              <span className="pg-cf-path">{f.path}</span>
              <span className="pg-cf-counts">
                {f.added == null && f.removed == null ? null : (
                  <Counts added={f.added ?? 0} removed={f.removed ?? 0} />
                )}
              </span>
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
