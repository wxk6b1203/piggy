/**
 * 文件比较视图（DSH `ui-deliverables/src/client/FileDiff.tsx` 的同构物）。
 *
 * 两种版式，工具条切换：
 *  · **统一**（默认）：两侧行号 + `+/-/ ` 号 + 原文，逐 hunk 画 `@@ … @@` 头；
 *  · **并排**：一段连续删除与紧跟其后的连续新增逐行对齐（`splitRows`），
 *    没有对应行的那一侧留空 —— DSH 用两个各自可滚的列，Piggy 这里是一行两格，
 *    行高一致、天然对齐（少一套滚动同步的机制，也就少一类不同步的 bug）。
 *
 * 与 DSH 一致的还有：`MAX_RENDERED_LINES` 截断并明说截断了；
 * 只有一侧有改动（纯新增/纯删除）时**不切并排**（另一半全是空白没有信息量）。
 *
 * 保留的差异：**不做语法高亮**。DSH 的 `FileDiff` 会 `useCodeHighlighter` 给两侧上色，
 * Piggy 的 shiki 管线挂在 `CodeBlock` 上（按整块文本上色），hunk 级别的双侧上色要另写一套
 * —— 这一版先不做（docs/14 的缺口表里记了）。
 */
import { hunkHeader, hunkRows, renderedHunks, splitRows, MAX_RENDERED_LINES, type DiffHunk } from '@/lib/diff';

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="pg-fd-hunkhead" data-diff-hunk-header>
      {hunkHeader(hunk)}
    </div>
  );
}

export function FileDiff({
  hunks,
  split = false,
  wrap = false,
}: {
  hunks: readonly DiffHunk[];
  split?: boolean;
  wrap?: boolean;
}) {
  const { hunks: shown, truncated } = renderedHunks(hunks);
  if (shown.length === 0) {
    return (
      <p className="pg-fd-note" role="status" data-diff-empty>
        这个文件没有内容变化。
      </p>
    );
  }
  const hasAdditions = shown.some((h) => h.lines.some((l) => l.startsWith('+')));
  const hasDeletions = shown.some((h) => h.lines.some((l) => l.startsWith('-')));
  const oneSided = hasAdditions !== hasDeletions;
  const sideBySide = split && !oneSided;

  return (
    <div className="pg-fd" data-review-view={sideBySide ? 'split' : 'unified'} data-review-wrap={wrap || undefined}>
      {truncated && (
        <p className="pg-fd-note" data-diff-truncated>
          改动太大，只画了前 {MAX_RENDERED_LINES} 行。
        </p>
      )}
      {shown.map((hunk, index) => (
        <section key={index} className="pg-fd-hunk">
          <HunkHeader hunk={hunk} />
          {sideBySide
            ? splitRows(hunk).map((row, at) => (
                <div key={at} className="pg-fd-splitline" data-diff-line={row.left?.kind === 'del' ? 'del' : row.right?.kind === 'add' ? 'add' : 'context'}>
                  <span className={`pg-fd-cell${row.left ? ` pg-fd-${row.left.kind}` : ' pg-fd-empty'}`}>
                    <span className="pg-fd-no">{row.left?.no ?? ''}</span>
                    <span className="pg-fd-text">{row.left?.text ?? ''}</span>
                  </span>
                  <span className={`pg-fd-cell${row.right ? ` pg-fd-${row.right.kind}` : ' pg-fd-empty'}`}>
                    <span className="pg-fd-no">{row.right?.no ?? ''}</span>
                    <span className="pg-fd-text">{row.right?.text ?? ''}</span>
                  </span>
                </div>
              ))
            : hunkRows(hunk).map((row, at) => (
                <div key={at} className={`pg-fd-line pg-fd-${row.kind}`} data-diff-line={row.kind}>
                  <span className="pg-fd-no">{row.old ?? ''}</span>
                  <span className="pg-fd-no">{row.new ?? ''}</span>
                  <span className="pg-fd-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
                  <span className="pg-fd-text">{row.text}</span>
                </div>
              ))}
        </section>
      ))}
    </div>
  );
}
