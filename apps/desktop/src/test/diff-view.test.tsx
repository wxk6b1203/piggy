// @vitest-environment jsdom
/**
 * 统一 diff 的解析与两个视图（用户 2026-09-25："DSH 可以展示 DIFF，我们能不能也搞"）。
 *
 * 这份用例盯的是**解析**这条最容易静默出错的路径：
 *  · `---`/`+++` 头**不是**增删行（把 `--- a/x` 数成删除行，加删行数就永远是错的）；
 *  · 两个 hunk 都要在（只画第一个 hunk 是最常见的一种"看着对"）；
 *  · `@@` 头没写行数时（`@@ -1 +1 @@`）按 1 行算（unified 规范允许省略 `,n`）；
 *  · `\ No newline at end of file` 不是内容行；
 *  · 行内块**头 5 + 尾 4**（`maxLines = 9`）与折叠开关。
 * 然后是两个视图：统一视图的两侧行号、并排视图的配对，以及改动卡片的 `+N −M`。
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  diffBlockRows,
  diffTotals,
  hunkRows,
  parseUnifiedPatch,
  patchOfResult,
  splitRows,
} from '@/lib/diff';
import { DiffBlock } from '@/features/chat/DiffBlock';
import { FileDiff } from '@/features/preview/FileDiff';
import { ChangedFiles } from '@/features/chat/ChangedFiles';
import { mountDom, unmountDom, domContainer } from './dom-render';

const PATCH = [
  '===================================================================',
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' ',
  '@@ -20,4 +21,5 @@',
  ' tail();',
  '+extra();',
  ' more();',
  ' end();',
  '',
].join('\n');

const q = (sel: string) => domContainer().querySelector(sel);
const qa = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('parseUnifiedPatch', () => {
  it('认出两个 hunk、路径与行数，头部不算增删', () => {
    const parsed = parseUnifiedPatch(PATCH)!;
    expect(parsed.path).toBe('src/a.ts');
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0]!.lines).toEqual([' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' ']);
    expect(parsed.hunks[1]!.oldStart).toBe(20);
    expect(parsed.hunks[1]!.newStart).toBe(21);
    // 加 3 删 1：`---`/`+++` 两行绝不能被算进来
    expect(diffTotals(parsed.hunks)).toEqual({ added: 3, removed: 1 });
  });

  it('省略行数的 @@ 头按 1 行算，反斜杠元信息不算内容', () => {
    const parsed = parseUnifiedPatch(
      ['--- f', '+++ f', '@@ -1 +1 @@', '-x', '+y', '\\ No newline at end of file', ''].join('\n'),
    )!;
    expect(parsed.hunks[0]!.oldLines).toBe(1);
    expect(parsed.hunks[0]!.newLines).toBe(1);
    expect(parsed.hunks[0]!.lines).toEqual(['-x', '+y']);
  });

  it('没有 hunk 的 patch → null（不画空框）', () => {
    expect(parseUnifiedPatch('--- a\n+++ a\n')).toBeNull();
    expect(parseUnifiedPatch('')).toBeNull();
  });

  it('patchOfResult 只认会改文件的工具，且 details 形状不可信', () => {
    const details = { patch: PATCH };
    expect(patchOfResult('edit', details)?.hunks).toHaveLength(2);
    expect(patchOfResult('bash', details), 'bash 的结果里就算有 patch 也不是文件改动').toBeNull();
    expect(patchOfResult('edit', { patch: 42 })).toBeNull();
    expect(patchOfResult('edit', null)).toBeNull();
  });
});

describe('two views', () => {
  it('统一视图：两侧行号，删除行只数旧侧、新增行只数新侧', () => {
    const hunk = parseUnifiedPatch(PATCH)!.hunks[0]!;
    expect(hunkRows(hunk)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'const a = 1;' },
      { kind: 'del', old: 2, new: undefined, text: 'const b = 2;' },
      { kind: 'add', old: undefined, new: 2, text: 'const b = 3;' },
      { kind: 'add', old: undefined, new: 3, text: 'const c = 4;' },
      { kind: 'context', old: 3, new: 4, text: '' },
    ]);
  });

  it('并排视图：一段删除与紧跟的新增逐行配对', () => {
    const hunk = parseUnifiedPatch(PATCH)!.hunks[0]!;
    const rows = splitRows(hunk);
    expect(rows[1]).toEqual({
      left: { no: 2, text: 'const b = 2;', kind: 'del' },
      right: { no: 2, text: 'const b = 3;', kind: 'add' },
    });
    // 多出来的新增行：右侧有、左侧没有
    expect(rows[2]!.left).toBeUndefined();
    expect(rows[2]!.right?.text).toBe('const c = 4;');
  });
});

describe('DiffBlock（行内）', () => {
  it('折叠时头 5 + 尾 4，展开后行数变多', async () => {
    const patch = parseUnifiedPatch(PATCH)!;
    const rows = diffBlockRows(patch);
    expect(rows[0]).toEqual({ kind: 'path', text: 'src/a.ts' });
    /* 路径 1 + hunk① 5 行 + `⋯` 1 + hunk② 4 行 = 11 行 > 9（折叠阈值） */
    expect(rows.filter((r) => r.kind === 'gap')).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(9);
    await act(async () => {
      mountDom(<DiffBlock patch={patch} />);
    });
    const lines = () => qa('.pg-diff-line').length;
    const capped = lines();
    expect(capped).toBeLessThanOrEqual(9);
    const fold = qa('[data-diff-fold]')[0] as HTMLButtonElement | undefined;
    expect(fold, '超过 9 行却没有折叠开关').toBeTruthy();
    await act(async () => {
      fold!.click();
    });
    expect(lines(), '展开后行数没有变多').toBeGreaterThan(capped);
    await unmountDom();
  });

  it('矮的 patch 不出现折叠开关', async () => {
    const patch = parseUnifiedPatch(['--- f', '+++ f', '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n'))!;
    await act(async () => {
      mountDom(<DiffBlock patch={patch} />);
    });
    expect(qa('[data-diff-fold]')).toHaveLength(0);
    expect(qa('.pg-diff-line')).toHaveLength(3);
    await unmountDom();
  });
});

describe('FileDiff（标签页）', () => {
  it('统一视图画出 hunk 头与行号；纯新增时不切并排', async () => {
    const hunks = parseUnifiedPatch(PATCH)!.hunks;
    await act(async () => {
      mountDom(<FileDiff hunks={hunks} split />);
    });
    expect(text(q('[data-diff-hunk-header]'))).toBe('@@ -1,4 +1,5 @@');
    expect(qa('[data-diff-line]').length).toBeGreaterThan(0);
    // 两侧都有改动 → 并排生效
    expect(q('[data-review-view]')?.getAttribute('data-review-view')).toBe('split');
    await unmountDom();

    const onlyAdds = parseUnifiedPatch(['--- f', '+++ f', '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n'))!.hunks;
    await act(async () => {
      mountDom(<FileDiff hunks={onlyAdds} split />);
    });
    expect(
      q('[data-review-view]')?.getAttribute('data-review-view'),
      '纯新增还切成并排：另一半全是空白，没有信息量',
    ).toBe('unified');
    await unmountDom();
  });
});

describe('ChangedFiles 卡片', () => {
  it('总计与每行都显示 +N −M；没有 patch 的文件一个数字都不显示', async () => {
    await act(async () => {
      mountDom(
        <ChangedFiles
          files={[
            { path: 'src/a.ts', callId: 'c1', added: 3, removed: 1 },
            { path: 'src/b.ts', callId: 'c2', added: null, removed: null },
          ]}
        />,
      );
    });
    expect(text(q('.pg-cf-title'))).toBe('已编辑 2 个文件');
    // 头部：总计（两个数字各自成 span，视觉上的间距由 CSS 的 gap 给）
    const totals = q('[data-changed-files] .pg-cf-stat .pg-cf-counts')!;
    expect(text(totals.querySelector('.pg-cf-added'))).toBe('+3');
    expect(text(totals.querySelector('.pg-cf-deleted'))).toBe('-1');
    const rows = qa('.pg-cf-row');
    expect(text(rows[0]?.querySelector('.pg-cf-counts')), '有 patch 的文件没显示行数').toBe('+3-1');
    expect(text(rows[1]?.querySelector('.pg-cf-counts')), '没有 patch 的文件被安上了行数').toBe('');
    await unmountDom();
  });
});
