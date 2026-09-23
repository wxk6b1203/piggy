/**
 * 会话工作面（M1：对话|轨迹 二级页签 + 扩展 Widgets 区，docs/04 §1.10/§2.1）
 * 头部行对齐 DSH（docs/14 §4 B1）：标题 + 模式胶囊 + 右侧操作。
 */
import { useState } from 'react';
import { SessionWorkspaceComposer as Composer } from './Composer';
import { Transcript } from './Transcript';
import { TrajectoryView } from './TrajectoryView';
import { SessionHead } from './SessionHead';
import { useUi } from '@/stores/ui';

export function SessionWorkspace({ tabId }: { tabId: string }) {
  const [view, setView] = useState<'chat' | 'traj'>('chat');
  const widgetLines = useUi((s) => s.widgets[tabId]);

  return (
    <div className="pg-workspace">
      <SessionHead tabId={tabId} />
      <div className="pg-ws-tabs" role="tablist">
        <button
          className={`pg-ws-tab${view === 'chat' ? ' pg-ws-tab-active' : ''}`}
          role="tab"
          aria-selected={view === 'chat'}
          onClick={() => setView('chat')}
        >
          对话
        </button>
        <button
          className={`pg-ws-tab${view === 'traj' ? ' pg-ws-tab-active' : ''}`}
          role="tab"
          aria-selected={view === 'traj'}
          onClick={() => setView('traj')}
        >
          轨迹
        </button>
      </div>
      {view === 'chat' ? (
        <>
          {widgetLines && widgetLines.length > 0 && (
            <div className="pg-widget">
              {widgetLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
          <Transcript tabId={tabId} />
          <Composer tabId={tabId} />
        </>
      ) : (
        <TrajectoryView tabId={tabId} />
      )}
    </div>
  );
}
