/**
 * 状态行（DSH `StatsPills.tsx`，docs/12 §3.9）——Composer dock 的内容。
 *
 * DSH 没有横贯底部的状态栏：窗口级状态行就是输入卡下方的这个 dock。
 * 详细模式分两枚 pill（与 DSH 逐字一致）：
 *   pill 1 = `{轮} 轮 {步} 步 · {tok/s}`
 *   pill 2 = `{总 tok} · 缓存命中 {%}`
 * 外加成本（Piggy 额外保留，pi 提供 cost 而 DSH 无此概念）。
 *
 * 指标口径（全部来自 `get_session_stats`，pi docs/rpc-commands.md#get_session_stats）：
 *   轮 = userMessages；步 = assistantMessages + toolCalls（docs/11 §3 的步语义）
 *   缓存命中 = cacheRead / (input + cacheRead)（口径在 lib/tokenFormat，3 位小数）
 *   tok/s = stats store 的实测增量速率，只在流式中显示
 */
import { useStats } from '@/stores/stats';
import type { SessionStats } from '@/stores/stats';
import { useTabMsg } from '@/stores/messages';
import { Icon } from '@/features/common/Icon';
import { formatCacheHitPercent, formatTokens } from '@/lib/tokenFormat';

export function SessionStatusLine({ tabId }: { tabId: string | null }) {
  const stats = useStats((s) => (tabId ? s.byTab[tabId] : undefined));
  const rate = useStats((s) => (tabId ? s.rate[tabId] : undefined));
  const streaming = useTabMsg(tabId, (t) => t.streaming);

  if (!tabId || !stats) return null;

  const turns = stats.userMessages ?? 0;
  const steps = (stats.assistantMessages ?? 0) + (stats.toolCalls ?? 0);
  const tokPerSec = streaming && rate && rate.tokPerSec > 0 ? Math.round(rate.tokPerSec) : null;
  const hit = cacheHitPercent(stats);
  const total = stats.tokens?.total ?? 0;

  return (
    <>
      <span
        className="pg-status-pill"
        title="轮 = 用户消息数；步 = 助手回复数 + 工具调用数"
      >
        <Icon name="dashboard" size={14} />
        {turns} 轮 {steps} 步
        {tokPerSec != null ? <span className="pg-status-rate"> · {tokPerSec} tok/s</span> : null}
      </span>
      <span
        className="pg-status-pill"
        title={`输入 ${formatTokens(stats.tokens?.input)} · 输出 ${formatTokens(stats.tokens?.output)} · 缓存读 ${formatTokens(stats.tokens?.cacheRead)}`}
      >
        <Icon name="database" size={14} />
        {formatTokens(total)} tok
        {hit != null ? ` · 缓存命中 ${hit}%` : ''}
      </span>
      {stats.cost != null ? (
        <span className="pg-status-pill" title="会话累计成本（pi 统计，含工具与压缩）">
          <Icon name="credit-card" size={14} />
          ${Number(stats.cost).toFixed(4)}
        </span>
      ) : null}
    </>
  );
}

/** 命中率 = 缓存读 /（输入 + 缓存读）；分母为 0 时无意义（口径见 lib/tokenFormat）。 */
function cacheHitPercent(s: SessionStats): string | null {
  const read = s.tokens?.cacheRead ?? 0;
  const input = s.tokens?.input ?? 0;
  return formatCacheHitPercent(read, input + read);
}
