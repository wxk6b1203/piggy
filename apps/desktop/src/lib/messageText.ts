/**
 * 一条消息的纯文本（全应用唯一实现，2026-10-17 合并）。
 *
 * 合并前有 **7 份**几乎逐字相同的实现：`stores/messages.ts::contentText`（"官方"那份，
 * 但只被 `register()` 用了一次）、`MessageView.textOf`、`SessionHead.flatten`、
 * `slashCommands.lastAssistantText` 的内联版、`tabEvents.userMessageText`、
 * `turnRailItems.messageText`、`mockBackend` 的 outline 预览。它们的**拼接符还不一样**
 * （多数 `''`，预览那两处 `'\n'`）—— 只是恰好被 `condense()` 的 `\s+ → ' '` 抹平，
 * 所以"分叉"看不见；一旦有一处改了口径（比如开始跳过非 text 块），别处不会跟着变。
 *
 * 口径（与 `MessageView` 的渲染一致）：**只取 `type === 'text'` 的块**，
 * 字符串内容直接返回，其它形状一律空串（不猜、不 JSON.stringify）。
 * 图片/工具调用/思考块都**不算**"文本"—— 这一行只描述"用户读到的那段话"。
 */

/**
 * 取 `message.content` 里的纯文本。
 *
 * @param content - `message.content`：裸字符串或块数组（两种形状 pi 都发过）
 * @param separator - 多个 text 块之间的拼接符。默认 `''`（助手正文/标题的原样文本）；
 *   需要"一段一行"的地方（刻度梯预览、会话轮廓）传 `'\n'`
 * @returns 纯文本；没有 text 块时为空串
 */
export function textOfContent(content: unknown, separator = ''): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown } | null;
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join(separator);
}
