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
 * · 图标是**猪头线稿**，不是 DSH 的鲸尾：DSH 那张动图是别人的品牌符号，Piggy 该用
 *   自己的（2026-10-16 用户："这个图能不能改成个猪头"）。它和界面别处的 🐷（侧栏品牌标、
 *   空编辑区、欢迎页）是同一个形象，只是这里画成线稿：emoji 上不了 `currentColor`，
 *   而这一行整句要用 deep-diving 蓝。没有动图 —— 14px 上的"活"由文字扫光负责
 *   （`TextShimmer`），图标保持静态、深浅两套主题共用一份几何。
 * · 分隔线在 DSH 是一条关系选择器（"最后一行是输入就不画"）。这里的输入是转录
 *   **消息**，所以判据由 `Transcript` 传进来（最后一行是用户气泡或者是空助手行 → 不画）。
 */
import { memo, useEffect, useState } from 'react';
import { TextShimmer } from '@/features/common/TextShimmer';

/** 秒针间隔（DSH `LIVE_RUN_CLOCK_INTERVAL_MS`）。 */
const CLOCK_INTERVAL_MS = 1000;

/** 这一行说的是什么（用户定的口径：「运行中」，不用 DSH 的品牌说法「深度求索中」）。 */
const RUNNING_LABEL = '运行中';

/** 猪头线稿的几何（16×16；描边 1px、颜色走 `currentColor`）。 */
const PIG_HEAD_PATHS = {
  /** 脸 */
  head: 'M8 3.2c2.2 0 3.8.7 4.7 1.9 1 1.3 1.3 3 1 4.7-.5 2.2-2.7 3.9-5.7 3.9s-5.2-1.7-5.7-3.9c-.3-1.7 0-3.4 1-4.7C3.2 3.9 4.8 3.2 8 3.2Z',
  /** 左耳（朝左上支起的三角） */
  earLeft: 'M3.5 4.7 2.4 1.9l3.1 1.3',
  /** 右耳 */
  earRight: 'M12.5 4.7l1.1-2.8-3.1 1.3',
} as const;

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
          <svg
            viewBox="0 0 16 16"
            width="100%"
            height="100%"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={PIG_HEAD_PATHS.head} />
            <path d={PIG_HEAD_PATHS.earLeft} />
            <path d={PIG_HEAD_PATHS.earRight} />
            {/* 鼻吻 + 两个鼻孔：整张脸靠它读成"猪"，不能省 */}
            <ellipse cx="8" cy="9.7" rx="2.4" ry="1.8" />
            <circle cx="7.15" cy="9.7" r=".42" fill="currentColor" stroke="none" />
            <circle cx="8.85" cy="9.7" r=".42" fill="currentColor" stroke="none" />
            {/* 眼睛 */}
            <circle cx="5.9" cy="7" r=".5" fill="currentColor" stroke="none" />
            <circle cx="10.1" cy="7" r=".5" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <TextShimmer active className="pg-running-text">
          {label}
        </TextShimmer>
      </span>
    </div>
  );
});
