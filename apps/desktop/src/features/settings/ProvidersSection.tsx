/**
 * 「模型」配置页（docs/04 §2.2）：提供商列表 + 一比一对应的编辑卡片 + 添加流程。
 *
 * 版式与交互对齐 DSH `ui-settings-models/ModelsSection`：
 *   · 已配置的提供商排成行（名字 + 状态点 + 编辑/删除），一次只开一张编辑卡；
 *   · 「添加模型提供商」一张卡后面两种方式：**第三方模型提供商**（pi 内置目录里挑）
 *     或**自定义模型 API**（自己起一个 id，连中转站/自部署）；
 *   · 一个提供商都还没有时，添加卡**直接展开**（首跑姿态）——DSH 同款：
 *     空页面上留一个按钮、用户还得再点一次才看到表单，是最没必要的两步。
 *
 * 数据只有一份（`provider_overview`），任何写操作之后重新拉取——不做前端本地合并，
 * 免得界面显示的和 pi 真正读到的分叉。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, Modal, Select } from 'antd';
import { toast } from '@/lib/feedback';
import { keySourceLabel, loadOverview, removeProvider, type Overview, type ProviderRow } from '@/lib/providers';
import { ProviderEditor, type ProviderDraft } from './ProviderEditor';

type AddMode = 'catalog' | 'custom';

/** 状态点：有密钥（auth/models/env 任一）就实心。 */
function CredentialDot({ row }: { row: ProviderRow }) {
  const on = row.keySource !== 'none';
  const label = on ? `API 密钥已配置（${keySourceLabel(row)}）` : 'API 密钥缺失';
  return <span className={`pg-cred-dot ${on ? 'is-on' : 'is-off'}`} role="img" aria-label={label} title={label} />;
}

export function ProvidersSection() {
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('catalog');
  const [pickedCatalog, setPickedCatalog] = useState<string>('');
  const [customId, setCustomId] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await loadOverview();
      setData(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load().then((next) => {
      // 首跑姿态：一个提供商都没配 → 直接把添加卡打开
      if (next && next.providers.length === 0) setAddOpen(true);
    });
  }, [load]);

  const closeAdd = () => {
    setAddOpen(false);
    setPickedCatalog('');
    setCustomId('');
  };

  const rows = data?.providers ?? [];
  const taken = useMemo(() => new Set(rows.map((r) => r.provider)), [rows]);
  const addable = (data?.catalog ?? []).filter((c) => !taken.has(c.id));

  const catalogDraft: ProviderDraft | undefined = (() => {
    const picked = addable.find((c) => c.id === pickedCatalog);
    if (!picked) return undefined;
    return { provider: picked.id, name: picked.name, baseUrl: picked.baseUrl, api: picked.api, apis: picked.apis };
  })();

  const customIdProblem = (() => {
    const id = customId.trim();
    if (!id) return null;
    if (/\s/.test(id)) return '提供商 ID 不能含空格';
    if (id.includes('/')) return '提供商 ID 不能含 `/`';
    if (taken.has(id)) return '已有提供商使用了这个 ID';
    return null;
  })();
  const customDraft: ProviderDraft | undefined =
    addMode === 'custom' && customId.trim() && !customIdProblem
      ? { provider: customId.trim(), name: '', baseUrl: '', api: '', apis: [] }
      : undefined;

  const onSaved = async (provider: string) => {
    setEditing(null);
    closeAdd();
    const next = await load();
    const row = next?.providers.find((r) => r.provider === provider);
    setSaved(row ? `${row.name}（${row.provider}）` : provider);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await removeProvider(deleteTarget.provider);
      setDeleteTarget(null);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="pg-providers">
        <h2 className="pg-settings-title">模型</h2>
        <p className="pg-error">加载提供商目录失败：{loadError}</p>
        <button type="button" className="pg-btn" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="pg-providers">
      <h2 className="pg-settings-title">模型</h2>
      <p className="pg-settings-intro">填入各提供商的 API 密钥即可使用其模型。</p>
      {saved && (
        <p className="pg-providers-saved" role="status" aria-live="polite">
          已保存 {saved}。
        </p>
      )}

      <ul className="pg-provider-rows">
        {rows.map((row) => (
          <li key={row.provider} className="pg-provider-card" data-provider={row.provider}>
            <div className="pg-provider-head">
              <span className="pg-provider-identity">
                <span className="pg-provider-name">{row.name}</span>
                {row.name !== row.provider && <span className="pg-provider-route">{row.provider}</span>}
                {!row.declared && <span className="pg-provider-tag">自定义</span>}
                {row.isDefault && <span className="pg-provider-tag">默认</span>}
                <CredentialDot row={row} />
              </span>
              <span className="pg-provider-actions">
                <button
                  type="button"
                  className="pg-btn"
                  onClick={() => {
                    setSaved(null);
                    closeAdd();
                    setEditing(editing === row.provider ? null : row.provider);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="pg-btn pg-btn-danger"
                  onClick={() => setDeleteTarget(row)}
                >
                  删除
                </button>
              </span>
            </div>
            <p className="pg-provider-meta">
              密钥来自 <strong>{keySourceLabel(row)}</strong>
              {row.keyMasked ? ` · ${row.keyMasked}` : ''}
              {' · '}
              {row.baseUrl || '未填 API 地址'}
              {' · '}
              {row.models.length > 0 ? `${row.models.length} 个模型` : '模型用 pi 内置目录'}
            </p>
            {editing === row.provider && data && (
              <ProviderEditor
                row={row}
                apiOptions={data.apiOptions}
                onSaved={(p) => void onSaved(p)}
                onCancel={() => setEditing(null)}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="pg-provider-addblock">
        {addOpen ? (
          <div className="pg-provider-addcard" data-add-card>
            <div className="pg-add-modes">
              <button
                type="button"
                className={`pg-btn${addMode === 'catalog' ? ' pg-btn-primary' : ''}`}
                onClick={() => setAddMode('catalog')}
              >
                第三方模型提供商
              </button>
              <button
                type="button"
                className={`pg-btn${addMode === 'custom' ? ' pg-btn-primary' : ''}`}
                onClick={() => setAddMode('custom')}
              >
                自定义模型 API
              </button>
              <span className="pg-fg-dim">
                {addMode === 'catalog'
                  ? '从 pi 内置目录里挑一个（OpenAI、Anthropic、DeepSeek、Z.AI…），填密钥即可。'
                  : '连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口。'}
              </span>
            </div>

            {addMode === 'catalog' ? (
              <>
                <label className="pg-field">
                  <span className="pg-field-label">提供商</span>
                  <Select
                    showSearch
                    value={pickedCatalog || undefined}
                    placeholder={addable.length ? '选择一个提供商' : '目录里的提供商都已添加'}
                    disabled={addable.length === 0}
                    optionFilterProp="label"
                    onChange={setPickedCatalog}
                    style={{ maxWidth: 360 }}
                    data-testid="pg-catalog-select"
                    options={addable.map((c) => ({ value: c.id, label: `${c.name}（${c.id}）` }))}
                  />
                </label>
                {catalogDraft && (
                  <ProviderEditor
                    key={catalogDraft.provider}
                    draft={catalogDraft}
                    hideTitle
                    apiOptions={data?.apiOptions ?? []}
                    onSaved={(p) => void onSaved(p)}
                    onCancel={closeAdd}
                  />
                )}
              </>
            ) : (
              <>
                <label className="pg-field">
                  <span className="pg-field-label">提供商 ID</span>
                  <Input
                    value={customId}
                    placeholder="my-relay"
                    style={{ maxWidth: 360 }}
                    onChange={(e) => setCustomId(e.target.value)}
                    data-testid="pg-custom-id"
                  />
                  <span className="pg-fg-dim">用于 provider/model 与凭据名的唯一标识，如 my-relay、cc-switch-deep-seek</span>
                </label>
                {customIdProblem && <p className="pg-error">{customIdProblem}</p>}
                {customDraft && (
                  <ProviderEditor
                    key={customDraft.provider}
                    draft={customDraft}
                    hideTitle
                    apiOptions={data?.apiOptions ?? []}
                    onSaved={(p) => void onSaved(p)}
                    onCancel={closeAdd}
                  />
                )}
              </>
            )}
            <div className="pg-editor-footer">
              <button type="button" className="pg-btn" onClick={closeAdd}>
                收起
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="pg-provider-add" onClick={() => setAddOpen(true)}>
            + 添加模型提供商
          </button>
        )}
      </div>

      {data && (
        <p className="pg-fg-dim pg-settings-note">
          改动写入 pi 的配置文件（
          <code>{data.paths.auth}</code> / <code>{data.paths.models}</code>，原子写 + .bak 备份）；
          终端里的 <code>pi</code> 立即可见，已运行的会话需重启。
        </p>
      )}

      <Modal
        open={!!deleteTarget}
        title={deleteTarget ? `删除 ${deleteTarget.name}？` : ''}
        okText="删除"
        okButtonProps={{ danger: true, loading: busy }}
        cancelText="取消"
        onOk={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        destroyOnHidden
      >
        <p>
          删除 <strong>{deleteTarget?.provider}</strong> 会移除它在 models.json 里的配置
          <strong>和 pi 凭据库里的 API 密钥</strong>；模型目录缓存（models-store.json）保留。
        </p>
      </Modal>
    </div>
  );
}
