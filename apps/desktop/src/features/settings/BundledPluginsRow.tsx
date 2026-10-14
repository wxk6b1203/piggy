/**
 * 随包带的 pi 插件（docs/06 §7）：列表 + 开关。
 *
 * 这一块要回答用户三个问题，缺一个都会变成"说不清为什么没生效"：
 *   1. Piggy 到底带了什么？（名字 / 说明 / 它提供哪些工具与命令 / 许可证）
 *   2. 这次注入了吗？（`inject`）
 *   3. 没注入是**为什么**？（设置里关了 / 你自己装过同名扩展 —— 后者如果硬注入，
 *      pi 会因为工具名冲突**直接不进会话**，所以 Piggy 主动跳过）
 */
import { useCallback, useEffect, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { abbreviatePath } from '@/lib/paths';
import { Icon } from '@/features/common/Icon';
import { useTabs } from '@/stores/tabs';

/** pi 的内置工具名：插件申报了这些名字就说明它是**覆盖型**（顶替内置实现）。 */
const OVERRIDE_TOOLS = ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'];

interface BundledPlugin {
  name: string;
  title: string;
  description: string;
  license: string;
  tools: string[];
  commands: string[];
  /** 目录（`null` = 这一份安装里没有它：打包漏登记 `bundle.resources`，或用户删了） */
  dir: string | null;
  /** "随包分发" / "开发态（仓库源码树）"；缺失时为 null */
  origin: string | null;
  /** `source_tree` 是**开发态**：打包产物里出现它就说明资源清单漏登记了 */
  originKind: 'resource_dir' | 'resource_dir_flat' | 'source_tree' | null;
  /** 配置里开着吗（勾选框跟它走） */
  enabled: boolean;
  /** 这次真的注入了吗（可能与 `enabled` 不一致：用户自己装过同名扩展时会被跳过） */
  inject: boolean;
  skipped: string | null;
}

export function BundledPluginsRow({ onChanged }: { onChanged: () => void }) {
  const [plugins, setPlugins] = useState<BundledPlugin[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** 刚复制过哪个插件的目录（1 秒后自己消失，做法同 `DiffBlock`）。 */
  const [copied, setCopied] = useState<string | null>(null);
  /* 当前会话的工作目录：项目级 `<cwd>/.pi/extensions` 里的同名扩展同样会让 pi 直接退出，
     所以"这次会不会注入"必须**按这个 cwd** 算 —— 不传的话界面上说"会注入"、
     真实 spawn 时却被跳过，用户只会以为 Piggy 在骗他。 */
  const projectDir = useTabs((s) => (s.activeTabId ? (s.tabs[s.activeTabId]?.cwd ?? null) : null));

  const load = useCallback(() => {
    void cmd<{ plugins: BundledPlugin[] }>('plugin_bundled', { projectDir })
      .then((r) => setPlugins(r.plugins ?? []))
      .catch((e) => {
        setPlugins([]);
        toast.error(`读取内置插件失败：${String(e)}`);
      });
  }, [projectDir]);
  useEffect(load, [load]);

  /**
   * 复制某个插件的目录（等宽路径手抄不现实）。
   *
   * 复制的是**完整路径**，不是上面显示的那个掐过的 —— 否则粘出来的东西不能用。
   * 失败要**说出来**（剪贴板被拒 / 非安全上下文）：照着"已复制"去粘贴却发现是空的，
   * 比没有这个按钮更糟。做法与 `features/dialogs/AboutDialog.tsx` 一致。
   */
  const copyDir = useCallback(async (p: BundledPlugin): Promise<void> => {
    if (p.dir === null) return;
    try {
      await navigator.clipboard.writeText(p.dir);
      setCopied(p.name);
      window.setTimeout(() => setCopied((cur) => (cur === p.name ? null : cur)), 1000);
    } catch (e) {
      toast.error(`复制失败：${String(e)}`);
    }
  }, []);

  const toggle = async (p: BundledPlugin, on: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // 按**配置**算（不是按"这次注入了吗"）：跳过是运行时判断，不该被写进配置
      const enabled = (plugins ?? []).filter((x) => (x.name === p.name ? on : x.enabled)).map((x) => x.name);
      await cmd('perf_config_save', { bundledPlugins: enabled });
      toast.success('已保存（对新建会话生效）');
      load();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (plugins === null) return null;
  if (plugins.length === 0) {
    return (
      <div className="pg-settings-row">
        <span className="pg-settings-label">内置插件</span>
        <span className="pg-fg-dim">这一份安装里没有捆绑插件。</span>
      </div>
    );
  }

  return (
    <div className="pg-settings-row" data-bundled-plugins>
      <span className="pg-settings-label">内置插件</span>
      <div className="pg-bundled-list">
        {plugins.map((p) => (
          <div
            className="pg-bundled"
            key={p.name}
            data-bundled={p.name}
            data-enabled={p.enabled ? '' : undefined}
            data-inject={p.inject ? '' : undefined}
          >
            <label className="pg-bundled-head">
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={busy}
                data-bundled-toggle={p.name}
                onChange={(e) => void toggle(p, e.target.checked)}
              />
              <span className="pg-bundled-title">{p.title}</span>
              <span className="pg-bundled-name">{p.name}</span>
              <span className="pg-bundled-license">{p.license}</span>
            </label>
            <span className="pg-bundled-desc">{p.description}</span>
            <span className="pg-bundled-meta">
              {p.tools.length > 0 ? `工具：${p.tools.join('、')}` : '不注册工具'}
              {p.commands.length > 0 ? ` · 命令：/${p.commands.join('、/')}` : ''}
            </span>
            {/* 覆盖型插件（清单里 `allowlist:false`）：它注册的是 pi 的内置同名工具。
                必须说出来 —— 用户会问"为什么我的 write 行为变了"，
                以及"为什么限制档里没有它"。 */}
            {OVERRIDE_TOOLS.some((t) => p.tools.includes(t)) ? (
              <span className="pg-bundled-override" data-bundled-override>
                <Icon name="info" size={12} /> 它会**顶替** pi 的内置{' '}
                {p.tools.filter((t) => OVERRIDE_TOOLS.includes(t)).join(' / ')} 工具（行为变化型）；
                它的工具名不进限制档位的白名单，所以「仅可查看」档仍然是只读的
              </span>
            ) : null}
            {p.skipped !== null ? (
              <span className="pg-bundled-skip" data-bundled-skip>
                <Icon name="info" size={12} /> 这次没有注入：{p.skipped}
              </span>
            ) : null}
            {/* 开发态来源必须说出来：第三个候选是**编译期烧进二进制的构建机绝对路径**，
                于是"打包漏登记"在构建机上跑那个 .app 会看起来完全正常（换机器才消失）。 */}
            {p.originKind === 'source_tree' ? (
              <span className="pg-bundled-origin" data-bundled-origin="source_tree">
                <Icon name="alert" size={12} /> 来自仓库源码树（开发态）：打包产物里不该出现它，
                出现即说明资源清单漏登记了
              </span>
            ) : null}
            {/* 目录：超长的**掐中间**（`/a/…/pi-todo`），不是尾巴省略号 ——
                尾巴省略留下的正好是最没信息量的前缀，而"是哪个目录"在末尾。
                完整路径仍在 title 上，悬停可看。见 `lib/paths.ts::abbreviatePath`。
                旁边跟一个复制图标（复制的是**完整**路径，不是掐过的显示值）。 */}
            <span className="pg-bundled-dir">
              <span className="pg-bundled-dir-text" title={p.dir ?? undefined}>
                {p.dir === null ? '（这一份安装里没有这个目录）' : abbreviatePath(p.dir)}
              </span>
              {p.dir !== null ? (
                <button
                  type="button"
                  className="pg-bundled-copy"
                  data-bundled-copy={p.name}
                  aria-label={`复制 ${p.title} 的目录`}
                  title="复制完整路径"
                  onClick={() => void copyDir(p)}
                >
                  <Icon name="copy" size={12} />
                </button>
              ) : null}
              {copied === p.name ? (
                <span className="pg-bundled-copied" data-bundled-copied>
                  已复制
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <span className="pg-fg-dim">
        这些插件随 Piggy 分发、用 <code>pi --extension</code> 注入（不需要 npm）。
        改开关后「新建会话」生效；已在跑的会话要重启标签页。
      </span>
    </div>
  );
}
