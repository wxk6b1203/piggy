/**
 * 「标题素材预览」（docs/04 §2.4）。
 *
 * 不调用模型，只把**会拿什么去生成**列出来。存在的理由是排查：
 * 生成出来的标题不满意时，第一个要问的就是"它到底看到了哪几条消息、用的是哪个模型"。
 * 没有这个界面的话，唯一的办法是去翻会话 JSONL 再猜。
 *
 * 拆成独立组件而不是塞在侧栏里：侧栏已经很长，而且这一块自己有一串渲染分支
 * （有/没有第一条、有/没有最近几条、有没有用户文字消息）值得单独测。
 */
import { Modal } from 'antd';
import type { TitleSourceInfo } from '@/lib/sessionTitle';
import { thinkingLabel } from '@/lib/thinking';

/** "这个模型是谁定的"——用户对标题不满意时，改法完全取决于这一格。 */
function sourceLabel(s: TitleSourceInfo['modelSource']): string {
  if (s === 'override') return '设置里指定的';
  if (s === 'session') return '会话自己最后一次用过的';
  if (s === 'invalid') return '设置里写错了';
  return 'pi 的默认';
}

export function SessionTitlePreview({
  open,
  info,
  error,
  onClose,
}: {
  open: boolean;
  info: TitleSourceInfo | null;
  error: string | null;
  onClose: () => void;
}) {
  const strategyLabel = (s: string) =>
    s === 'first' ? '只看第一条' : s === 'recent' ? '只看最近几条' : '第一条 + 最近几条';

  return (
    <Modal open={open} title="标题素材预览" footer={null} onCancel={onClose} width={560}>
      {error && <p className="pg-plugin-error">读不出素材：{error}</p>}
      {info && (
        <div className="pg-title-preview" data-title-preview>
          <p className="pg-title-preview-row">
            <span>取材方式</span>
            <strong>{strategyLabel(info.strategy)}</strong>
            <span>上限 {info.maxChars} 字</span>
          </p>
          <p className="pg-title-preview-row">
            <span>会用哪个模型</span>
            <strong data-title-model>
              {info.modelSource === 'invalid'
                ? '设置里的「标题模型」写错了'
                : info.modelUsed
                  ? `${info.modelUsed}（${sourceLabel(info.modelSource)}）`
                  : 'pi 的默认模型（设置与会话里都没指定）'}
            </strong>
          </p>
          {info.modelError && (
            <p className="pg-plugin-warn" data-title-model-error>
              {info.modelError}
            </p>
          )}
          <p className="pg-title-preview-row">
            <span>思考强度</span>
            <strong data-title-thinking>
              {info.thinking ? thinkingLabel(info.thinking) : '不传（用模型自己的默认档）'}
            </strong>
          </p>
          <p className="pg-title-preview-row">
            <span>会话消息</span>
            <span>
              共 {info.messageCount} 条，其中用户文字消息 {info.userMessageCount} 条
            </span>
          </p>
          {info.firstMessage && (
            <div className="pg-title-preview-block">
              <p className="pg-title-preview-label">第一条用户消息</p>
              <pre>{info.firstMessage}</pre>
            </div>
          )}
          {info.recentMessages.length > 0 && (
            <div className="pg-title-preview-block">
              <p className="pg-title-preview-label">最近的用户消息</p>
              <ul>
                {info.recentMessages.map((m, i) => (
                  <li key={`${i}-${m.slice(0, 8)}`}>
                    <pre>{m}</pre>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {info.userMessageCount === 0 && (
            <p className="pg-plugin-warn">
              这个会话里还没有用户文字消息（只有图片或工具结果）——生成出来的标题会是模型瞎编的。
            </p>
          )}
          <p className="pg-title-preview-note">
            生成会另起一个**独立的 pi 进程**（<code>--no-session</code>），
            所以这段对话不会进这个会话的转录。
          </p>
        </div>
      )}
    </Modal>
  );
}
