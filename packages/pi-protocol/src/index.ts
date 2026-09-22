/**
 * @piggy/pi-protocol — pi RPC mode 协议类型（TS 侧镜像）
 *
 * 事实来源：pi 0.86.1 docs/rpc.md + 实机事件抓取（见 fixtures/）。
 * 约定（docs/02 §5.1）：一切 schema 以 passthrough 校验，未知字段透传，
 * 保证 pi 协议向前演进时 Piggy 不崩、不丢数据。
 */
import { z } from 'zod';

/* ---------------- 基础块 ---------------- */

export const textContentSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
export const imageContentSchema = z
  .object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })
  .passthrough();

export const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('toolCall'),
      id: z.string(),
      name: z.string(),
      arguments: z.unknown(),
    })
    .passthrough(),
  z.object({ type: z.literal('image') }).passthrough(),
  // 未知块：透传
  z.object({ type: z.string() }).passthrough(),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/* ---------------- AgentMessage（role 判别） ---------------- */

export const agentMessageSchema = z.union([
  z
    .object({
      role: z.literal('user'),
      content: z.union([z.string(), z.array(contentBlockSchema)]),
      timestamp: z.number().optional(),
      attachments: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(contentBlockSchema),
      provider: z.string().optional(),
      model: z.string().optional(),
      stopReason: z.string().optional(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal('toolResult'),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(contentBlockSchema),
      isError: z.boolean().optional(),
      timestamp: z.number().optional(),
    })
    .passthrough(),
  z.object({ role: z.literal('bashExecution') }).passthrough(),
  z.object({ role: z.literal('system') }).passthrough(),
  z.object({ role: z.string() }).passthrough(),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/* ---------------- AssistantMessageEvent（流式 delta） ---------------- */

export const assistantMessageEventSchema = z.union([
  z.object({ type: z.literal('text_start'), contentIndex: z.number() }).passthrough(),
  z.object({ type: z.literal('text_delta'), contentIndex: z.number(), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('text_end'), contentIndex: z.number() }).passthrough(),
  z.object({ type: z.literal('thinking_start'), contentIndex: z.number() }).passthrough(),
  z.object({ type: z.literal('thinking_delta'), contentIndex: z.number(), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking_end'), contentIndex: z.number() }).passthrough(),
  z
    .object({
      type: z.literal('toolcall_start'),
      contentIndex: z.number(),
      id: z.string(),
      toolName: z.string(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('toolcall_delta'), contentIndex: z.number(), delta: z.string() })
    .passthrough(),
  z.object({ type: z.literal('toolcall_end'), contentIndex: z.number() }).passthrough(),
  z.object({ type: z.string() }).passthrough(),
]);
export type AssistantMessageEvent = z.infer<typeof assistantMessageEventSchema>;

export const usageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    totalTokens: z.number().optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        total: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Usage = z.infer<typeof usageSchema>;

/* ---------------- 事件（pi → 客户端，stdout） ---------------- */

const eventCommon = { type: z.string() };

export const piEventSchema = z.union([
  z.object({ ...eventCommon, type: z.literal('agent_start') }),
  z
    .object({
      type: z.literal('agent_end'),
      messages: z.array(z.unknown()).optional(),
      willRetry: z.boolean().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('agent_settled') }),
  z.object({ type: z.literal('turn_start') }),
  z
    .object({
      type: z.literal('turn_end'),
      message: z.unknown(),
      toolResults: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('message_start'), message: z.unknown() }).passthrough(),
  z
    .object({
      type: z.literal('message_update'),
      usage: usageSchema.optional(),
      assistantMessageEvent: assistantMessageEventSchema,
    })
    .passthrough(),
  z.object({ type: z.literal('message_end'), message: z.unknown() }).passthrough(),
  z
    .object({
      type: z.literal('bash_execution_update'),
      id: z.string().nullable().optional(),
      delta: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_execution_start'),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_execution_update'),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown().optional(),
      partialResult: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_execution_end'),
      toolCallId: z.string(),
      toolName: z.string(),
      result: z.unknown(),
      isError: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('queue_update'),
      steering: z.array(z.string()),
      followUp: z.array(z.string()),
    })
    .passthrough(),
  z.object({ type: z.literal('compaction_start'), reason: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('compaction_end'),
      reason: z.string(),
      result: z.unknown().nullable().optional(),
      aborted: z.boolean().optional(),
      willRetry: z.boolean().optional(),
      errorMessage: z.string().nullable().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('auto_retry_start') }).passthrough(),
  z.object({ type: z.literal('auto_retry_end') }).passthrough(),
  z.object({ type: z.literal('summarization_retry_scheduled') }).passthrough(),
  z.object({ type: z.literal('summarization_retry_attempt_start') }).passthrough(),
  z.object({ type: z.literal('summarization_retry_finished') }),
  z
    .object({
      type: z.literal('extension_error'),
      extensionPath: z.string().optional(),
      event: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.string(),
    })
    .passthrough(),
  // 未知事件类型：整体透传（docs/02 §5.1）
  z.object({ type: z.string() }).passthrough(),
]);
export type PiEvent = z.infer<typeof piEventSchema>;

/* ---------------- 响应（命令回执） ---------------- */

export const rpcResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    type: z.literal('response'),
    command: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

/* ---------------- 会话条目（get_entries） ---------------- */

export const sessionEntrySchema = z
  .object({
    type: z.string(),
    id: z.string(),
    parentId: z.string().nullable().optional(),
    timestamp: z.unknown().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

export const getEntriesDataSchema = z
  .object({
    entries: z.array(sessionEntrySchema),
    leafId: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------------- 合帧器输出（Rust → 前端 pi:frame:*） ---------------- */

export const frameItemSchema = z
  .object({
    contentIndex: z.number(),
    delta: z.string().optional(),
    id: z.string().optional(),
    toolName: z.string().optional(),
  })
  .passthrough();
export type FrameItem = z.infer<typeof frameItemSchema>;

export const frameSchema = z
  .object({
    text: z.array(frameItemSchema).optional(),
    thinking: z.array(frameItemSchema).optional(),
    toolArgs: z.array(frameItemSchema).optional(),
    signals: z.array(assistantMessageEventSchema).optional(),
    usage: usageSchema.optional(),
  })
  .passthrough();
export type Frame = z.infer<typeof frameSchema>;
