/**
 * 助手消息里**一个 `toolCall` 块**渲染出来的那一行（DSH `ToolCallTree` 的窄行等价物）。
 *
 * ## 为什么工具调用不再等"结果行"
 *
 * 早先工具行是由 `toolResult` **消息**渲染的（`MessageView` 的 `toolResult` 分支），
 * 而助手消息里的 `toolCall` 块 `return null`。那样一来工具行要等到**执行结束**才出现：
 * 用户看到的是"思考完了 → 空一段（工具在跑）→ 结果行冒出来"。
 *
 * 现在的生命周期与 DSH 的工具行一致（`ui-tool/.../tool.ts` 的 `match`）：
 *
 * ```
 * 助手消息里的 toolCall 块（流式中就在）→ ToolRow（data-state=running，标题+参数摘要）
 *                  ↓ toolResult 到达（并进 toolResults 索引，不另起一行）
 *               同一行 → data-state=ok|error，正文就位（折叠着，展开才渲染代码卡片）
 * ```
 *
 * 行是同一个组件实例：`callId` 不变、React key（块下标）不变，只有 props 变。
 * 于是"工具从出现到落地"是一条线，而不是"长出来 → 消失 → 再打印一遍"。
 *
 * 结果**不在当前窗口**时（分页从半途开始）：`toolResult` 走不到这里，
 * 由 `MessageView` 的 `toolResult` 分支兜底单独成行 —— 那一行也带着 `toolCallId`，
 * 两边不会同时出现（`stores/messages.ts` 的 `register` 按 `toolCalls` 索引决定让谁渲染）。
 */
import { useTabMsg, useToolResult } from '@/stores/messages';
import { useTodoSupported } from '@/stores/todo';
import type { TodoItem } from '@/lib/todoModel';
import type { RowMemory } from '@/lib/rowMemory';
import { ToolRow } from './ToolRow';
import { TodoRow } from './TodoRow';

export interface ToolCallRowProps {
  /** 这一行的所属会话（结果索引按 tab 存） */
  tabId: string;
  /** 调用 id（`toolCall.id`）—— 结果与记忆键都按它对齐 */
  callId: string;
  toolName: string;
  /** 调用参数（流式中可能还没有：参数 JSON 没解析成功就是 `undefined`） */
  args?: Record<string, unknown> | undefined;
  /** `todo_write` 的差异基线（见 `lib/todoModel` 的 `todoBaselines`） */
  baseline?: TodoItem[] | undefined;
  /** 行身份（展开态记忆；插槽由调用方按块下标区分） */
  memory?: RowMemory | undefined;
}

export function ToolCallRow({ tabId, callId, toolName, args, baseline, memory }: ToolCallRowProps) {
  const result = useToolResult(tabId, callId);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const todoOn = useTodoSupported();
  const text = result?.text ?? '';
  const isError = result?.isError === true;
  /* "运行中"= 结果还没到、而且这一轮还在跑。
     不在跑又没结果（中断/崩溃）：老实当普通行显示（不假装还在跑）。 */
  const running = result === undefined && streaming;

  /* 任务清单（`todo_write`）不是普通工具调用：它是一份**计划**，渲染成清单行
     （DSH `TodoRow`）。能力没探测到就退回通用工具行 —— 与本仓其它地方同一口径。 */
  if (todoOn && toolName === 'todo_write') {
    return (
      <TodoRow
        args={args}
        toolCallId={callId}
        text={text}
        isError={isError}
        baseline={baseline}
        memory={memory}
      />
    );
  }
  return (
    <ToolRow
      toolName={toolName}
      toolCallId={callId}
      args={args}
      isError={isError}
      text={text}
      running={running}
      memory={memory}
    />
  );
}
