/**
 * 设置 tab（WP5，docs/09 §3.1）：Provider 凭据 / 自定义模型 / pi 设置。
 * 三文件（auth/models/settings）表单化 + Monaco 原始 JSON 编辑，原子写 + .bak（Rust pi_files）。
 * 注意：已运行 worker 持有旧配置，改动对新会话生效（UI 明示）。
 */
import { useCallback, useEffect, useState } from 'react';
import { message as antdMessage, Modal, Input, Button, List, Popconfirm } from 'antd';
import { cmd } from '@/lib/ipc';
import { MonacoHost } from '@/features/common/MonacoHost';

type Tab = 'auth' | 'models' | 'settings';

export function SettingsTab() {
  const [tab, setTab] = useState<Tab>('auth');
  return (
    <div className="pg-settings">
      <div className="pg-settings-tabs">
        {([['auth', 'Provider 认证'], ['models', '自定义模型'], ['settings', 'pi 设置']] as const).map(
          ([k, label]) => (
            <button key={k} className={`pg-btn${tab === k ? ' pg-btn-primary' : ''}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ),
        )}
      </div>
      {tab === 'auth' && <AuthSection />}
      {tab === 'models' && <ModelsSection />}
      {tab === 'settings' && <SettingsSection />}
      <p className="pg-fg-dim pg-settings-note">改动写入 pi 标准配置文件（原子写 + .bak 备份）；对新建会话生效。</p>
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
      .catch((e) => antdMessage.error(String(e)));
  }, []);

  useEffect(reload, [reload]);

  const save = async () => {
    if (!adding || !adding.provider.trim() || !adding.key.trim()) return;
    try {
      await cmd('auth_set_key', { provider: adding.provider.trim(), apiKey: adding.key.trim() });
      antdMessage.success(`已保存 ${adding.provider}`);
      setAdding(null);
      reload();
    } catch (e) {
      antdMessage.error(String(e));
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
      .catch((e) => antdMessage.error(String(e)));
  }, []);

  useEffect(reload, [reload]);

  const save = async () => {
    try {
      const v = JSON.parse(text);
      await cmd('models_write', { value: v });
      antdMessage.success('models.json 已保存');
      setDirty(false);
    } catch (e) {
      antdMessage.error(`JSON 无效: ${e}`);
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
      .catch((e) => antdMessage.error(String(e)));
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
      antdMessage.success('settings.json 已保存');
      setDirty(false);
    } catch (e) {
      antdMessage.error(`JSON 无效: ${e}`);
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
      antdMessage.success('会话目录已更新（新会话生效）');
      void cmd<{ dir: string; isCustom: boolean; raw: string | null }>('session_dir_effective')
        .then((v2) => {
          setSessionDir(v2);
          setDirInput(v2.raw ?? '');
        })
        .catch(() => {});
    } catch (e) {
      antdMessage.error(`保存失败: ${e}`);
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
