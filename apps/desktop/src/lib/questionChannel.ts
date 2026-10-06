/**
 * 提问卡通道（docs/06 §7）：把 pi 插件的 `ui.select` 变成转录里的一张卡。
 *
 * ## 信封
 *
 * 插件（`resources/pi-plugins/pi-ask`）问用户时发的是一次**普通的** `ui.select`，
 * 只是标题里带信封：
 *
 * ```
 * method: 'select'
 * title:  'piggy:ask:v1:<toolCallId>'      ← 见 pi-ask/lib.js 的 ASK_TITLE_PREFIX
 * options: ['提交']                          ← 真正的选项在**工具调用的参数**里
 * ```
 *
 * 这样做的理由写在插件头部：pi 在 RPC 模式下只允许 `select/confirm/input/...` 这几种
 * UI 方法（`custom()` 直接返回 undefined），"一张卡问多个问题"只能靠宿主认信封。
 * 好处是协议**没有扩展**：别的宿主换条降级路径（逐个问题弹原生框），pi 本身不用动。
 *
 * ## 分工
 *
 * 这里只有**纯函数与常量**（认信封、解析工具调用 id）：`lib/` 不放 React/zustand。
 * 待答请求的存放与生命周期在 `stores/questions.ts`，卡片在 `features/chat/QuestionCard.tsx`。
 */

/** 信封前缀。要与 `pi-ask/lib.js` 的 `ASK_TITLE_PREFIX` 一致（契约测试钉住）。 */
export const ASK_TITLE_PREFIX = 'piggy:ask:v1:';

/** 固定的提交选项（插件那个 select 只有这一项）。 */
export const ASK_SUBMIT_LABEL = '提交';

/**
 * 从标题里解析工具调用 id。
 *
 * @param title - 请求标题
 * @returns 工具调用 id；不是提问卡信封时返回 null
 */
export function parseAskTitle(title: unknown): string | null {
  if (typeof title !== 'string' || !title.startsWith(ASK_TITLE_PREFIX)) return null;
  const id = title.slice(ASK_TITLE_PREFIX.length).trim();
  return id === '' ? null : id;
}
