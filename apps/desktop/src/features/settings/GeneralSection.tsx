/**
 * 通用设置（docs/04 §2.2）：会话目录 + Piggy 自身的运行设置。
 *
 * 拆自原 SettingsTab 的「运行」与「pi 设置」两节——它们回答的都是同一个问题
 * "这套 Piggy 用哪个 pi、跑在哪儿、默认多大胆"，分成两页只是历史包袱。
 *
 * 「默认使用系统 pi」是明确的产品要求：安装包虽然捆绑自定义 pi，
 * 但不能劫持用户机器上已有的安装。所以来源默认 system，捆绑只作为显式选项
 * 与"系统没装 pi"时的兜底。这里同时把**实际生效的那个二进制**显示出来——
 * 设置值不等于结果（有回退、也可能被 PI_BIN 覆盖），必须让人看得见。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, Switch } from 'antd';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { loadTitleModels, type ModelOption } from '@/lib/sessionTitle';
import { thinkingOptions } from '@/lib/thinking';

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

export function GeneralSection() {
  const [pi, setPi] = useState<PiSourceState | null>(null);
  const [permModes, setPermModes] = useState<PermissionModeInfo[]>([]);
  const [perm, setPerm] = useState<string>('workspace');
  const [perf, setPerf] = useState({ max_workers: 8, idle_timeout_min: 10 });
  const [delegation, setDelegation] = useState(false);
  const [sessionDir, setSessionDir] = useState<{ dir: string; isCustom: boolean; raw: string | null } | null>(null);
  const [dirInput, setDirInput] = useState('');
  // 标题生成（docs/03 §2.16）
  const [titleCfg, setTitleCfg] = useState<{ maxChars: number; source: string; model: string; thinking: string }>({
    maxChars: 20,
    source: 'both',
    model: '',
    thinking: '',
  });
  // 「标题模型」下拉的数据（`pi --list-models` 的结果，真机 0.6s）
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  // 手动输入模式：列表拉不到时**必须**有这条路，否则用户遇到
  // "pi 没列出来的模型"就再也填不进去了（以前这里是自由输入框）。
  // null = 用户还没表态（由"列表有没有拉到"决定，见下面的 manualModel）
  const [manualModelOverride, setManualModelOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void cmd<PiSourceState>('pi_source_options').then(setPi).catch((e) => toast.error(String(e)));
    void cmd<{ modes: PermissionModeInfo[] }>('permission_modes')
      .then((r) => setPermModes(r.modes ?? []))
      .catch(() => {});
    void cmd<{
      max_workers: number;
      idle_timeout_min: number;
      permission_mode?: string;
      subagent_delegation?: boolean;
      title_max_chars?: number;
      title_source?: string;
      title_model?: string | null;
      title_thinking?: string | null;
    }>('perf_config_load')
      .then((c) => {
        setPerf({ max_workers: c.max_workers, idle_timeout_min: c.idle_timeout_min });
        setDelegation(c.subagent_delegation ?? false);
        if (c.permission_mode) setPerm(c.permission_mode);
        setTitleCfg({
          maxChars: c.title_max_chars ?? 20,
          source: c.title_source ?? 'both',
          model: c.title_model ?? '',
          thinking: c.title_thinking ?? '',
        });
      })
      .catch(() => {});
    // 模型列表：拉不到不是致命错误——退回手动输入，并把原因说出来。
    // **不缓存**：用户可能刚在「模型」页加了个提供商，切回来就该看到它。
    setModelsLoading(true);
    void loadTitleModels()
      .then((r) => {
        setModels(r.models);
        setModelsNote(
          r.models.length === 0
            ? `pi 没有列出任何可用模型${r.note ? `——它说：${r.note}` : ''}。可以直接手动填 provider/modelId。`
            : null,
        );
      })
      .catch((e) => {
        setModels([]);
        setModelsNote(`拉取模型列表失败（${String(e)}）——可以手动填 provider/modelId。`);
      })
      .finally(() => setModelsLoading(false));
    void cmd<{ dir: string; isCustom: boolean; raw: string | null }>('session_dir_effective')
      .then((v) => {
        setSessionDir(v);
        setDirInput(v.raw ?? '');
      })
      .catch(() => {});
  }, []);

  useEffect(reload, [reload]);

  const save = async (patch: {
    piSource?: string;
    piPath?: string;
    permissionMode?: string;
    perf?: typeof perf;
    delegation?: boolean;
    title?: { maxChars: number; source: string; model: string; thinking: string };
  }) => {
    if (busy) return;
    setBusy(true);
    try {
      await cmd('perf_config_save', {
        maxWorkers: patch.perf?.max_workers ?? perf.max_workers,
        idleTimeoutMin: patch.perf?.idle_timeout_min ?? perf.idle_timeout_min,
        piSource: patch.piSource,
        piPath: patch.piPath,
        // 不传 = 保持既有值（后端读-改-写，不会顺手抹掉别的字段）
        subagentDelegation: patch.delegation,
        titleMaxChars: patch.title?.maxChars ?? titleCfg.maxChars,
        titleSource: patch.title?.source ?? titleCfg.source,
        titleModel: patch.title?.model ?? titleCfg.model,
        titleThinking: patch.title?.thinking ?? titleCfg.thinking,
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
      // 必须是「选文件」不是「选目录」：custom 要的是可执行文件本身，
      // 选到文件夹会被后端的 is_file() 拒绝。
      const p = await cmd<string | null>('pick_pi_binary', { start: pi?.customPath ?? null });
      // 用户取消 → 什么都不改（不切到 custom，也不留一个"custom 但没路径"的坏配置）
      if (!p) return;
      await save({ piSource: 'custom', piPath: p });
    } catch (e) {
      toast.error(String(e));
    }
  };

  /** 点来源按钮：custom 必须**先选到路径**再切档，否则会写下一个解析不了的配置。 */
  const pickSource = (id: PiSourceOption['id']) => {
    if (id === 'custom') void pickPath();
    else void save({ piSource: id });
  };

  const applySessionDir = async () => {
    try {
      const v = await cmd<Record<string, unknown>>('settings_read');
      const trimmed = dirInput.trim();
      if (trimmed) v.sessionDir = trimmed;
      else delete v.sessionDir;
      await cmd('settings_write', { value: v });
      toast.success('会话目录已更新（新会话生效）');
      reload();
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 禁用的选项要给出**看得见**的理由，不能只靠 tooltip（鼠标悬停才知道 = 看起来像坏了）
  const disabledReason = pi?.builtinAvailable
    ? null
    : '「捆绑 pi」不可用：当前是 lite SKU，安装包里没有捆绑 pi。用 full SKU 构建后可选。';

  // 「标题模型」下拉：按 provider 分组（与聊天里的模型选择器同一套分组方式），
  // 外加一项"跟会话自己的模型"（值 = 空串，落库就是清掉覆盖）。
  const modelSelectOptions = [
    { value: '', label: '跟会话自己的模型' },
    ...Array.from(new Set((models ?? []).map((m) => m.provider))).map((provider) => ({
      label: provider,
      options: (models ?? [])
        .filter((m) => m.provider === provider)
        .map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: m.reasoning ? m.id : `${m.id}（不支持思考）`,
        })),
    })),
  ];
  const modelsLoaded = models !== null && models.length > 0;
  // 用户没显式选过"手动输入"时：列表拉不到就自动退回输入框
  const manualModel =
    manualModelOverride === null ? models !== null && !modelsLoaded : manualModelOverride;
  // 选中的模型支持不支持思考：只有**明确知道**它不支持时才禁用那个下拉。
  // 留空（= 跟会话自己的模型）时不知道是谁，就不禁用——那时 pi 会按实际模型自己降级。
  const selectedModel = (models ?? []).find((m) => `${m.provider}/${m.id}` === titleCfg.model);
  const thinkingUnsupported = selectedModel ? !selectedModel.reasoning : false;

  return (
    <div className="pg-settings-editor">
      <h2 className="pg-settings-title">通用设置</h2>

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
      <p className="pg-fg-dim pg-settings-note">已有会话不会移动，新会话写入新目录</p>

      {/* 会话标题生成（docs/03 §2.16）：三个设置项各自对应一个真实的选择 */}
      <div className="pg-settings-row" data-title-settings>
        <span className="pg-settings-label">会话标题</span>
        <span className="pg-fg-dim">最多</span>
        <Input
          type="number"
          min={1}
          max={200}
          style={{ width: 84 }}
          value={titleCfg.maxChars}
          onChange={(e) =>
            setTitleCfg((c) => ({ ...c, maxChars: Number(e.target.value) || 1 }))
          }
          onBlur={() => void save({ title: titleCfg })}
          aria-label="标题字数上限"
        />
        <span className="pg-fg-dim">个字符</span>
        <Select
          style={{ width: 200 }}
          value={titleCfg.source}
          onChange={(v) => {
            const next = { ...titleCfg, source: v };
            setTitleCfg(next);
            void save({ title: next });
          }}
          aria-label="标题取材"
          options={[
            { value: 'both', label: '第一条 + 最近几条' },
            { value: 'first', label: '只看第一条消息' },
            { value: 'recent', label: '只看最近几条' },
          ]}
        />
      </div>
      <div className="pg-settings-row">
        <span className="pg-settings-label">标题模型</span>
        {manualModel ? (
          <Input
            className="pg-title-modelinput"
            placeholder="provider/modelId"
            value={titleCfg.model}
            onChange={(e) => setTitleCfg((c) => ({ ...c, model: e.target.value }))}
            onBlur={() => void save({ title: titleCfg })}
            aria-label="标题模型"
          />
        ) : (
          <Select
            className="pg-title-model"
            showSearch
            allowClear
            loading={modelsLoading}
            data-title-model-select
            value={titleCfg.model || undefined}
            placeholder="跟会话自己的模型"
            // 清空（点 ×）= 回到"跟会话自己的模型"，而不是留一个空字符串
            onChange={(v) => {
              const next = { ...titleCfg, model: v ?? '' };
              setTitleCfg(next);
              void save({ title: next });
            }}
            aria-label="标题模型"
            optionFilterProp="label"
            options={modelSelectOptions}
          />
        )}
        <Select
          className="pg-title-thinking"
          allowClear
          data-title-thinking-select
          value={titleCfg.thinking || undefined}
          placeholder="跟模型默认"
          disabled={thinkingUnsupported}
          onChange={(v) => {
            const next = { ...titleCfg, thinking: v ?? '' };
            setTitleCfg(next);
            void save({ title: next });
          }}
          aria-label="标题思考强度"
          options={thinkingOptions()}
        />
        {modelsLoaded && (
          <Button
            className="pg-title-manual"
            type="link"
            size="small"
            onClick={() => setManualModelOverride(!manualModel)}
          >
            {manualModel ? '从列表里选' : '手动输入'}
          </Button>
        )}
      </div>
      {titleCfg.model && (
        <p className="pg-fg-dim pg-settings-note">
          标题会用 <code>{titleCfg.model}</code> 生成；清空 = 用该会话最后一次用过的模型。
          思考强度留空 = 不传 <code>--thinking</code>，用 pi 与模型自己的默认档。
        </p>
      )}
      {/* 「列表为什么是空的 / 为什么没有下拉」必须说出来：pi 的原话通常就在 note 里
          （没配密钥、或它换了表格格式），比"没有可用模型"这种话有用得多。
          **不能只在有下拉时显示**——恰恰是自动退回手动输入的时候，
          用户最需要知道"列表去哪了"。 */}
      {modelsNote && (
        <p className="pg-runtime-note" data-title-models-note>
          {modelsNote}
        </p>
      )}
      {thinkingUnsupported && (
        <p className="pg-runtime-note" data-title-thinking-note>
          <code>{titleCfg.model}</code> 没有声明推理能力，pi 只认「关闭」——
          所以这里的档位不可选（会话里的选择器对它会显示同一件事）。
        </p>
      )}
      {/* 选了档位之后的**真话**：pi 会在请求时按模型能力收敛档位，界面看不到结果。
          实测（本地假模型 + 抓请求体）：没声明的模型里「极高/最大」都变成 high，
          而声明了 `low: null` 的模型请求 low 会被**升**成 medium。
          不说这一句，用户会以为选了就一定按选的走——那是本项目最忌讳的静默失效。 */}
      {titleCfg.thinking && !thinkingUnsupported && (
        <p className="pg-fg-dim pg-settings-note" data-title-thinking-clamp>
          档位由 pi 在发请求时按**模型自己声明的能力**收敛：模型没声明的档位会被换成它支持的
          那一档（实测：未声明的模型里「极高 / 最大」都会发成 <code>high</code>），
          而这一步的结果界面上看不到。
        </p>
      )}
      <p className="pg-fg-dim pg-settings-note">
        生成时会新起一个一次性 pi 进程（<code>--no-session</code>），所以这段对话不会进会话转录。
        入口：会话行右键菜单、行上的 ✎ 图标、命令面板的「生成会话标题」。
      </p>

      <div className="pg-settings-row">
        <span className="pg-settings-label">pi 可执行文件</span>
        <div className="pg-runtime-modes">
          {(pi?.options ?? []).map((o) => (
            <button
              key={o.id}
              type="button"
              className={`pg-btn${pi?.source === o.id ? ' pg-btn-primary' : ''}`}
              disabled={!o.available || busy}
              title={o.available ? undefined : '当前是 lite SKU（未捆绑 pi）'}
              onClick={() => pickSource(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {disabledReason && <p className="pg-runtime-note">{disabledReason}</p>}

      {pi?.source === 'custom' && (
        <div className="pg-settings-row">
          <span className="pg-settings-label">自定义路径</span>
          <Input
            value={pi.customPath ?? ''}
            placeholder="/path/to/pi"
            onChange={(e) => setPi((s) => (s ? { ...s, customPath: e.target.value } : s))}
            // 清空输入框不该把空路径写回去（那会得到一个解析不了的 custom 配置）。
            // 后端也会拦，但这里直接不发请求，用户不会看到一个莫名其妙的报错。
            onBlur={() => {
              const v = (pi.customPath ?? '').trim();
              if (v) void save({ piSource: 'custom', piPath: v });
            }}
          />
          <Button onClick={() => void pickPath()}>选择文件…</Button>
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

      <div className="pg-settings-row">
        <span className="pg-settings-label">子代理委派</span>
        <Switch
          checked={delegation}
          disabled={busy || perm !== 'full'}
          onChange={(v) => {
            setDelegation(v);
            void save({ delegation: v });
          }}
        />
        <span className="pg-fg-dim">
          开启后 pi 会主动把可独立完成的工作交给子代理（侦察 / 独立复核 / 并行调研）。
        </span>
      </div>
      {/* 不能工作的情况必须**说出原因**：开关打开却毫无变化，用户只会以为功能坏了。
          这类"静默失效"是本项目最忌讳的失败方式。 */}
      {perm !== 'full' ? (
        <p className="pg-fg-dim pg-settings-note">
          当前默认档位是「{permModes.find((m) => m.id === perm)?.label ?? perm}」，
          <strong>子代理委派在该档位不可用</strong>：限制档位的 <code>--tools</code> 白名单会把扩展工具
          整个过滤掉，pi 进程里根本没有 <code>subagent</code> 这个工具（真机验证过）。
          请先把默认档位切到「完全权限」。
        </p>
      ) : delegation ? (
        <p className="pg-fg-dim pg-settings-note">
          已开启：新会话会往系统提示词追加一段委派策略，并自动激活 <code>subagent</code> 工具
          （否则模型得先自己调一次 <code>subagents_enable</code>——实测那正是"pi 几乎不用子代理"的直接原因）。
          策略只授权可独立完成、可验证的工作；需要来回澄清的、一两处小改动仍要求它自己做。
        </p>
      ) : null}

      <p className="pg-fg-dim pg-settings-note">
        切换 pi 二进制或权限档位只影响<strong>新建 / 重启</strong>的会话；已在运行的会话继续用启动时的设置。
      </p>
    </div>
  );
}
