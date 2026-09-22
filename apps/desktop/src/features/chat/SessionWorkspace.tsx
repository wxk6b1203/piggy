/** 会话工作面（docs/04 §2.1）：一个会话 tab 的内容 = 转录 + 输入区 */
import { SessionWorkspaceComposer as Composer } from './Composer';
import { Transcript } from './Transcript';

export function SessionWorkspace({ tabId }: { tabId: string }) {
  return (
    <div className="pg-workspace">
      <Transcript tabId={tabId} />
      <Composer tabId={tabId} />
    </div>
  );
}
