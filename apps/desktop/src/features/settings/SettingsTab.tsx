/**
 * 设置 tab（WP5，docs/09 §3.1）：Provider 凭据 / 自定义模型 / pi 设置。
 * 三文件（auth/models/settings）表单化 + Monaco 原始 JSON 编辑，原子写 + .bak（Rust pi_files）。
 * 注意：已运行 worker 持有旧配置，改动对新会话生效（UI 明示）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Modal, Input, Button, List, Popconfirm } from 'antd';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { MonacoHost } from '@/features/common/MonacoHost';

type Tab = 'auth' | 'models' | 'settings' | 'runtime';

export function SettingsTab() {
  const [tab, setTab] = useState<Tab>('auth');
  return (
    <div className="pg-settings">
      <div className="pg-settings-tabs">
        {(
          [
            ['auth', 'Provider 认证'],
            ['models', '自定义模型'],
            ['settings', 'pi 设置'],
            ['runtime', '运行'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`pg-btn${tab === k ? ' pg-btn-primary' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'auth' && <AuthSection />}
      {tab === 'models' && <ModelsSection />}
      {tab === 'settings' && <SettingsSection />}
      {tab === 'runtime' && <RuntimeSection />}
      <p className="pg-fg-dim pg-settings-note">改动写入 pi 标准配置文件（原子写 + .bak 备份）；对新建会话生效。</p>
    </div>
  );
}

/* ---------------- 运行（Piggy 自身设置：pi 可执行文件 / 默认权限档位 / 并发） ---------------- */

interface PiSourceOption {
  id: 'system' | 'bundled' | 'custom';
  label: string;
  available: boolean;
}
interface PiSourceState {
  source: PiSourceOption['id'];
  customPath: string | null;
  builtinAvailable: boolean;
  builtinPath: string | null;
  current: { path: string; version: string; source: string; via: string; fromEnv: boolean } | null;
  options: PiSourceOption[];
}
interface PermissionModeInfo {
  id: 'read-only' | 'workspace' | 'full';
  label: string;
  tools: string | null;
  pathGuard: boolean;
}

/**
 * 运行设置。
 *
 * 「默认使用系统 pi」是明确的产品要求：安装包虽然捆绑自定义 pi，
 * 但不能劫持用户机器上已有的安装。所以来源默认 system，捆绑只作为显式选项
 * 与"系统没装 pi"时的兜底。这里同时把**实际生效的那个二进制**显示出来——
 * 设置值不等于结果（有回退、也可能被 PI_BIN 覆盖），必须让人看得见。
 */
function RuntimeSection() {
  const [pi, setPi] = useState<PiSourceState | null>(null);
  const [permModes, setPermModes] = useState<PermissionModeInfo[]>([]);
  const [perm, setPerm] = useState<string>('workspace');
  const [perf, setPerf] = useState({ max_workers: 8, idle_timeout_min: 10 });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void cmd<PiSourceState>('pi_source_options').then(setPi).catch((e) => toast.error(String(e)));
    void cmd<{ modes: PermissionModeInfo[] }>('permission_modes')
      .then((r) => setPermModes(r.modes ?? []))
      .catch(() => {});
    void cmd<{ max_workers: number; idle_timeout_min: number; permission_mode?: string }>('perf_config_load')
      .then((c) => {
        setPerf({ max_workers: c.max_workers, idle_timeout_min: c.idle_timeout_min });
        if (c.permission_mode) setPerm(c.permission_mode);
      })
      .catch(() => {});
  }, []);

  useEffect(reload, [reload]);

  const save = async (patch: { piSource?: string; piPath?: string; permissionMode?: string; perf?: typeof perf }) => {
    if (busy) return;
    setBusy(true);
    try {
      await cmd('perf_config_save', {
        maxWorkers: patch.perf?.max_workers ?? perf.max_workers,
        idleTimeoutMin: patch.perf?.idle_timeout_min ?? perf.idle_timeout_min,
        piSource: patch.piSource,
        piPath: patch.piPath,
      });
      // 改的是"新会话默认档位"，不是某个标签页的档位 —— 用专门的命令，不传 tabId
      if (patch.permissionMode) await cmd('pi_set_default_permission', { mode: patch.permissionMode });
      toast.success('已保存（对新建会话生效；已在跑的会话需重启）');
      reload();
    } catch (e) {
      // 配置有问题就在这里报出来，而不是等用户开新会话才炸
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickPath = async () => {
    try {
      const p = await cmd<string | null>('pick_directory');
      if (p) await save({ piSource: 'custom', piPath: p });
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="pg-settings-editor">
      <div className="pg-settings-row">
        <span className="pg-settings-label">pi 可执行文件</span>
        <div className="pg-runtime-modes">
          {(pi?.options ?? []).map((o) => (
            <button
              key={o.id}
              className={`pg-btn${pi?.source === o.id ? ' pg-btn-primary' : ''}`}
              disabled={!o.available || busy}
              title={o.available ? undefined : '当前是 lite SKU（未捆绑 pi）'}
              onClick={() => void save({ piSource: o.id })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {pi?.source === 'custom' && (
        <div className="pg-settings-row">
          <span className="pg-settings-label">自定义路径</span>
          <Input
            value={pi.customPath ?? ''}
            placeholder="/path/to/pi"
            onChange={(e) => setPi((s) => (s ? { ...s, customPath: e.target.value } : s))}
            onBlur={() => void save({ piSource: 'custom', piPath: pi.customPath ?? '' })}
          />
          <Button onClick={() => void pickPath()}>选择目录…</Button>
        </div>
      )}

      <div className="pg-runtime-current">
        {pi?.current ? (
          <>
            <div>
              当前生效：<code>{pi.current.path}</code>
            </div>
            <div className="pg-fg-dim">
              版本 {pi.current.version} · 来源 {pi.current.source} · 经 {pi.current.via}
            </div>
            {pi.current.fromEnv && (
              <div className="pg-runtime-warn">
                被环境变量 <code>PI_BIN</code> 覆盖——界面上的选择当前不生效。
              </div>
            )}
          </>
        ) : (
          <div className="pg-runtime-warn">当前没有可用的 pi 二进制；新建会话会失败。</div>
        )}
      </div>

      <div className="pg-settings-row">
        <span className="pg-settings-label">新会话默认权限</span>
        <div className="pg-runtime-modes">
          {permModes.map((m) => (
            <button
              key={m.id}
              className={`pg-btn${perm === m.id ? ' pg-btn-primary' : ''}`}
              disabled={busy}
              title={m.tools ? `工具：${m.tools}` : '不限制工具'}
              onClick={() => void save({ permissionMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pg-settings-row">
        <span className="pg-settings-label">并发会话上限</span>
        <Input
          type="number"
          style={{ width: 90 }}
          value={perf.max_workers}
          onChange={(e) => setPerf((p) => ({ ...p, max_workers: Number(e.target.value) || 1 }))}
          onBlur={() => void save({ perf })}
        />
        <span className="pg-settings-label">空闲回收（分钟，0 = 不回收）</span>
        <Input
          type="number"
          style={{ width: 90 }}
          value={perf.idle_timeout_min}
          onChange={(e) => setPerf((p) => ({ ...p, idle_timeout_min: Number(e.target.value) || 0 }))}
          onBlur={() => void save({ perf })}
        />
      </div>

      <p className="pg-fg-dim pg-settings-note">
        切换 pi 二进制或权限档位只影响<strong>新建 / 重启</strong>的会话；已在运行的会话继续用启动时的设置。
      </p>
    </div>
  );
}

/* ---------------- Provider 认证（auth.json） ---------------- */

interface AuthEntry {
  provider: string;
  kind: string;
  masked: string | null;
}

function AuthSection() {
  const [list, setList] = useState<AuthEntry[]>([]);
  const [adding, setAdding] = useState<{ provider: string; key: string } | null>(null);

  const reload = useCallback(() => {
    void cmd<{ providers: AuthEntry[] }>('auth_list')
      .then((r) => setList(r.providers ?? []))
      .catch((e) => toast.error(String(e)));
  }, []);

  useEffect(reload, [reload]);

  const save = async () => {
    if (!adding || !adding.provider.trim() || !adding.key.trim()) return;
    try {
      await cmd('auth_set_key', { provider: adding.provider.trim(), apiKey: adding.key.trim() });
      toast.success(`已保存 ${adding.provider}`);
      setAdding(null);
      reload();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div>
      <div className="pg-settings-row">
        <Button
          type="primary"
          onClick={() => setAdding({ provider: '', key: '' })}
        >
          + 设置 API Key
        </Button>
        <span className="pg-fg-dim">OAuth 订阅（Claude/ChatGPT 等）请用终端 `pi` 登录，GUI 自动识别。</span>
      </div>
      <List
        size="small"
        dataSource={list}
        locale={{ emptyText: '尚无凭据' }}
        renderItem={(e) => (
          <List.Item
            actions={[
              <Popconfirm
                key="del"
                title={`删除 ${e.provider} 的凭据（= logout）？`}
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={async () => {
                  await cmd('auth_remove', { provider: e.provider });
                  reload();
                }}
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={<code>{e.provider}</code>}
              description={`${e.kind} · ${e.masked ?? '(空)'}`}
            />
          </List.Item>
        )}
      />
      <Modal
        open={!!adding}
        title="设置 API Key"
        okText="保存"
        cancelText="取消"
        onOk={() => void save()}
        onCancel={() => setAdding(null)}
        destroyOnHidden
      >
        <Input
          placeholder="provider id（如 anthropic / openai / mock-glm）"
          value={adding?.provider ?? ''}
          onChange={(e) => setAdding((s) => (s ? { ...s, provider: e.target.value } : s))}
          style={{ marginBottom: 8 }}
        />
        <Input.Password
          placeholder="API Key（写入 ~/.pi/agent/auth.json，仅此一处）"
          value={adding?.key ?? ''}
          onChange={(e) => setAdding((s) => (s ? { ...s, key: e.target.value } : s))}
        />
      </Modal>
    </div>
  );
}

/* ---------------- 自定义模型（models.json） ---------------- */

function ModelsSection() {
  const [text, setText] = useState('{}');
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(() => {
    void cmd<Record<string, unknown>>('models_read')
      .then((v) => {
        setText(JSON.stringify(v, null, 2));
        setDirty(false);
      })
      .catch((e) => toast.error(String(e)));
  }, []);

  useEffect(reload, [reload]);

  const save = async () => {
    try {
      const v = JSON.parse(text);
      await cmd('models_write', { value: v });
      toast.success('models.json 已保存');
      setDirty(false);
    } catch (e) {
      toast.error(`JSON 无效: ${e}`);
    }
  };

  return (
    <div className="pg-settings-editor">
      <div className="pg-settings-row">
        <Button type="primary" disabled={!dirty} onClick={() => void save()}>
          保存 models.json
        </Button>
        <Button onClick={reload}>放弃更改</Button>
        <span className="pg-fg-dim">Ollama / vLLM / 中转站等自定义 provider（schema 校验 = M2）</span>
      </div>
      <div className="pg-settings-mono">
        <MonacoHost
          value={text}
          language="json"
          height="420px"
          onChange={(v) => {
            setText(v);
            setDirty(true);
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- pi 设置（settings.json） ---------------- */

function SettingsSection() {
  const [text, setText] = useState('{}');
  const [dirty, setDirty] = useState(false);
  const [sessionDir, setSessionDir] = useState<{ dir: string; isCustom: boolean; raw: string | null } | null>(null);
  const [dirInput, setDirInput] = useState('');

  const reload = useCallback(() => {
    void cmd<Record<string, unknown>>('settings_read')
      .then((v) => {
        setText(JSON.stringify(v, null, 2));
        setDirty(false);
      })
      .catch((e) => toast.error(String(e)));
    void cmd<{ dir: string; isCustom: boolean; raw: string | null }>('session_dir_effective')
      .then((v) => {
        setSessionDir(v);
        setDirInput(v.raw ?? '');
      })
      .catch(() => {});
  }, []);

  useEffect(reload, [reload]);

  const saveRaw = async () => {
    try {
      const v = JSON.parse(text);
      await cmd('settings_write', { value: v });
      toast.success('settings.json 已保存');
      setDirty(false);
    } catch (e) {
      toast.error(`JSON 无效: ${e}`);
    }
  };

  const applySessionDir = async () => {
    try {
      const v = JSON.parse(text);
      const trimmed = dirInput.trim();
      if (trimmed) v.sessionDir = trimmed;
      else delete v.sessionDir;
      await cmd('settings_write', { value: v });
      setText(JSON.stringify(v, null, 2));
      setDirty(false);
      toast.success('会话目录已更新（新会话生效）');
      void cmd<{ dir: string; isCustom: boolean; raw: string | null }>('session_dir_effective')
        .then((v2) => {
          setSessionDir(v2);
          setDirInput(v2.raw ?? '');
        })
        .catch(() => {});
    } catch (e) {
      toast.error(`保存失败: ${e}`);
    }
  };

  return (
    <div className="pg-settings-editor">
      <div className="pg-settings-row">
        <span className="pg-settings-label">基础会话目录</span>
        <Input
          style={{ maxWidth: 420 }}
          placeholder="默认 ~/.pi/agent/sessions（支持绝对路径与 ~）"
          value={dirInput}
          onChange={(e) => setDirInput(e.target.value)}
          onPressEnter={() => void applySessionDir()}
        />
        <Button onClick={() => void applySessionDir()}>应用</Button>
        {sessionDir && (
          <span className="pg-fg-dim">
            当前生效：{sessionDir.dir}
            {sessionDir.isCustom ? '（自定义）' : '（默认）'}
          </span>
        )}
      </div>
      <div className="pg-settings-row">
        <Button type="primary" disabled={!dirty} onClick={() => void saveRaw()}>
          保存 settings.json
        </Button>
        <Button onClick={reload}>放弃更改</Button>
        <span className="pg-fg-dim">已有会话不会移动，新会话写入新目录</span>
      </div>
      <div className="pg-settings-mono">
        <MonacoHost
          value={text}
          language="json"
          height="380px"
          onChange={(v) => {
            setText(v);
            setDirty(true);
          }}
        />
      </div>
    </div>
  );
}
