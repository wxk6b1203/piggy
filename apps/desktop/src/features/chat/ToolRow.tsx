/**
 * 工具调用行（DSH `ui-tool/src/client/tool/components/ToolRow.tsx` 的窄行版）。
 *
 * 用户 2026-09-23 的反馈："多消息以及多工具消息的情况下，主工作区空间利用率非常低，
 * 能不能跟 dsh 一样，用窄窄的可展开的折叠？" —— 实测就是这个问题：
 * 每个工具结果此前都渲染成**整块代码卡片**（6 行 `read` 结果 = 258px，3 行 `bash` = 201px，
 * 每块还带 16px 上下外边距），而 DSH 的一个工具调用在对话里是**一行 24px**：
 *
 * ```text
 * ▸ 运行命令 · pnpm test          ← 折叠：图标 + 标题 + 圆点 + 摘要（一行，超长省略号）
 *   展开 ↓ 原来的代码卡片照旧（高亮/折叠/复制/行数）
 * ```
 *
 * 摘要取自**调用参数**（`toolCalls` 索引，见 stores/messages.ts），失败行取结果首行并标红
 * （DSH 的 `errorSummary`）。标题表与变体表逐条对齐 DSH，见 `toolRowModel.ts`。
 *
 * 正文用 `DisclosureRow` 的 `hidden="until-found"`：折叠不等于不渲染 —— Ctrl+F 能搜到、
 * 读屏与复制拿得到（本仓纪律，DSH 在分组层做同一件事）。
 */
import { useState } from 'react';
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { Icon, type IconName } from '@/features/common/Icon';
import { CodeBlock } from './CodeBlock';
import { inferToolLang } from './highlight';
import { toolRowModel, type ToolVariant } from './toolRowModel';

/** 变体 → 前导图标（DSH `GenericToolCard` 的 `VARIANT_ICONS`：14px 字形放进 16px 框）。 */
const VARIANT_ICONS: Record<ToolVariant, IconName> = {
  search: 'search',
  read: 'book',
  bash: 'terminal',
  write: 'edit',
  edit: 'edit',
  code: 'code',
  others: 'tools',
};

export interface ToolRowProps {
  toolName: string | undefined;
  toolCallId?: string | undefined;
  /** 调用参数（`toolCalls[toolCallId]`；拿不到就是 undefined） */
  args?: Record<string, unknown> | undefined;
  isError: boolean;
  /** 结果正文（摘要兜底与错误行要用） */
  text: string;
}

export function ToolRow({ toolName, toolCallId, args, isError, text }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const model = toolRowModel(toolName, args, text, isError);
  const { lang } = inferToolLang(toolName, text);

  return (
    <div
      className="pg-trow"
      data-tool-row
      data-tool={toolName ?? undefined}
      data-variant={model.variant}
      data-state={model.state}
      data-tool-call-id={toolCallId || undefined}
      data-open={open || undefined}
    >
      <DisclosureRow
        icon={<Icon name={VARIANT_ICONS[model.variant]} size={14} />}
        title={model.title}
        open={open}
        expandable={text !== ''}
        onToggle={() => setOpen((v) => !v)}
        keepContentWhenOpen
        rowClassName="pg-trow-head"
        bodyProps={{ 'data-tool-body': '1' }}
        collapsedContent={
          <>
            {model.summary ? (
              <>
                <span className="pg-trow-sep" aria-hidden="true" />
                <span
                  className="pg-trow-summary"
                  data-summary-source={model.summaryFromResult ? 'result' : 'args'}
                  title={model.summary}
                >
                  {model.summary}
                </span>
              </>
            ) : null}
          </>
        }
      >
        {/* 正文照旧是那块代码卡片：折叠/高亮/行数/复制都在 */}
        <CodeBlock code={text} lang={lang} title={toolName ?? 'tool'} collapsible />
      </DisclosureRow>
    </div>
  );
}
