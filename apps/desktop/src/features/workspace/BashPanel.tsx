/** bash 直执行面板（WP8，docs/04 §1.7 M1 版）：RPC bash + bash_execution_update 流式输出 */
import { useEffect, useRef, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { } from 'antd';
import { toast } from '@/lib/feedback';
import { useBash } from '@/stores/bash';
export function BashPanel({ tabId }: { tabId: string | null }) {
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const output = useBash((s) => (tabId ? s.output[tabId] ?? '' : ''));
  const append = useBash((s) => s.append);
  const clear = useBash((s) => s.clear);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [output]);

  const run = async () => {
    if (!tabId || !command.trim() || running) return;
    setRunning(true);
    append(tabId, `\n$ ${command}\n`);
    try {
      const res = await cmd<{ output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }>(
        'pi_bash',
        { tabId, command },
      );
      if (res.truncated) append(tabId, '\n(输出被截断，完整日志见 fullOutputPath)');
      append(tabId, `\n[exit ${res.exitCode ?? '?'}${res.cancelled ? ' · 已取消' : ''}]\n`);
      setCommand('');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="pg-bashpanel">
      <div className="pg-bashpanel-head">
        <span>bash 直执行（输出将随下一条消息注入上下文，docs/02 §3.3）</span>
        <span className="pg-bashpanel-ops">
          <button className="pg-btn" onClick={() => tabId && clear(tabId)}>
            清除
          </button>
          {running && (
            <button
              className="pg-btn pg-btn-danger"
              onClick={() => void cmd('pi_abort_bash', { tabId }).catch(() => {})}
            >
              中断
            </button>
          )}
        </span>
      </div>
      {!tabId ? (
        <div className="pg-fg-dim pg-bashpanel-pad">无活动会话</div>
      ) : (
        <>
          <pre ref={preRef} className="pg-bashpanel-out">
            {output || '(无输出)'}
          </pre>
          <div className="pg-bashpanel-input">
            <span className="pg-bashpanel-prompt">$</span>
            <input
              value={command}
              placeholder="输入命令，Enter 执行"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void run();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
