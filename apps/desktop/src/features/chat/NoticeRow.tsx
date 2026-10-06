/**
 * 会话内提示行（用户 2026-09-25："本会话内的提示，比如重试中这种，不要展示全局，
 * 展示在会话内即可"）。
 *
 * 两类，各自照抄 DSH 里**对应的那个节点**：
 *
 * | 状态 | DSH | 这里的形状 |
 * |---|---|---|
 * | 正在重试模型请求 | `MessageItem.tsx` 的 `ModelRetryItem` | `<details>`：扫光的一行状态 + 展开看"重试延迟 / 失败原因" |
 * | 正在压缩上下文 | `GenericCommandCard`（`runningSummary='正在压缩…'`） | 与工具行同一套窄行（`DisclosureRow` + `running` 扫光） |
 *
 * 两行的**生命周期都由事件决定**（`auto_retry_start/end`、`compaction_start/end`）：
 * 行只表示"正在…"，结束就撤（`stores/messages.ts` 的 `pushNotice`/`dropNotice`），
 * 所以这里没有"已完成/已取消"分支 —— DSH 那些分支属于**会话里持久存在的节点**，
 * 而 pi 的这两个事件不是持久条目（压缩结束后会以 `compaction` 条目的身份回来，
 * 重试成功则由下一条助手消息表达）。
 *
 * 重试倒计时按 DSH 的口径算：**以浏览器第一次渲染这一行为零点**
 * （宿主事件时间与 `Date.now()` 可能不同源），250ms 一跳，走到 1s 就停表。
 */
import { useEffect, useMemo, useState } from 'react';
import type { NoticeView } from '@/stores/messages';
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { Icon } from '@/features/common/Icon';
import { firstLine } from './toolRowModel';
import { TextShimmer } from '@/features/common/TextShimmer';

/** DSH `retrySeconds`：向上取整，最小 1 秒（不能显示 0s）。 */
function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

export function NoticeRow({ notice }: { notice: NoticeView }) {
  if (notice.kind === 'retry') return <RetryNotice notice={notice} />;
  if (notice.kind === 'extension') return <ExtensionNotice notice={notice} />;
  return <CompactionNotice />;
}

/**
 * 「扩展报错」——**一次事故**，不是"正在进行"。
 *
 * 与上面两类刻意不同：它不扫光（扫光表达"还在动"）、不自动消失（`agent_settled` 不撤它），
 * 用错误色 + `<details>` 展开看全文。同一个扩展连报多次只累计 `count`，
 * 否则一次插件崩溃会刷出十几行一模一样的红字（把真正的内容顶出屏幕）。
 */
function ExtensionNotice({ notice }: { notice: NoticeView }) {
  const count = notice.count ?? 1;
  return (
    <details className="pg-notice-ext" data-notice-row data-notice="extension" data-notice-source={notice.source}>
      <summary className="pg-notice-ext-summary">
        <Icon name="alert" size={12} />
        <span className="pg-notice-ext-title">扩展报错</span>
        <span className="pg-notice-ext-source">{notice.source}</span>
        {count > 1 ? <span className="pg-notice-ext-count">×{count}</span> : null}
        <span className="pg-notice-ext-text">{firstLine(notice.text ?? '')}</span>
      </summary>
      <div className="pg-notice-ext-details" data-notice-details>
        {notice.text ?? ''}
      </div>
    </details>
  );
}

/** 「正在重试模型请求（1/3） · 5s」——DSH `ModelRetryItem`。 */
function RetryNotice({ notice }: { notice: NoticeView }) {
  /* 零点 = 这一行第一次渲染的时刻（DSH 同一条注释：宿主事件时间与本地时钟可能不同源）。
     ⚠️ 这里返回的是**对象**而不是裸数字：第 N 次与第 N+1 次重试的 `Date.now() + delayMs`
     完全可能算出同一个毫秒值（同一毫秒内两次事件、或 delayMs 相同且恰好对齐），
     那时 effect 的依赖没变、表就不会重起 —— 界面停在上一轮的倒计时上。
     带上 `attempt` 让"新的一次等待"必然是一个新身份。 */
  const deadline = useMemo(
    () => ({ at: Date.now() + (notice.delayMs ?? 0), attempt: notice.attempt ?? 1 }),
    [notice.delayMs, notice.attempt],
  );
  const [seconds, setSeconds] = useState(() => retrySeconds(deadline.at - Date.now()));

  useEffect(() => {
    /* 倒计时用**单发 setTimeout 链**，不是 `setInterval`：docs/05 §3.1 的"零轮询架构"
       禁止 `setInterval`（前端 lint 直接禁用该属性），禁的是**空载**轮询。
       这一条计时器不是空载：它只在"正在重试"这一行挂载期间存在（这一轮本来就在等），
       走到 1s 就自己停下，行消失时 effect 清理也把它撤掉。
       节奏取 1 秒（DSH 是 250ms）：显示值是向上取整的秒数，1 秒一跳看起来一样，
       而 250ms 会让"等待"这一格每秒多跑三次渲染 —— 这里不需要那么密。 */
    let timer: number | undefined;
    const arm = () => {
      const left = retrySeconds(deadline.at - Date.now());
      setSeconds(left);
      if (left > 1) timer = window.setTimeout(arm, 1000);
    };
    arm();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [deadline]);

  const attempt = notice.attempt ?? 1;
  const max = notice.maxAttempts ?? 1;
  const label = `正在重试模型请求（${attempt}/${max}） · ${seconds}s`;
  // 细节里的延迟是"这次要等多久"（`delayMs`），不是剩余时间 —— DSH 用 `duration.milliseconds`
  const delayText = notice.delayMs == null ? null : `${Math.round(notice.delayMs)}ms`;

  return (
    <details className="pg-notice-retry" data-notice-row data-notice="retry">
      <summary className="pg-notice-retry-summary">
        <span className="pg-notice-retry-text" role="status">
          {/* 扫光 = "正在进行"（DSH 把这一行交给 TextShimmer） */}
          <TextShimmer active>{label}</TextShimmer>
        </span>
      </summary>
      <div className="pg-notice-retry-details" data-notice-details>
        {delayText && (
          <div>
            <span className="pg-notice-detail-label">重试延迟：</span>
            {delayText}
          </div>
        )}
        {notice.errorMessage && (
          <div>
            <span className="pg-notice-detail-label">失败原因：</span>
            {notice.errorMessage}
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * 「正在压缩…」——DSH 运行中的压缩就是一行命令卡
 * （`GenericCommandCard` 的 `runningSummary`），与工具行同一套几何。
 * 它没有正文可展开（压缩结果落地后由 `compaction` 条目那一行负责显示摘要）。
 */
function CompactionNotice() {
  return (
    <div className="pg-notice-compaction" data-notice-row data-notice="compaction">
      <DisclosureRow
        icon={<Icon name="archive" size={14} />}
        title="上下文压缩"
        running
        open={false}
        expandable={false}
        onToggle={() => {}}
        rowClassName="pg-trow-head"
        collapsedContent={
          <>
            <span className="pg-trow-sep" aria-hidden="true" />
            <span className="pg-trow-summary">正在压缩…</span>
          </>
        }
      />
    </div>
  );
}
