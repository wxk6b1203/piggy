/**
 * 行内 diff 块（DSH `ui-primitives/src/DiffBlock.tsx` 的同构物）。
 *
 * 工具行展开时的正文：**这个文件到底被改成了什么样**。此前 `edit` 行的正文是
 * 一句"Applied 1 edit to …"（pi 的 `content`），改动内容一个字都看不到 ——
 * 用户 2026-09-25："DSH 可以展示 DIFF，我们能不能也搞"。
 *
 * 与 DSH 逐条对齐的部分：
 *  · 行型与底色：路径行（弱）/ 删除（红底）/ 新增（绿底）/ 上下文（无底）/ hunk 之间的 `⋯`；
 *  · **高度封顶**：超过 `maxLines` 只画**头 5 + 尾 4**，中间一颗折叠开关
 *    （`headLines = ceil(max/2)`，与 TerminalBlock 同一套切法）；
 *  · 折叠开关的文案口径：`展开剩下的 N 行` / `收起`。
 *
 * 保留的差异：**不做语法高亮**。DSH 的行内 diff 也不高亮（只有标签页里的 `FileDiff`
 * 才 `useCodeHighlighter`），所以这里没有差异；标签页那一侧见 `preview/DiffView.tsx`。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { CHAT_DIFF_MAX_LINES, diffBlockRows, type ParsedPatch } from '@/lib/diff';

/** 复制按钮：整份 diff 的纯文本（折叠掉的行也在，`- `/`+ `/两个空格的行首）。 */
function copyText(rows: ReturnType<typeof diffBlockRows>): string {
  return rows
    .map((row) => {
      switch (row.kind) {
        case 'del':
          return `- ${row.text}`;
        case 'add':
          return `+ ${row.text}`;
        case 'context':
          return `  ${row.text}`;
        default:
          return row.text;
      }
    })
    .join('\n');
}

export function DiffBlock({
  patch,
  maxLines = CHAT_DIFF_MAX_LINES,
}: {
  patch: ParsedPatch;
  /** 折叠前的行数上限（行内 9，标签页给 Infinity） */
  maxLines?: number;
}) {
  const rows = useMemo(() => diffBlockRows(patch), [patch]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (rows.length === 0) return null;

  const hidden = rows.length - maxLines;
  const capped = hidden > 0 && !expanded;
  // 与 TerminalBlock 同一套切法：头 ceil(n/2)、尾剩下的
  const headLines = Math.ceil(maxLines / 2);
  const tailLines = Math.max(0, maxLines - headLines);
  const head = capped ? rows.slice(0, headLines) : rows;
  const tail = capped ? rows.slice(rows.length - tailLines) : [];

  const copy = () => {
    void navigator.clipboard?.writeText(copyText(rows)).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1000);
      },
      () => {},
    );
  };

  return (
    <div className="pg-diff" data-diff-block>
      <button
        type="button"
        className="pg-diff-copy"
        onClick={copy}
        aria-label={copied ? '已复制' : '复制 diff'}
        title={copied ? '已复制' : '复制 diff'}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </button>
      <div className="pg-diff-body">
        {head.map((row, index) => (
          <div key={index} className="pg-diff-line" data-diff-kind={row.kind}>
            {row.text}
          </div>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className="pg-diff-fold"
            data-diff-fold
            aria-expanded={expanded}
            aria-label={expanded ? '收起 diff' : `展开剩下的 ${hidden} 行`}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
            {expanded ? '收起' : `展开剩下的 ${hidden} 行`}
          </button>
        )}
        {tail.map((row, index) => (
          <div key={`t${index}`} className="pg-diff-line" data-diff-kind={row.kind}>
            {row.text}
          </div>
        ))}
      </div>
    </div>
  );
}
