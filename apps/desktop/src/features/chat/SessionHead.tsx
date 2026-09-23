/**
 * 会话头部（docs/14 §4 B1）——对齐 DSH：标题 + 模式胶囊 + 右侧「打开方式 / 更多」。
 *
 * 标题来源优先级：pi 给的会话名 → 首条用户消息 → 目录名兜底（与侧栏 sessionTitle 同源语义）。
 */
import { useMemo } from 'react';
import { useTabs } from '@/stores/tabs';
import { useTabMsg } from '@/stores/messages';
import { Icon } from '@/features/common/Icon';

/** 模式胶囊文案：DSH 用「标准模式」表示权限/沙箱档位；Piggy 不自建沙箱语义（docs/11 §2.2），
 *  这里映射为 pi 的 worker 状态，避免展示一个不存在的权限模型。 */
const WORKER_LABEL: Record<string, string> = {
  spawning: '启动中',
  ready: '标准模式',
  busy: '运行中',
  crashed: '已崩溃',
  stopped: '已停止',
  sleeping: '休眠',
};

export function SessionHead({ tabId }: { tabId: string }) {
  const tab = useTabs((s) => s.tabs[tabId]);
  const firstUser = useTabMsg(tabId, (t) => {
    for (const id of t.ids) {
      const v = t.byId[id];
      if (v?.role === 'user') return flatten(v.message as { content?: unknown });
    }
    return null;
  });

  const title = useMemo(() => {
    const named = tab?.sessionName?.trim();
    if (named) return named;
    const first = firstUser?.trim();
    if (first) return first.length > 60 ? `${first.slice(0, 60)}…` : first;
    const dir = tab?.cwd?.split('/').filter(Boolean).at(-1);
    return dir ? `${dir} · 新会话` : '新会话';
  }, [tab?.sessionName, tab?.cwd, firstUser]);

  const worker = tab?.workerState ?? 'ready';

  return (
    <header className="pg-session-head">
      <div className="pg-session-head-main">
        <h1 className="pg-session-head-title" title={title}>
          {title}
        </h1>
        <span className={`pg-mode-pill pg-mode-${worker}`}>
          <Icon name="shield" size={11} />
          {WORKER_LABEL[worker] ?? worker}
        </span>
      </div>
      <div className="pg-session-head-ops">
        {/* DSH 这里是「打开方式」分裂胶囊（外部应用菜单）。Piggy 按 docs/11 §2.1 排期 M2，
            当前既无 opener 插件也未在 capability 里授权，因此**显式置灰**而不是留一个点了没反应的按钮。 */}
        <button
          className="pg-icon-btn"
          title={
            tab?.cwd
              ? `「打开方式」排期 M2（需引入 tauri-plugin-opener + 能力授权）。工作区目录：${tab.cwd}`
              : '「打开方式」排期 M2'
          }
          disabled
        >
          <Icon name="link-external" size={14} />
        </button>
        <button
          className="pg-icon-btn"
          title={tab?.cwd ? `工作区目录：${tab.cwd}（更多操作排期 M2）` : '更多操作（排期 M2）'}
          disabled
        >
          <Icon name="more" size={14} />
        </button>
      </div>
    </header>
  );
}

function flatten(m: { content?: unknown }): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}
