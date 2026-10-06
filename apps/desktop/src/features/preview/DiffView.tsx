/**
 * 改动标签页（DSH `ReviewTab` 的单文件版）：**这一轮把某个文件改成了什么样**。
 *
 * 数据来自工具结果的 `details.patch`（pi 自己算好的实际 diff，见 `lib/diff.ts`），
 * 所以这个标签**不需要**任何新的后端读取：开标签时按 `{tabId, callId}` 去
 * messages store 的工具结果索引里取。
 *
 * 取不到时（应用重启后恢复出来的旧标签、会话标签已关闭）显示一句实话，
 * 而不是空白页 —— 用户看到空白只会以为"这个功能坏了"。
 *
 * 头部复用文件预览那一套几何（38px、`pg-preview-*`），
 * 工具按钮两颗：统一/并排、折行；外加上「打开文件」（跳到普通的文件预览标签）。
 */
import { useState } from 'react';
import { useTabMsg, useToolResult } from '@/stores/messages';
import { diffTotals, editedPathOf, patchOfResult } from '@/lib/diff';
import { splitPath } from '@/lib/paths';
import { Icon } from '@/features/common/Icon';
import { FileDiff } from './FileDiff';

export function DiffView({
  tabId,
  callId,
  title,
  onOpenFile,
}: {
  tabId: string;
  callId: string;
  /** 标签标题（关掉之后用户还能从对话里再打开） */
  title?: string;
  onOpenFile?: (path: string) => void;
}) {
  const result = useToolResult(tabId, callId);
  /* 调用参数里也有路径（patch 头偶尔缺失时的兜底）：`toolCalls` 索引是稳定的对象，
     这里只读一次，不会因为流式帧重渲染。 */
  const call = useTabMsg(tabId, (t) => t.toolCalls[callId]);
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);

  const patch = result ? patchOfResult(result.toolName, result.details) : null;

  if (!patch) {
    return (
      <div className="pg-preview" data-diff-missing>
        <div className="pg-preview-head">
          <span className="pg-preview-path">
            <span className="pg-preview-pathtext">
              <span className="pg-preview-name">{title ?? '改动'}</span>
            </span>
          </span>
        </div>
        <div className="pg-missing">
          改动内容不在内存里。回到对话里的「已编辑 N 个文件」卡片，点一下就能重新打开。
        </div>
      </div>
    );
  }

  const path = patch.path ?? editedPathOf(call?.args) ?? title ?? '';
  const { added, removed } = diffTotals(patch.hunks);
  const { dir, name } = splitPath(path);

  return (
    <div className="pg-preview pg-diffview" data-diffview data-diff-path={path}>
      <div className="pg-preview-head">
        <span className="pg-preview-path" data-diff-title>
          <span className="pg-preview-dir">{dir}</span>
          <span className="pg-preview-name">{name}</span>
        </span>
        <span className="pg-cf-counts" data-diff-total>
          <span className="pg-cf-added">+{added}</span>
          <span className="pg-cf-deleted">-{removed}</span>
        </span>
        <button
          type="button"
          className="pg-preview-tool"
          aria-pressed={split}
          aria-label={split ? '切回统一视图' : '并排视图'}
          title={split ? '切回统一视图' : '并排视图'}
          data-diff-tool="split"
          onClick={() => setSplit((v) => !v)}
        >
          <Icon name="split-horizontal" size={15} />
        </button>
        <button
          type="button"
          className="pg-preview-tool"
          aria-pressed={wrap}
          aria-label={wrap ? '不折行' : '折行'}
          title={wrap ? '不折行' : '折行'}
          data-diff-tool="wrap"
          onClick={() => setWrap((v) => !v)}
        >
          <Icon name="word-wrap" size={15} />
        </button>
        {path ? (
          <button
            type="button"
            className="pg-preview-tool"
            aria-label="打开文件"
            title="打开文件"
            data-diff-tool="open-file"
            onClick={() => onOpenFile?.(path)}
          >
            <Icon name="inspect" size={15} />
          </button>
        ) : null}
      </div>
      <div className="pg-preview-body pg-diffview-body">
        <FileDiff hunks={patch.hunks} split={split} wrap={wrap} />
      </div>
    </div>
  );
}
