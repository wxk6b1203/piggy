/**
 * 模型目录编辑器（docs/04 §2.2）：一个提供商的 `models[]`。
 *
 * 后端 `provider_save` **按 id 合并**：界面管的只有 id / 显示名 / 上下文 / 输出 /
 * 推理这几列，`cost`、`compat`、`thinkingLevelMap` 这些手写字段由后端从旧行带过来。
 * 所以这里删掉一行 = 真的删，改一行 = 只改这几列，不会顺手抹掉别的。
 */
import { Input, Select } from 'antd';
import type { ModelRow } from '@/lib/providers';

interface Props {
  rows: ModelRow[];
  disabled?: boolean;
  onChange: (rows: ModelRow[]) => void;
  /** 「获取可用模型 / 检测」按钮由外部渲染（它要联网状态）。 */
  fetchSlot?: React.ReactNode;
}

const emptyRow = (): ModelRow => ({ id: '', name: '' });

export function ModelRows({ rows, disabled, onChange, fetchSlot }: Props) {
  const patch = (i: number, next: Partial<ModelRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  /** 空行/空串在这里就过滤掉：后端会拒（"模型 N 缺少 id"），但用户没必要看到那句。 */
  const numberOrNull = (v: string) => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="pg-modelrows">
      <div className="pg-modelrows-head">
        <span className="pg-field-label">模型目录</span>
        <span className="pg-fg-dim">留空 = 用 pi 内置目录；这里填了就以这里为准</span>
        {fetchSlot}
      </div>
      {rows.length === 0 ? (
        <p className="pg-fg-dim pg-modelrows-empty">
          没有声明模型：模型选择器用 pi 内置目录里这个提供商的模型。目录外 ID 仍可直接发送。
        </p>
      ) : (
        <table className="pg-modelrows-table">
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>显示名</th>
              <th title="contextWindow">上下文</th>
              <th title="maxTokens">最大输出</th>
              <th title="reasoning">推理</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-model-row={r.id || `#${i}`}>
                <td>
                  <Input
                    size="small"
                    value={r.id}
                    disabled={disabled}
                    placeholder="deepseek-flash"
                    onChange={(e) => patch(i, { id: e.target.value })}
                  />
                </td>
                <td>
                  <Input
                    size="small"
                    value={r.name ?? ''}
                    disabled={disabled}
                    placeholder="留空用 ID"
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                </td>
                <td>
                  <Input
                    size="small"
                    value={r.contextWindow == null ? '' : String(r.contextWindow)}
                    disabled={disabled}
                    placeholder="默认"
                    onChange={(e) => patch(i, { contextWindow: numberOrNull(e.target.value) })}
                  />
                </td>
                <td>
                  <Input
                    size="small"
                    value={r.maxTokens == null ? '' : String(r.maxTokens)}
                    disabled={disabled}
                    placeholder="默认"
                    onChange={(e) => patch(i, { maxTokens: numberOrNull(e.target.value) })}
                  />
                </td>
                <td>
                  <Select
                    size="small"
                    value={r.reasoning ? 'yes' : 'no'}
                    disabled={disabled}
                    onChange={(v) => patch(i, { reasoning: v === 'yes' })}
                    options={[
                      { value: 'no', label: '否' },
                      { value: 'yes', label: '是' },
                    ]}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="pg-btn pg-btn-danger"
                    disabled={disabled}
                    title="删除这一行"
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <button
          type="button"
          className="pg-btn"
          disabled={disabled}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          + 添加模型
        </button>
      </div>
    </div>
  );
}
