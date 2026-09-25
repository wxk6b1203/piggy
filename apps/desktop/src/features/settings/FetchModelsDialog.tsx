/**
 * 「获取可用模型」的选择对话框（对齐 DSH `ModelListEditor` 的 fetch 流程）。
 *
 * 两个来源：pi 的本地模型目录（`models-store.json`，不联网）或端点自己列的清单。
 * 结果里带 `source`/`url`，界面上写清楚——用户要能分辨"这是问出来的"还是"目录里的"。
 */
import { useMemo, useState } from 'react';
import { Checkbox, Input, Modal } from 'antd';
import type { DiscoveredModel } from '@/lib/providers';

interface Props {
  open: boolean;
  loading: boolean;
  error: string | null;
  models: DiscoveredModel[];
  source: 'catalog' | 'network' | null;
  url: string;
  /** 已经在表里的 id：默认不勾，且标注"已添加"。 */
  existing: string[];
  onCancel: () => void;
  onAdopt: (picked: DiscoveredModel[]) => void;
}

export function FetchModelsDialog({
  open,
  loading,
  error,
  models,
  source,
  url,
  existing,
  onCancel,
  onAdopt,
}: Props) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null); // null = 还没手动改过（默认全不勾）
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
    );
  }, [models, search]);
  const pickedSet = new Set(picked ?? []);
  const toggle = (id: string) => {
    const next = new Set(pickedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked([...next]);
  };

  return (
    <Modal
      open={open}
      title="选择要添加的模型"
      okText={`添加所选（${pickedSet.size}）`}
      cancelText="取消"
      okButtonProps={{ disabled: pickedSet.size === 0 || loading }}
      onOk={() => onAdopt(models.filter((m) => pickedSet.has(m.id)))}
      onCancel={onCancel}
      width={560}
      destroyOnHidden
    >
      <p className="pg-fg-dim" style={{ marginTop: 0 }}>
        {source === 'catalog'
          ? '来自 pi 的本地模型目录（未联网）：'
          : `端点 ${url} 列出了这些模型：`}
      </p>
      {loading && <p>正在询问提供商…</p>}
      {error && <p className="pg-error">{error}</p>}
      {!loading && !error && models.length === 0 && (
        <p>该提供商没有列出任何模型，请手动添加。</p>
      )}
      {models.length > 0 && (
        <>
          <div className="pg-fetch-tools">
            <Input
              size="small"
              placeholder="搜索模型"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
            <button
              type="button"
              className="pg-btn"
              onClick={() =>
                setPicked(
                  shown.filter((m) => !existing.includes(m.id)).every((m) => pickedSet.has(m.id))
                    ? []
                    : shown.filter((m) => !existing.includes(m.id)).map((m) => m.id),
                )
              }
            >
              {shown.length > 0 && shown.every((m) => existing.includes(m.id) || pickedSet.has(m.id))
                ? '取消全选'
                : '全选'}
            </button>
          </div>
          <div className="pg-fetch-list">
            {shown.map((m) => {
              const already = existing.includes(m.id);
              return (
                <label key={m.id} className="pg-fetch-row" data-fetch-id={m.id}>
                  <Checkbox
                    checked={already || pickedSet.has(m.id)}
                    disabled={already}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="pg-fetch-id">{m.id}</span>
                  {m.name && m.name !== m.id && <span className="pg-fg-dim">{m.name}</span>}
                  {m.contextWindow != null && (
                    <span className="pg-fg-dim">ctx {m.contextWindow}</span>
                  )}
                  {already && <span className="pg-fg-dim">已添加</span>}
                </label>
              );
            })}
            {shown.length === 0 && <p className="pg-fg-dim">没有匹配的模型。</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
