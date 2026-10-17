/**
 * 运行中指示（DSH `ui-chat/src/client/chat/RunningStatus.tsx` + `ChatView.module.css`
 * 的 `.running` / `.runningDivider` / `.runningContent` / `.runningText` / `.runningIcon`）。
 *
 * ```
 * ─────────────────────────────────  ← 0.5px 分隔线（最后一行是输出时才画）
 *   🐋  运行中，用时 12秒 ···         ← 12px / deep-diving 蓝 / 文字扫光
 * ```
 *
 * ## 它解决什么
 *
 * 一轮跑起来之后、以及**工具在跑而模型没出字**的时候，转录里如果什么都不动，用户
 * 看不出"它还在干活"还是"卡住了"。DSH 的做法是在**内容流的最末尾**挂一行运行指示：
 * 一个鲸尾图标 + 一句带**实时用时**的扫光文字。之所以放在内容末尾而不是输入框旁边：
 * 它描述的是"这一轮的进展"，位置就该跟着这一轮的内容走。
 *
 * ## 时钟口径（与 DSH 逐条一致）
 *
 * · 起点 = 这一轮的开始时刻（Piggy 取 `agent_start` 到达时的本机时间，
 *   DSH 取宿主事件里的 `turn.start.time`；见 `stores/messages.ts` 的 `turnStartedAt`）；
 * · 每秒一跳（DSH `LIVE_RUN_CLOCK_INTERVAL_MS = 1000`），**只更新这一行**：
 *   时钟住在自己组件里，转录其余部分不跟着重渲染（DSH 文件头那句话）。
 * · 不足 1 秒按 1 秒显示（`Math.max(1000, …)`）—— 否则刚发出的一瞬间会闪 "0 秒"。
 * · 没有起点时退化成 `运行中`（不留一个编出来的数字）。
 *
 * ## 文案
 *
 * 用「运行中」，**不用** DSH 的「深度求索中」（那是 DeepSeek 的品牌说法；
 * 2026-10-16 用户明确要求）。用时格式仍是 DSH 的算法：`1秒` / `1分5秒` / `1小时2分5秒`。
 *
 * ## 与 DSH 的差别（如实记着）
 *
 * · 图标是**动图优先**：DSH 那张 `running-whale@2x.png`（APNG）当 alpha mask 播尾鳍
 *   摆动，不支持 mask / 用户要求减少动效时退回静态 SVG（同一段 `REST_PATH`，DSH 的
 *   降级路线一样）。资源放在 `src/assets/`（21 KB，MIT 上游，已登记 THIRD_PARTY_NOTICES）。
 * · 分隔线在 DSH 是一条关系选择器（"最后一行是输入就不画"）。这里的输入是转录
 *   **消息**，所以判据由 `Transcript` 传进来（最后一行是用户气泡或者是空助手行 → 不画）。
 */
import { memo, useEffect, useState } from 'react';
import { TextShimmer } from '@/features/common/TextShimmer';

/** 秒针间隔（DSH `LIVE_RUN_CLOCK_INTERVAL_MS`）。 */
const CLOCK_INTERVAL_MS = 1000;

/** 这一行说的是什么（用户定的口径：「运行中」，不用 DSH 的品牌说法「深度求索中」）。 */
const RUNNING_LABEL = '运行中';

/**
 * 鲸尾（DSH `RunningWhaleTail.tsx` 的 `REST_PATH`，原样照抄；viewBox 0 0 16 16）。
 *
 * 只在**动图不可用**时出现（mask 不受支持 / `prefers-reduced-motion: reduce` /
 * forced-colors）。动图那份的几何在 `styles.css` 的 `.pg-running-whale`。
 */
const WHALE_TAIL_PATH =
  'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742';

/**
 * 用时文本（DSH `message-chrome.ts` 的 `formatRunDuration`，单位取自中文词条）。
 *
 * 与折叠行的 `formatDuration`（`12s` / `1m 05s`）**故意用两套**：那一行是
 * "已完成工作"的右侧标签，走等宽数字的紧凑写法；这一行是句子里的"用时 N 秒"，
 * 单位必须跟着语言走（DSH 的 `duration.*Unit` 词条），而且秒数不补前导零。
 *
 * @param ms - 毫秒（负数按 0、小数向下取整）
 * @returns `5秒` / `1分5秒` / `1小时2分5秒`（拼进句子时不再加空格，与 DSH 一致）
 */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const out: string[] = [];
  if (hours > 0) out.push(`${hours}小时`);
  // 满一分钟才出现"分"（DSH：`total >= 60`），否则只报秒
  if (total >= 60) out.push(`${minutes}分`);
  out.push(`${seconds}秒`);
  return out.join('');
}

/**
 * 运行指示行。
 *
 * @param startedAt - 这一轮开始的时刻（ms）；`null`/`undefined` = 不知道起点，只显示「运行中」
 * @param divider - 是否画上面那条 0.5px 分隔线（判据在 `Transcript`：最后一行**有输出**才画）
 */
export const RunningStatus = memo(function RunningStatus({
  startedAt,
  divider = false,
}: {
  startedAt?: number | null | undefined;
  divider?: boolean | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    /* 每秒一跳。⚠️ 本仓禁 `setInterval`（eslint 红线：轮询会让"看起来在跑"变成
       "真的在跑"），所以用递归 `setTimeout` —— 它同样能被 cleanup 精确停掉，
       而且组件卸载后不会留下来继续改状态。 */
    let timer = window.setTimeout(function tick() {
      setNow(Date.now());
      timer = window.setTimeout(tick, CLOCK_INTERVAL_MS);
    }, CLOCK_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [startedAt]);

  // 不足 1 秒按 1 秒算：刚发出的一瞬间不该闪 "0 秒"（DSH 同一口径）
  const duration = startedAt == null ? null : formatRunDuration(Math.max(1000, now - startedAt));
  /* 文案**不用** DSH 的「深度求索中」（2026-10-16 用户："不要写'深度求索中'，写'运行中'"）：
     那句是 DeepSeek 的品牌说法，在 Piggy 里它只描述"这一轮还在跑"，直说更准。 */
  const label = duration == null ? RUNNING_LABEL : `${RUNNING_LABEL}，用时 ${duration} ···`;

  return (
    <div className="pg-running" data-chat-running>
      {/* 读屏播报的是**状态**，不是每秒都在变的数字：`aria-live` 挂在隐藏的那句上，
          数字那部分不进无障碍树（否则读屏会每秒念一遍）。DSH 同款。 */}
      <span className="pg-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {RUNNING_LABEL}
      </span>
      {divider ? <span className="pg-running-divider" aria-hidden="true" /> : null}
      <span className="pg-running-content">
        <span className="pg-running-icon" aria-hidden="true">
          {/* 动图（APNG 当 mask，颜色跟着 currentColor 走）；不支持时下面那份静态 SVG 顶上 */}
          <span className="pg-running-whale" />
          <svg className="pg-running-still" viewBox="0 0 16 16" width="100%" height="100%" fill="none">
            <path d={WHALE_TAIL_PATH} stroke="currentColor" strokeWidth={1} />
          </svg>
        </span>
        <TextShimmer active className="pg-running-text">
          {label}
        </TextShimmer>
      </span>
    </div>
  );
});
