/**
 * 模型 + thinking 强度选择器（Composer 工具行右侧，DSH `conversation.input.model` 位）。
 *
 * 两个数据源都来自 pi 的 RPC，前端不猜：
 *   - 模型列表：`get_available_models` → 按 provider 分组
 *   - thinking 档：`get_available_thinking_levels` → **由当前模型决定**（不支持推理的模型只返回 `["off"]`）
 * 因此切模型后必须重新拉一次 thinking 档，否则会显示上一个模型的档位。
 *
 * 为什么之前"点了没反应"：`Composer` 的模型胶囊只 `windowEvents.emit('open-model-picker')`，
 * 而全仓**没有任何监听者**（旧的 `ModelThinking.tsx` 从未被挂载）。这里改成自持状态的选择器。
 */
import { useEffect, useState } from 'react';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { useTabs } from '@/stores/tabs';
import { Icon } from '@/features/common/Icon';
import { Picker, type PickerItem } from '@/features/common/Picker';
import { thinkingLabel as thinkLabel } from '@/lib/thinking';

interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export function ModelPicker({ tabId }: { tabId: string }) {
  const model = useTabs((s) => s.tabs[tabId]?.model ?? null);
  const thinking = useTabs((s) => s.tabs[tabId]?.thinkingLevel ?? null);
  const patch = useTabs((s) => s.patch);

  const [modelsOpen, setModelsOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [levels, setLevels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  // 模型列表按需拉取一次（会话内基本不变）
  useEffect(() => {
    if (!modelsOpen || models !== null) return;
    setLoading(true);
    void cmd<{ models: ModelInfo[] }>('pi_get_available_models', { tabId })
      .then((r) => setModels(r.models ?? []))
      .catch((e) => {
        toast.error(String(e));
        setModels([]);
      })
      .finally(() => setLoading(false));
  }, [modelsOpen, models, tabId]);

  // thinking 档与当前模型绑定：每次打开都重取，避免显示上一个模型的档位
  useEffect(() => {
    if (!thinkingOpen) return;
    setLoading(true);
    setLevels(null);
    void cmd<{ levels: string[] }>('pi_get_available_thinking_levels', { tabId })
      .then((r) => setLevels(r.levels ?? ['off']))
      .catch((e) => {
        toast.error(String(e));
        setLevels(['off']);
      })
      .finally(() => setLoading(false));
  }, [thinkingOpen, tabId]);

  const pickModel = async (id: string) => {
    const m = models?.find((x) => x.id === id);
    if (!m) return;
    try {
      await cmd('pi_set_model', { tabId, provider: m.provider, modelId: m.id });
      patch(tabId, { model: { id: m.id, provider: m.provider } });
      // 换模型后旧的 thinking 档可能不适用 → 立刻用 pi 回报的当前值刷新
      const st = await cmd<{ thinkingLevel?: string }>('pi_get_state', { tabId });
      patch(tabId, { thinkingLevel: st.thinkingLevel ?? null });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const pickThinking = async (level: string) => {
    try {
      await cmd('pi_set_thinking_level', { tabId, level });
      patch(tabId, { thinkingLevel: level });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const modelItems: PickerItem[] = (models ?? []).map((m) => ({
    id: m.id,
    label: m.name ?? m.id,
    group: m.provider,
    active: m.id === model?.id,
    hint: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : undefined,
    detail: m.reasoning ? undefined : '不支持 thinking',
  }));

  const thinkingItems: PickerItem[] = (levels ?? []).map((lv) => ({
    id: lv,
    label: thinkLabel(lv),
    active: lv === thinking,
  }));

  // 模型不支持推理（levels == ['off']）时，thinking 入口直接禁用并说明原因，
  // 而不是留一个点了没用的按钮。levels 未拉取前不禁用（还不知道支不支持）。
  const thinkingSupported = levels === null || levels.some((l) => l !== 'off');

  return (
    <>
      <Picker
        className="pg-pill pg-model-select"
        buttonTitle={`切换模型（当前 ${model ? `${model.provider}/${model.id}` : '未选择'}）`}
        items={modelItems}
        onPick={(id) => void pickModel(id)}
        onOpenChange={setModelsOpen}
        openSignal="open-model-picker"
        title="模型"
        width={320}
        loading={loading && models === null}
        emptyText="无可用模型（检查认证 / models 配置）"
      >
        {/* 模型胶囊只显示模型名。这里曾同时渲染 thinking 档位，
            而紧挨着右边就有一个专门的思考强度胶囊 —— 同一信息出现两遍。
            DSH 的 `.select` 也只放模型名。 */}
        <span className="pg-pill-strong">{model?.id ?? '选择模型'}</span>
        <Icon name="chevron-down" size={12} />
      </Picker>

      <Picker
        className="pg-pill pg-thinking-select"
        buttonTitle={
          thinkingSupported
            ? '思考强度（可选档位由当前模型决定）'
            : `${model?.id ?? '当前模型'} 不支持 thinking`
        }
        items={thinkingItems}
        onPick={(id) => void pickThinking(id)}
        onOpenChange={setThinkingOpen}
        openSignal="open-thinking-picker"
        title={`思考强度${model ? ` · ${model.id}` : ''}`}
        width={230}
        disabled={!thinkingSupported}
        loading={loading && levels === null}
        emptyText="当前模型不支持 thinking"
        footer={thinkingSupported ? undefined : '当前模型未声明推理能力，档位固定为「关闭」。'}
      >
        <Icon name="lightbulb" size={12} />
        {thinking ? thinkLabel(thinking) : '思考'}
        <Icon name="chevron-down" size={12} />
      </Picker>
    </>
  );
}
