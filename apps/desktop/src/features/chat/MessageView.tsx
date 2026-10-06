/** 消息渲染器（antd-free，docs/04 §2 铁律）：按 role 分发，内容块轻渲染。
 *
 *  对齐 DSH（docs/12 §3.2/§3.3/§3.11）：
 *  - **没有角色芯片 / 头像 / badge**——身份只靠「右对齐气泡」vs「整宽正文」表达；
 *  - 用户 = `UserStyleBubble`（r22 / padding 10px 16px / 右对齐）；
 *  - 助手 = 整宽 markdown + 结尾操作行（`.actions { margin-top:16px; margin-left:-6px }`）。
 *
 *  ## 流式与落定是**同一个渲染器**（2026-09-24 重整）
 *
 *  早先流式的那些块由 `lib/live` 的 DOM 引擎另画一套，转正时再整体换成这一套 ——
 *  于是同一行会出现两遍（用户："工具之类的会被逐步输出，最后打印"）。
 *  现在两者走**同一份代码**：`view.live` 有内容就是流式中（文本按纯文本画、思考/工具行
 *  与落定后同构），`view.message.content` 是权威内容。两条路产出的都是
 *  {@link RenderBlock}，块下标就是 pi 的 `contentIndex`，所以 React key 在转正前后不变
 *  —— 组件**不重挂**，只有 props 变（DSH 的 `status: running → settled` 同构）。
 *
 *  另加压缩行（`compaction`）：分页从会话文件读时，压缩条目是历史里真实存在的一行
 *  （docs/03 §2.19），DSH 的对话里同样有「上下文已压缩」。
 */
import { useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { MessageView as MessageViewRow } from '@/stores/messages';
import type { AgentMessage, ContentBlock } from '@piggy/pi-protocol';
import { CodeBlock } from './CodeBlock';
import { inferToolLang } from './highlight';
import { Icon } from '@/features/common/Icon';
import { ChangedFiles, type ChangedFile } from './ChangedFiles';
import { baseName, resolveAgainst } from '@/lib/paths';
import { editedCallsOf } from '@/lib/diff';
import { useTabs } from '@/stores/tabs';
import { openDiffTab, openPreviewTab } from '@/features/workspace/EditorArea';
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { Markdown, StreamingMarkdown } from './markdown';
import { TextShimmer } from '@/features/common/TextShimmer';
import { ToolRow } from './ToolRow';
import { ToolCallRow } from './ToolCallRow';
import { NoticeRow } from './NoticeRow';
import { TodoRow } from './TodoRow';
import { useTodoSupported } from '@/stores/todo';
import type { TodoItem } from '@/lib/todoModel';
import type { TranscriptDetail } from '@/stores/appConfig';
import { firstLine } from './toolRowModel';
import { turnFailure, type TurnFailure } from '@/lib/turnFailure';
import { formatExactTokens } from '@/lib/tokenFormat';
import { slotKey, useRowFlag, type RowMemory } from '@/lib/rowMemory';

/**
 * 一个**待渲染的块**：流式与落定两条路的公共形状。
 *
 * `index` 就是块在消息里的下标（= pi 的 `contentIndex`）：React key 与行记忆插槽都用它，
 * 于是"流式那一行"与"转正那一行"是同一个组件实例（不重挂 → 展开态不丢、DOM 不重建）。
 */
type RenderBlock =
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string; streaming: boolean }
  | { kind: 'toolCall'; callId: string; name: string; args: Record<string, unknown> | undefined }
  | { kind: 'image'; block: ContentBlock }
  | { kind: 'other'; block: ContentBlock };

/** 权威内容 → 渲染块。 */
function settledBlocks(content: unknown): RenderBlock[] {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    const b = block as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    };
    switch (b.type) {
      case 'text':
        return { kind: 'text', text: b.text ?? '', streaming: false };
      case 'thinking':
        return { kind: 'thinking', text: b.thinking ?? '', streaming: false };
      case 'toolCall':
        return {
          kind: 'toolCall',
          callId: b.id ?? '',
          name: b.name ?? 'tool',
          args:
            b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments)
              ? (b.arguments as Record<string, unknown>)
              : undefined,
        };
      case 'image':
        return { kind: 'image', block: block as ContentBlock };
      default:
        return { kind: 'other', block: block as ContentBlock };
    }
  });
}

/** 流式槽位 → 渲染块（`contentIndex` 就是下标，空槽位跳过但**保留下标**）。 */
function liveBlocks(blocks: readonly ({ kind: string; text: string; toolName?: string; toolCallId?: string; args?: Record<string, unknown> } | undefined)[]): RenderBlock[] {
  return blocks.map((b) => {
    if (!b) return { kind: 'text', text: '', streaming: true } as RenderBlock;
    if (b.kind === 'thinking') return { kind: 'thinking', text: b.text, streaming: true };
    if (b.kind === 'tool') {
      return {
        kind: 'toolCall',
        callId: b.toolCallId ?? '',
        name: b.toolName ?? 'tool',
        args: b.args,
      };
    }
    return { kind: 'text', text: b.text, streaming: true };
  });
}

export function MessageView({
  view,
  call,
  baseline,
  baselines,
  tabId,
  changeStats,
  detail = 'standard',
  memory,
}: {
  view: MessageViewRow;
  /** 该行的工具调用参数（`toolCalls[toolCallId]`，见 stores/messages.ts） */
  call?: { name: string; args?: Record<string, unknown> } | undefined;
  /** todo_write 行的**上一份**清单（差异对比；见 lib/todoModel 的 `todoBaselines`） */
  baseline?: TodoItem[] | undefined;
  /** 助手消息里每个 `toolCall` 块的差异基线（按调用 id 查；见 `todoBaselines`） */
  baselines?: Map<string, TodoItem[]> | null | undefined;
  /** 会话 id：助手消息里的工具行要按它取结果索引（`toolResults`） */
  tabId?: string | undefined;
  /**
   * 本轮各次文件改动的加删行数（`callId → {added, removed}`）。
   *
   * 由 `Transcript` 按 `commitSeq` 现算（改动卡片要显示 `+N −M`），
   * 不在这里订阅整个 `toolResults` —— 那会让每个助手行在**每帧**重渲染。
   */
  changeStats?: Record<string, { added: number; removed: number }> | null | undefined;
  /**
   * 工作步骤展示档位（docs/04 §2.1.6）。只有 `compact` 会改这一行的呈现：
   * **落定的思考行不显示摘要**（DSH 的 `Settled reasoning preview: Hidden`）。
   * 工具行的摘要不隐藏 —— 它是识别"这行干了什么"的唯一线索，藏了行就废了。
   */
  detail?: TranscriptDetail | undefined;
  /**
   * 这一行的身份（tab + 行 id）：行内展开态靠它跨"虚拟化卸载"活下来
   * （见 `lib/rowMemory`；没有它 —— 轨迹视图那种孤立渲染 —— 退化为组件内 state）。
   */
  memory?: RowMemory | undefined;
}) {
  const todoOn = useTodoSupported();
  const m = view.message as AgentMessage & { content?: unknown };
  const role = view.role;
  /* 会话内提示行（正在重试 / 正在压缩）：不是会话内容，是**进程状态**的一行。
     它进 `ids` 是为了位置正确（重试之后新起的那条流式行必须排在它后面），
     见 `stores/messages.ts` 的 `pushNotice`。 */
  if (role === 'notice' && view.notice) {
    return <NoticeRow notice={view.notice} />;
  }
  if (role === 'user') {
    return (
      <div className="pg-user-row">
        <div className="pg-user-stack">
          <div className="pg-bubble">{textOf(m.content)}</div>
        </div>
      </div>
    );
  }
  if (role === 'assistant') {
    const blocks = view.live ? liveBlocks(view.live) : settledBlocks(m.content);
    const full = blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
    const committed = (Array.isArray(m.content) ? m.content : []) as ContentBlock[];
    /* 本轮改动的文件：路径来自调用参数，加删行数来自工具结果（`changeStats`，
       由结果索引里 `details.patch` 数出来）。拿不到行数的文件只显示路径 —— 不臆造数字。 */
    const changed: ChangedFile[] = view.live
      ? []
      : editedCallsOf(committed).map((c) => ({
          path: c.path,
          callId: c.callId,
          added: changeStats?.[c.callId]?.added ?? null,
          removed: changeStats?.[c.callId]?.removed ?? null,
        }));
    const failure = view.live ? null : turnFailure(m);
    return (
      <div className="pg-message pg-assistant" data-streaming={view.live ? '' : undefined}>
        <div className="pg-assistant-body">
          {blocks.map((b, i) => (
            <Block
              key={i}
              index={i}
              block={b}
              tabId={tabId}
              baselines={baselines}
              detail={detail}
              memory={memory}
            />
          ))}
        </div>
        {/* 失败/中断回合：pi 用普通 assistant 消息表达（content 为空 + stopReason/errorMessage）。
            没有这块卡片时，整条消息渲染出来是**一片空白**——用户看到的是"发出去没反应"。 */}
        {failure ? <TurnFailureCard failure={failure} /> : null}
        {/* DSH 回合尾：改动文件卡片（docs/12 §3.5）。
            ⚠️ 点击行为与 DSH 不同：DSH 是把文件送进**右侧预览面板**（它的右栏就是文档预览），
            Piggy 没有那个面板，改成**开一个新标签页**（`openPreviewTab`）——
            与右栏文件树点文件是同一条路。工具参数里的路径可能是相对的，按会话 cwd 解析。 */}
        <ChangedFiles
          files={changed}
          onOpen={(file) => {
            const cwd = tabId ? useTabs.getState().tabs[tabId]?.cwd : undefined;
            const full = resolveAgainst(cwd, file.path);
            const name = baseName(full) || full;
            /* 有实际 diff 的（`edit`…）开 **diff 标签**：用户要看的正是"改成了什么样"。
               没有 diff 的（`write` 覆盖写、拿不到结果）退回文件预览 —— 至少能看到现在的内容。 */
            if (tabId && file.callId && file.added != null) {
              openDiffTab(tabId, file.callId, name);
              return;
            }
            openPreviewTab(full, full, name, cwd ?? undefined);
          }}
        />
        {/* 操作行（复制/时间）只在落定之后出现：流式时内容还不是最终文本，
            而且这一行自带 16px 上边距 —— 流式中挂着会让那一行在转正时矮一截。 */}
        {!view.live && full.trim() ? <MessageActions text={full} message={m} /> : null}
      </div>
    );
  }
  if (role === 'toolResult') {
    const rm = m as { toolName?: string; toolCallId?: string; content?: ContentBlock[]; isError?: boolean };
    const text = textOf(rm.content);
    /* 工具结果 = **一行窄行**（`运行命令 · pnpm test`），展开才是那块代码卡片。
       用户 2026-09-23："多工具消息时主工作区空间利用率非常低，能不能跟 dsh 一样做窄折叠"——
       实测：6 行 read 结果此前占 258px、3 行 bash 占 201px，而 DSH 的一行是 24px（docs/12 §3.3、
       DSH `ToolRow`/`DisclosureRow`）。摘要取自调用参数（store 的 `toolCalls` 索引）。 */
    /* 任务清单（`todo_write`）不是普通工具调用：它是一份**计划**，
       所以渲染成清单行（DSH `TodoRow`）而不是"标题 + 摘要 + 代码块"。
       前提是探测到 todo 插件且已启用 —— 没装插件时与从前一模一样（走通用工具行）。 */
    if (todoOn && rm.toolName === 'todo_write') {
      return (
        <TodoRow
          args={call?.args}
          toolCallId={rm.toolCallId}
          text={text}
          isError={rm.isError === true}
          baseline={baseline}
          memory={memory}
        />
      );
    }
    return (
      <ToolRow
        toolName={rm.toolName}
        toolCallId={rm.toolCallId}
        args={call?.args}
        isError={rm.isError === true}
        text={text}
        memory={memory}
      />
    );
  }
  if (role === 'bashExecution') {
    const bm = m as { command?: string; output?: string; exitCode?: number };
    return (
      <div className="pg-message pg-bash">
        <div className="pg-role">bash → exit {bm.exitCode ?? '?'}</div>
        <div className="pg-cmd">$ {bm.command}</div>
        {bm.output ? (
          <CodeBlock code={bm.output} lang={inferToolLang('bash', bm.output).lang} title="bash" collapsible />
        ) : null}
      </div>
    );
  }
  // 压缩行（文件里的 `compaction` 条目，docs/03 §2.19）：DSH 的对话里也有这一行
  // （`CompactionItem` / 「上下文已压缩」）。摘要折起来——
  // 它可能很长，但"这儿发生过压缩、当时多少 token"必须一眼看得见。
  //
  // 用户 2026-09-23："上下文压缩的轨迹无法看到细节"——核实后 Rust 侧只转出了
  // summary / tokensBefore / timestamp 三个字段，pi 的 `CompactionEntry` 里的
  // `firstKeptEntryId`（保留边界）/ `details`（读改过哪些文件）/ `usage`（摘要调用用量）
  // / `fromHook` 全被丢掉了。现在都显示出来（Rust 侧同步转出，见 `sessions/transcript.rs`）。
  if (role === 'compaction') {
    const cm = m as {
      summary?: string;
      tokensBefore?: number | null;
      firstKeptEntryId?: string | null;
      fromHook?: boolean | null;
      usage?: { totalTokens?: number | null; cost?: { total?: number | null } | null } | null;
      details?: { readFiles?: string[] | null; modifiedFiles?: string[] | null } | null;
    };
    const readFiles = cm.details?.readFiles ?? [];
    const modifiedFiles = cm.details?.modifiedFiles ?? [];
    const usageTokens = cm.usage?.totalTokens ?? null;
    const cost = cm.usage?.cost?.total ?? null;
    return (
      <div className="pg-message pg-compaction" data-compaction-row>
        <div className="pg-role">
          <Icon name="archive" size={12} /> 上下文已压缩
          {cm.tokensBefore != null ? (
            <span className="pg-compaction-tokens">
              （此前 {formatExactTokens(cm.tokensBefore)} tok）
            </span>
          ) : null}
        </div>
        {/* 这一行是"这次压缩做了什么"的账本：边界 / 文件 / 摘要调用用量。
            全都来自条目本身，没有一项是推算出来的。 */}
        {cm.firstKeptEntryId ? (
          <div className="pg-compaction-meta" data-compaction-kept>
            保留自 <code>{cm.firstKeptEntryId}</code> 起，之前的条目已被摘要取代
          </div>
        ) : null}
        {readFiles.length || modifiedFiles.length ? (
          <div className="pg-compaction-meta" data-compaction-files>
            涉及文件：读 {readFiles.length} / 改 {modifiedFiles.length}
            {modifiedFiles.length ? <span title={modifiedFiles.join('\n')}> · {modifiedFiles.slice(0, 3).join('、')}{modifiedFiles.length > 3 ? ' …' : ''}</span> : null}
          </div>
        ) : null}
        {usageTokens != null || cm.fromHook ? (
          <div className="pg-compaction-meta" data-compaction-usage>
            {usageTokens != null ? `摘要调用 ${formatExactTokens(usageTokens)} tok` : ''}
            {cost != null && cost > 0 ? ` · $${cost.toFixed(4)}` : ''}
            {cm.fromHook ? `${usageTokens != null ? ' · ' : ''}摘要来自扩展` : ''}
          </div>
        ) : null}
        {cm.summary ? (
          <details className="pg-compaction-summary">
            <summary>压缩摘要</summary>
            <div className="pg-thinking-body">
              <Markdown text={cm.summary} compact />
            </div>
          </details>
        ) : null}
      </div>
    );
  }
  return null;
}

/**
 * 思考摘要（DSH `ReasoningRow` 的两条口径，逐条照抄）：
 *
 * · **落定**：取**首行**（整段思考已经写完，第一行就是它的论点）；
 * · **流式**：取**最后一个已完成段落的首行** —— 边想边写时第一行早就滚过去了，
 *   读者要看的是"现在想到哪"（DSH `latestCompletedParagraphFirstLine`）；
 * · 两者都去掉 `**` 标记（摘要不是 markdown 渲染面，星号只会显脏）。
 */
function thinkingSummary(text: string, streaming: boolean): string {
  const line = streaming ? latestCompletedParagraphFirstLine(text) : firstLine(text);
  return line.replaceAll('**', '');
}

/** 最后一个**已完成**段落的首行（DSH 同名函数；末尾那个还没写完的段落不算）。 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = '';
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const next = separator.exec(text);
    const paragraphEnd = next === null ? text.length : next.index + next[0].indexOf('\n');
    const newline = text.indexOf('\n', paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== '') summary = candidate;
    }
    if (next === null) return summary;
    paragraphStart = next.index + next[0].length;
  }
}

/**
 * 思考行的窄行包装：受控展开 + 摘要（DSH `message.think` / `ReasoningRow`）。
 *
 * `streaming` 时正文按**纯文本**画、且**不挂载**（折叠态 = 不渲染，DSH 同款）：
 * 思考正文动辄几千字，折叠时把它渲染出来只是白烧 CPU。
 */
export function ThinkingRow({
  text,
  streaming = false,
  memory,
  slot,
  hideSummary = false,
}: {
  text: string;
  streaming?: boolean;
  memory?: RowMemory | undefined;
  slot: string;
  /**
   * 不显示摘要（`compact` 档 + 已落定）。
   *
   * DSH 的 `Settled reasoning preview: Hidden`：简洁档下思考行只留「思考」两个字，
   * 想看内容自己展开。**流式中的摘要不隐藏** —— 那正是"现在想到哪"的唯一线索。
   */
  hideSummary?: boolean;
}) {
  /* 展开态**记忆在行外**：这条行滚出虚拟窗口就被卸载，`useState` 会跟着丢
     —— 用户报的"展开看完、滚上去再滚回底部就看不清过程"就是它（见 lib/rowMemory）。 */
  const [open, setOpen] = useRowFlag(slotKey(memory, slot), 'open');
  const summary = hideSummary && !streaming ? '' : thinkingSummary(text, streaming);
  return (
    <div
      className="pg-thinkrow"
      data-thinking-row
      data-state={streaming ? 'running' : 'ok'}
      data-open={open || undefined}
    >
      <DisclosureRow
        icon={<Icon name="lightbulb" size={14} />}
        title="思考"
        running={streaming}
        open={open}
        expandable={text !== ''}
        onToggle={() => setOpen((v) => !v)}
        rowClassName="pg-thinkrow-head"
        bodyProps={{ 'data-thinking-body': '1' }}
        collapsedContent={
          summary ? (
            <>
              <span className="pg-trow-sep" aria-hidden="true" />
              <span className="pg-trow-summary" title={summary}>
                <TextShimmer>{summary}</TextShimmer>
              </span>
            </>
          ) : null
        }
      >
        <div className="pg-thinking-body">
          {streaming ? (
            text
          ) : (
            <Markdown text={text} compact memoryKey={slotKey(memory, `${slot}:md`)} />
          )}
        </div>
      </DisclosureRow>
    </div>
  );
}

/**
 * 失败/中断回卡片。
 *
 * 「中断」用中性色、不加 `role="alert"`——那是用户自己按的，不该报警；
 * 「失败」用 `--pg-error` 且 `role="alert"`，读屏会播报。
 * 原始错误文本逐字展示（provider 原话往往直接指出问题），提示只作为"可能原因"另起一行。
 */
function TurnFailureCard({ failure }: { failure: TurnFailure }) {
  const aborted = failure.kind === 'aborted';
  return (
    <div
      className={`pg-turn-failure${aborted ? ' pg-turn-aborted' : ''}`}
      data-kind={failure.kind}
      {...(aborted ? {} : { role: 'alert' })}
    >
      <div className="pg-turn-failure-head">
        <Icon name={aborted ? 'circle-slash' : 'error'} size={13} />
        <span className="pg-turn-failure-title">{failure.title}</span>
      </div>
      {failure.detail ? <pre className="pg-turn-failure-detail">{failure.detail}</pre> : null}
      {failure.hint ? <p className="pg-turn-failure-hint">{failure.hint}</p> : null}
    </div>
  );
}

/** DSH 助手操作行（docs/12 §3.7）：28×28 按钮，默认隐藏、hover 显现（opacity 80ms）。 */
function MessageActions({ text, message }: { text: string; message: AgentMessage }) {
  const [copied, setCopied] = useState(false);
  const ts = (message as { timestamp?: number }).timestamp;

  return (
    <div className="pg-actions">
      <button
        className="pg-action-btn"
        title={copied ? '已复制' : '复制全文'}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {ts ? (
        <time className="pg-action-time" dateTime={new Date(ts).toISOString()}>
          {new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </time>
      ) : null}
    </div>
  );
}

function Block({
  block,
  index,
  tabId,
  baselines,
  detail,
  memory,
}: {
  block: RenderBlock;
  /** 块下标（= pi 的 `contentIndex`）：React key 与记忆插槽都用它 */
  index: number;
  tabId?: string | undefined;
  baselines?: Map<string, TodoItem[]> | null | undefined;
  /** 工作步骤展示档位（只有 `compact` 会改块的呈现：落定的思考摘要隐藏） */
  detail?: TranscriptDetail | undefined;
  memory?: RowMemory | undefined;
}) {
  /* 同一行里可能有多个工具行/思考行：行记忆的插槽必须带块下标，否则它们会共用
     `slotKey(memory, 'tool')` 这一个键（实测：展开一个，另一个跟着展开）。 */
  const blockMemory = memory ? { tabId: memory.tabId, rowKey: `${memory.rowKey}\u0001${index}` } : undefined;
  switch (block.kind) {
    case 'text':
      /* 正文走 **Markdown**（04 §5）。
         用户 2026-09-23 的截图：`## 🔴 严重缺陷`、`**默认配置受影响**`、`---` 全是原样文本。
         核实：这一支此前只做 `splitFences()`（围栏 → 代码卡片），其余当纯文本 ——
         docs/04 §5 早就写着"Markdown 只在转正时解析一次"，但那个 parser 一直没落地。

         流式这一支（2026-09-24 起）也渲染 markdown，只是换**增量解析**：
         冻结前缀 + 只重解析尾部（`StreamingMarkdown`）—— 既不会每帧全量 parse，
         也不会把已经画好的块重挂。转正那一刻换成整段 parse 的那一份（引用式链接/脚注
         靠它自愈），两边造型一致，所以视觉上只该看到"半截符号补齐"。 */
      return block.streaming ? (
        <StreamingMarkdown text={block.text} memoryKey={slotKey(memory, `text:${index}:md`)} />
      ) : (
        <Markdown text={block.text} memoryKey={slotKey(memory, `text:${index}:md`)} />
      );
    case 'thinking':
      // 思考行也是**窄行**（DSH `DisclosureRow` + `message.think`）：标题「思考」+ 首行摘要，
      // 展开看全文。旧版是 `<details><summary>思考</summary>`——几何与工具行不齐，
      // 而且摘要不显示"想了什么"，一行 24px 的信息量被浪费掉了。
      return (
        <ThinkingRow
          text={block.text}
          streaming={block.streaming}
          memory={memory}
          slot={`think:${index}`}
          hideSummary={detail === 'compact'}
        />
      );
    case 'toolCall':
      /* 工具调用是**一行**（DSH `ToolCallTree`）：从它出现（流式里 `toolcall_start`）
         到结果落地是同一行、同一个组件实例，结果通过 `toolResults` 索引并进来
         （见 `ToolCallRow` 的文件头）。早先这里 `return null`，工具行要等结果消息才出现。 */
      if (!tabId) return null; // 孤立渲染（轨迹视图）：没有结果索引可取，交给 toolResult 行
      return (
        <ToolCallRow
          tabId={tabId}
          callId={block.callId}
          toolName={block.name}
          args={block.args}
          baseline={block.callId ? baselines?.get(block.callId) : undefined}
          memory={blockMemory}
        />
      );
    case 'image':
      return <ImageBlock block={block.block} />;
    default:
      // 未知块：透传展示原始 JSON（docs/02 §5.1）
      return (
        <details className="pg-unknown">
          <summary>未知块 {(block.block as { type?: string }).type}</summary>
          <pre className="pg-pre">{JSON.stringify(block.block, null, 2)}</pre>
        </details>
      );
  }
}

/** 图片渲染（04 §5.3、05 §6.4）：大 base64 载荷转 Blob URL（按对象记忆，不重复解码）；
 * 带本地 path 的块走 Tauri asset 协议直读文件。 */
const blobUrlCache = new WeakMap<object, string>();

function ImageBlock({ block }: { block: object }) {
  const b = block as { data?: string; mimeType?: string; path?: string };
  const url = useMemo(() => {
    if (b.path) return undefined; // path 分支在下方经 convertFileSrc 解析
    if (!b.data) return undefined;
    const cached = blobUrlCache.get(block);
    if (cached) return cached;
    try {
      const bin = atob(b.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: b.mimeType ?? 'image/png' }));
      blobUrlCache.set(block, url);
      return url;
    } catch {
      return undefined;
    }
  }, [block, b.data, b.mimeType, b.path]);
  const assetUrl = useMemo(() => {
    if (!b.path) return undefined;
    // Tauri asset 协议（05 §6.4 反 data URI）：本地文件直读，scope 限 $HOME/$TMP
    return convertFileSrc(b.path);
  }, [b.path]);
  const src = url ?? assetUrl;
  if (!src) return null;
  return (
    <img
      className="pg-image"
      src={src}
      alt=""
      loading="lazy"
      onClick={() => window.open(src, '_blank')}
    />
  );
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

