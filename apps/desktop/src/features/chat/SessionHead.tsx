/**
 * 会话头部（docs/14 §4 B1）——标题 + 右侧「打开方式 / 更多」。
 *
 * 这里**没有模式胶囊**：DSH 那枚胶囊表示权限/沙箱档位，而 Piggy 的档位是真实可选的，
 * 归属在 Composer 工具行（DSH 的 `conversation.input.permission` 位），
 * 在标题旁边再放一个只读副本只会让人以为它可点。
 * worker 运行状态改由 Composer 上方的流式条 + 状态行表达。
 */
import { useMemo } from 'react';
import { useTabs } from '@/stores/tabs';
import { useTabMsg } from '@/stores/messages';
import { Icon } from '@/features/common/Icon';

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

  return (
    <header className="pg-session-head">
      <div className="pg-session-head-main">
        <h1 className="pg-session-head-title" title={title}>
          {title}
        </h1>
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
