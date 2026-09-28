// @vitest-environment jsdom
/**
 * 压缩行在**对话**里的细节（用户 2026-09-23："上下文压缩的轨迹是无法看到细节的？"）。
 *
 * 这一行的数据来自分页（会话文件里的 `compaction` 条目，Rust `compaction_row` 转出的
 * `message`）。此前 Rust 只转 `summary` / `tokensBefore` / `timestamp`，
 * pi 的 `CompactionEntry` 里另外四个能回答"这次压缩做了什么"的字段全被丢在半路：
 *
 * | 字段 | 界面上的说法 |
 * |---|---|
 * | `firstKeptEntryId` | 保留自 `<id>` 起，之前的条目已被摘要取代 |
 * | `details.readFiles/modifiedFiles` | 涉及文件：读 N / 改 M（+ 改动文件名） |
 * | `usage.totalTokens` / `usage.cost.total` | 摘要调用 478,539 tok · $0.1234 |
 * | `fromHook` | 摘要来自扩展 |
 *
 * ⚠️ `systemMessage`（压缩后的整份新系统提示词）**不能**出现在这一行里——
 * 那是 Rust 侧刻意不转的字段，这里顺带钉一句（夹具故意带上它）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { MessageView } from '@/features/chat/MessageView';
import { domContainer, mountDom, unmountDom } from './dom-render';

afterEach(async () => {
  await unmountDom();
});

/** 真机形状（本机 `2026-09-21T14-18-43-680Z_01a0c455….jsonl` 里那条压缩条目）。 */
const ROW = {
  id: 'c1',
  role: 'compaction' as const,
  message: {
    role: 'compaction',
    summary: '## Goal\n构建 Piggy\n\n## Progress\n- 分页完成',
    tokensBefore: 561_660,
    firstKeptEntryId: '86e95bf3',
    details: {
      readFiles: ['docs/03-module-design.md', 'docs/04-frontend-design.md'],
      modifiedFiles: ['apps/desktop/src/stores/trajectory.ts'],
    },
    usage: { input: 475_045, output: 3_494, totalTokens: 478_539, cost: { total: 0.1234 } },
    fromHook: false,
    timestamp: '2026-09-22T16:59:27.763Z',
    // 真实条目里有这个字段；Rust 刻意不转（整份系统提示词，一条 10 KB+）
    systemMessage: { role: 'system', content: '不该出现在界面里的整份系统提示词' },
  },
};

describe('对话里的压缩行', () => {
  it('四样细节都渲染出来，且都不是推算的', () => {
    mountDom(<MessageView view={ROW as never} />);
    const root = domContainer();
    const row = root.querySelector('[data-compaction-row]');
    expect(row).not.toBeNull();

    expect(row!.querySelector('.pg-compaction-tokens')!.textContent).toContain('561,660');
    expect(row!.querySelector('[data-compaction-kept]')!.textContent).toContain('86e95bf3');
    expect(row!.querySelector('[data-compaction-files]')!.textContent).toContain('读 2 / 改 1');
    expect(row!.querySelector('[data-compaction-files]')!.textContent).toContain('trajectory.ts');
    const usage = row!.querySelector('[data-compaction-usage]')!.textContent ?? '';
    expect(usage).toContain('478,539');
    expect(usage).toContain('$0.1234');
  });

  it('摘要折在 `<details>` 里（默认不铺开），正文按 **markdown** 渲染', () => {
    mountDom(<MessageView view={ROW as never} />);
    const root = domContainer();
    const details = root.querySelector('.pg-compaction-summary') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    // 摘要本身是 markdown（pi 写的就是 `## Goal` 这种结构），转正后按标题/列表渲染：
    expect(details.querySelector('.pg-md h2')!.textContent).toBe('Goal');
    expect(details.querySelectorAll('.pg-md li').length).toBeGreaterThan(0);
    expect(details.textContent).not.toContain('##');
  });

  it('systemMessage 不许漏到界面（Rust 刻意不转，谁把它加回来这条就红）', () => {
    mountDom(<MessageView view={ROW as never} />);
    expect(domContainer().textContent).not.toContain('不该出现在界面里的整份系统提示词');
  });

  it('缺字段的老条目照旧能渲染：只有标题与摘要，不报错、不编数字', () => {
    mountDom(
      <MessageView
        view={{ id: 'c2', role: 'compaction', message: { role: 'compaction', summary: '旧格式摘要' } } as never}
      />,
    );
    const row = domContainer().querySelector('[data-compaction-row]')!;
    expect(row.textContent).toContain('上下文已压缩');
    expect(row.textContent).toContain('旧格式摘要');
    expect(row.querySelector('[data-compaction-kept]')).toBeNull();
    expect(row.querySelector('[data-compaction-usage]')).toBeNull();
  });
});
