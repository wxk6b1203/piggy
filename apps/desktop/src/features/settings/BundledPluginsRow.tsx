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
import { Icon } from '@/features/common/Icon';
import { useTabs } from '@/stores/tabs';

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
            <span className="pg-bundled-dir" title={p.dir ?? undefined}>
              {p.dir ?? '（这一份安装里没有这个目录）'}
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
