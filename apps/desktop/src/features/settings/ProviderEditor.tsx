/**
 * 一个提供商的编辑卡片（docs/04 §2.2，对齐 DSH `ui-settings-models/ProviderEditor`）。
 *
 * 三段：
 *   1. **API 密钥** —— 主字段，写进去的密钥默认落 pi 的凭据库 auth.json
 *      （pi 解析密钥时它优先级最高，见 `provider-composer.ts:347-375`）；
 *   2. **检测** —— 真问一次端点（或读 pi 的本地模型目录），把"测了什么、结果如何"写出来；
 *   3. **自定义设置**（折叠）—— API 地址 / API 协议 / 模型目录 / 获取可用模型。
 *
 * 两条刻意的设计：
 *   · 密钥存在哪儿是**用户可见的选择**（auth.json 或 models.json）：两种写法在真实
 *     用户机器上都存在（cc-switch 那类工具写 models.json 内联），默认跟随现状，
 *     不偷偷搬家；
 *   · 内联密钥与 auth.json 同时存在时，**界面上必须说出来**——因为 pi 只用 auth.json
 *     那把，另一把是死数据。让用户以为改了 models.json 就生效，是最坏的一种失败。
 */
import { useState } from 'react';
import { Input, Select } from 'antd';
import { toast } from '@/lib/feedback';
import {
  apiLabel,
  discoverModels,
  keySourceLabel,
  removeProviderKey,
  saveProvider,
  setProviderKey,
  type DiscoveredModel,
  type Discovery,
  type ModelRow,
  type ProviderRow,
} from '@/lib/providers';
import { ModelRows } from './ModelRows';
import { FetchModelsDialog } from './FetchModelsDialog';

export interface ProviderDraft {
  provider: string;
  name: string;
  baseUrl: string;
  api: string;
  /** pi 为该提供商声明的协议；空 = 自定义路由，给全部选项。 */
  apis: string[];
}

interface Props {
  /** 已存在的行；添加流程里为 undefined（此时用 draft）。 */
  row?: ProviderRow;
  draft?: ProviderDraft;
  /** 是否显示标题（添加卡片自己带标题）。 */
  hideTitle?: boolean;
  apiOptions: string[];
  onSaved: (provider: string) => void;
  onCancel: () => void;
}

const isHttp = (s: string) => /^https?:\/\//.test(s.trim());

export function ProviderEditor({ row, draft, hideTitle, apiOptions, onSaved, onCancel }: Props) {
  const provider = row?.provider ?? draft?.provider ?? '';
  const [name, setName] = useState(row?.name ?? draft?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(row?.baseUrl ?? draft?.baseUrl ?? '');
  const [api, setApi] = useState(row?.api ?? draft?.api ?? '');
  const [models, setModels] = useState<ModelRow[]>(row?.models ?? []);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  // 跟随现状：已经写在 models.json 里的就继续写那儿，否则默认进凭据库
  const [store, setStore] = useState<'auth' | 'models'>(
    row?.keySource === 'models_json' ? 'models' : 'auth',
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Discovery | null>(null);

  const protocols = row?.apis?.length ? row.apis : draft?.apis?.length ? draft.apis : apiOptions;
  const keyConfigured = !!row && row.keySource !== 'none';
  const envProvided = row?.keySource === 'env';

  // 本地的同一套校验：不合格就别发请求（后端也会拦，但这里能马上说清是哪一行）
  const modelProblem = (() => {
    const ids = models.map((m) => (m.id ?? '').trim());
    if (ids.some((id) => !id)) return '有模型没填 ID';
    if (new Set(ids).size !== ids.length) return '模型 ID 不能重复';
    return null;
  })();
  const baseUrlProblem = baseUrl.trim() && !isHttp(baseUrl) ? 'API 地址要以 http:// 或 https:// 开头' : null;
  const canSave = !busy && !modelProblem && !baseUrlProblem && provider.trim().length > 0;

  const probeOnce = async (): Promise<Discovery | null> => {
    try {
      setFetchError(null);
      const d = await discoverModels(provider, baseUrl, api, keyDraft);
      setProbe({
        ok: true,
        text:
          d.source === 'catalog'
            ? `连接正常 · pi 本地模型目录里有 ${d.models.length} 个模型（未联网）`
            : `连接正常 · ${d.url} 列出 ${d.models.length} 个模型`,
      });
      return d;
    } catch (e) {
      const reason = String(e);
      setProbe({ ok: false, text: reason });
      setFetchError(reason);
      return null;
    }
  };

  const runProbe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await probeOnce();
    } finally {
      setBusy(false);
    }
  };

  const runFetch = async () => {
    if (busy) return;
    setBusy(true);
    setFetching(true);
    setFetched(null);
    setFetchOpen(true);
    try {
      const d = await probeOnce();
      setFetched(d);
    } finally {
      setFetching(false);
      setBusy(false);
    }
  };

  const adopt = (picked: DiscoveredModel[]) => {
    const known = new Set(models.map((m) => m.id.trim()));
    const added: ModelRow[] = picked
      .filter((m) => !known.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: m.reasoning ?? false,
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
        input: m.input ?? null,
      }));
    // 目录里带回的容量/推理标记优先于手上已有的同名行：它们是端点的权威数据
    setModels((prev) => {
      const byId = new Map(prev.map((m) => [m.id.trim(), m]));
      for (const m of picked) {
        const old = byId.get(m.id);
        if (old) {
          byId.set(m.id, {
            ...old,
            name: old.name || m.name || m.id,
            reasoning: m.reasoning ?? old.reasoning,
            contextWindow: m.contextWindow ?? old.contextWindow,
            maxTokens: m.maxTokens ?? old.maxTokens,
          });
        }
      }
      return [...byId.values(), ...added];
    });
    setFetchOpen(false);
    toast.success(added.length ? `已加入 ${added.length} 个模型（记得保存）` : '已用目录里的信息更新现有模型');
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setFailure(null);
    try {
      await saveProvider(provider, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        api,
        // 空行在这里就丢掉，不让后端报"模型 3 缺少 id"
        models: models
          .filter((m) => (m.id ?? '').trim())
          .map((m) => ({ ...m, id: m.id.trim() })),
      });
      // 密钥最后写：配置先落盘，之后即使密钥写失败，提供商也不会处于"半张卡"状态
      if (keyDraft.trim()) await setProviderKey(provider, keyDraft.trim(), store);
      setKeyDraft('');
      onSaved(provider);
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  };

  const dropInlineKey = async () => {
    setBusy(true);
    try {
      await removeProviderKey(provider, 'models');
      toast.success('已从 models.json 删掉内联密钥（auth.json 里那把继续生效）');
      onSaved(provider);
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  };

  const keyPlaceholder = envProvided
    ? `由环境变量 ${row?.envVar} 提供（填入新值会写进 ${store === 'auth' ? 'auth.json' : 'models.json'} 并覆盖它）`
    : keyConfigured
      ? '已配置——输入新值可替换'
      : '输入 API 密钥';

  return (
    <div className="pg-provider-editor" data-provider-editor={provider}>
      {!hideTitle && (
        <div className="pg-editor-title">
          <span className="pg-provider-name">{name || provider}</span>
          {name && name !== provider && <span className="pg-provider-route">{provider}</span>}
        </div>
      )}

      <label className="pg-field">
        <span className="pg-field-label">API 密钥</span>
        <div className="pg-key-row">
          <Input.Password
            value={keyDraft}
            placeholder={keyPlaceholder}
            visibilityToggle={{ visible: showKey, onVisibleChange: setShowKey }}
            onChange={(e) => setKeyDraft(e.target.value)}
            data-testid="pg-key-input"
          />
          <button type="button" className="pg-btn" disabled={busy} onClick={() => void runProbe()}>
            检测
          </button>
        </div>
      </label>
      <div className="pg-key-meta">
        <span className="pg-fg-dim">
          当前生效的密钥来自：<strong>{row ? keySourceLabel(row) : '（尚未保存）'}</strong>
          {row?.keyMasked ? ` · ${row.keyMasked}` : ''}
        </span>
        <label className="pg-fg-dim pg-key-store">
          存入
          <Select
            size="small"
            value={store}
            onChange={setStore}
            style={{ width: 190 }}
            options={[
              { value: 'auth', label: 'pi 凭据库 auth.json' },
              { value: 'models', label: 'models.json（明文）' },
            ]}
          />
        </label>
      </div>

      {/* 两处都有密钥时，只能有一把生效 —— 必须说出来，否则改错了也不知道 */}
      {row?.hasInlineKey && row.keySource !== 'models_json' && (
        <p className="pg-provider-warn">
          models.json 里还留着一把内联密钥（明文），但 pi 用的是 <strong>{keySourceLabel(row)}</strong> 那把，
          内联这把<strong>当前不生效</strong>。
          <button type="button" className="pg-btn" disabled={busy} onClick={() => void dropInlineKey()}>
            从 models.json 删掉它
          </button>
        </p>
      )}
      {probe && (
        <p className={probe.ok ? 'pg-probe-ok' : 'pg-error'} role="status">
          {probe.ok ? '✅ ' : '❌ '}
          {probe.text}
        </p>
      )}

      <details className="pg-customized">
        <summary>自定义设置</summary>
        <div className="pg-customized-body">
          <label className="pg-field">
            <span className="pg-field-label">API 地址</span>
            <Input
              value={baseUrl}
              placeholder={row?.baseUrlSource === 'catalog' ? row.baseUrl : 'https://gateway.example/v1'}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="pg-baseurl-input"
            />
            <span className="pg-fg-dim">
              {row?.baseUrlSource === 'catalog'
                ? '留空 = 用 pi 内置目录里的默认地址'
                : '留空 = 由 pi 的目录/环境决定（可能没有）'}
            </span>
          </label>
          <label className="pg-field">
            <span className="pg-field-label">API 协议</span>
            <Select
              value={api || undefined}
              placeholder="未选择"
              onChange={setApi}
              style={{ maxWidth: 320 }}
              options={protocols.map((p) => ({ value: p, label: apiLabel(p) }))}
            />
            <span className="pg-fg-dim">
              {row?.apiSource === 'catalog' ? '默认取 pi 内置目录里的协议' : '由 models.json 决定'}
            </span>
          </label>

          <ModelRows
            rows={models}
            disabled={busy}
            onChange={setModels}
            fetchSlot={
              <span className="pg-modelrows-fetch">
                {row && row.cachedModels > 0 && (
                  <span className="pg-fg-dim">pi 本地目录里有 {row.cachedModels} 个</span>
                )}
                <button type="button" className="pg-btn" disabled={busy} onClick={() => void runFetch()}>
                  获取可用模型
                </button>
              </span>
            }
          />
        </div>
      </details>

      {modelProblem && <p className="pg-error">{modelProblem}</p>}
      {baseUrlProblem && <p className="pg-error">{baseUrlProblem}</p>}
      {failure && <p className="pg-error">{failure}</p>}

      <div className="pg-editor-footer">
        <button type="button" className="pg-btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="button" className="pg-btn pg-btn-primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      <FetchModelsDialog
        open={fetchOpen}
        loading={fetching}
        error={fetchError}
        models={fetched?.models ?? []}
        source={fetched?.source ?? null}
        url={fetched?.url ?? ''}
        existing={models.map((m) => m.id.trim()).filter(Boolean)}
        onCancel={() => setFetchOpen(false)}
        onAdopt={adopt}
      />
    </div>
  );
}
