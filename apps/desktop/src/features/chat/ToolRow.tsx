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
 * 正文**只在展开时挂载**（DSH `DisclosureRow` 的 `{open && children}`）：
 * 折叠时那一块代码卡片（含 shiki 高亮的整棵 DOM）根本不存在 —— 一屏几十个工具结果时
 * 这是实打实的开销差别。
 */
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { slotKey, useRowFlag, type RowMemory } from '@/lib/rowMemory';
import { Icon } from '@/features/common/Icon';
import { CodeBlock } from './CodeBlock';
import { inferToolLang } from './highlight';
import { toolRowModel, VARIANT_ICONS } from './toolRowModel';

export interface ToolRowProps {
  toolName: string | undefined;
  toolCallId?: string | undefined;
  /** 调用参数（`toolCalls[toolCallId]`；拿不到就是 undefined） */
  args?: Record<string, unknown> | undefined;
  isError: boolean;
  /** 结果正文（摘要兜底与错误行要用）；**流式中还没有结果 = 空串** */
  text: string;
  /**
   * 结果还没到、而且这一轮还在跑（`data-state="running"`）。
   *
   * 这一行从助手的 `toolCall` 块一出现就在（见 `ToolCallRow` 的文件头），
   * 所以"正在跑"是一个**行状态**，不是"还没渲染"。
   */
  running?: boolean | undefined;
  /** 这一行的身份：展开态记忆（见 lib/rowMemory；缺省 = 不记忆） */
  memory?: RowMemory | undefined;
}

export function ToolRow({ toolName, toolCallId, args, isError, text, running = false, memory }: ToolRowProps) {
  /* 展开态记忆在行外：滚出虚拟窗口的行会被卸载，行内 useState 会跟着丢
     （用户报："工具行展开看完，滚上去再滚回底部又折回去了"）。 */
  const [open, setOpen] = useRowFlag(slotKey(memory, 'tool'), 'open');
  const model = toolRowModel(toolName, args, text, isError);
  const { lang } = inferToolLang(toolName, text);

  return (
    <div
      className="pg-trow"
      data-tool-row
      data-tool={toolName ?? undefined}
      data-variant={model.variant}
      data-state={running ? 'running' : model.state}
      data-tool-call-id={toolCallId || undefined}
      data-open={open || undefined}
    >
      <DisclosureRow
        icon={<Icon name={VARIANT_ICONS[model.variant]} size={14} />}
        title={model.title}
        running={running}
        open={open}
        /* 结果还没到就没有正文可展开（流式中的工具行只有"标题 + 参数摘要"） */
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
        <CodeBlock
          code={text}
          lang={lang}
          title={toolName ?? 'tool'}
          collapsible
          memoryKey={slotKey(memory, 'tool:body')}
        />
      </DisclosureRow>
    </div>
  );
}
