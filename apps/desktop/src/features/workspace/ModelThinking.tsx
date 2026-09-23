/** 模型 / Thinking 控件（WP3，docs/02 §3.2）：Cmd+L 选择器 + thinking 循环 */
import { useEffect, useState } from 'react';
import { Popover, List, } from 'antd';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { useTabs } from '@/stores/tabs';

interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export function ModelThinkingControls({ tabId }: { tabId: string | null }) {
  const model = useTabs((s) => (tabId ? s.tabs[tabId]?.model ?? null : null));
  const thinking = useTabs((s) => (tabId ? s.tabs[tabId]?.thinkingLevel ?? null : null));
  const patch = useTabs((s) => s.patch);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && models === null && tabId) {
      setLoading(true);
      cmd<{ models: ModelInfo[] }>('pi_get_available_models', { tabId })
        .then((r) => setModels(r.models ?? []))
        .catch((e) => {
          toast.error(String(e));
          setModels([]);
        })
        .finally(() => setLoading(false));
    }
  }, [open, models, tabId]);

  const pick = async (m: ModelInfo) => {
    if (!tabId) return;
    try {
      await cmd('pi_set_model', { tabId, provider: m.provider, modelId: m.id });
      patch(tabId, { model: { id: m.id, provider: m.provider } });
      setOpen(false);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const cycleThinking = async () => {
    if (!tabId) return;
    try {
      const r = await cmd<{ level?: string; data?: { level?: string } }>('pi_cycle_thinking', { tabId });
      patch(tabId, { thinkingLevel: r.level ?? r.data?.level ?? null });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const grouped = new Map<string, ModelInfo[]>();
  for (const m of models ?? []) {
    if (!grouped.has(m.provider)) grouped.set(m.provider, []);
    grouped.get(m.provider)!.push(m);
  }

  return (
    <span className="pg-mt-controls">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        content={
          <div className="pg-model-list">
            {loading && <div className="pg-fg-dim">加载中…</div>}
            {models?.length === 0 && <div className="pg-fg-dim">无可用模型（检查认证）</div>}
            {[...grouped.entries()].map(([provider, list]) => (
              <div key={provider}>
                <div className="pg-model-provider">{provider}</div>
                <List
                  size="small"
                  dataSource={list}
                  renderItem={(m) => (
                    <List.Item
                      className={`pg-model-item${m.id === model?.id ? ' pg-model-active' : ''}`}
                      onClick={() => void pick(m)}
                    >
                      <span>{m.name ?? m.id}</span>
                      {m.contextWindow ? (
                        <span className="pg-fg-dim pg-model-ctx">
                          {Math.round(m.contextWindow / 1000)}k
                        </span>
                      ) : null}
                    </List.Item>
                  )}
                />
              </div>
            ))}
          </div>
        }
      >
        <button className="pg-btn pg-model-btn" onClick={() => setOpen(true)}>
          {model ? `${model.provider}/${model.id}` : '选择模型'} ⌄
        </button>
      </Popover>
      {thinking && (
        <button className="pg-btn pg-think-btn" onClick={() => void cycleThinking()} title="循环 thinking 级别">
          ◈ {thinking}
        </button>
      )}
    </span>
  );
}
