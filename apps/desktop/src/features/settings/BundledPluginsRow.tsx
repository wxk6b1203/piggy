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

interface BundledPlugin {
  name: string;
  title: string;
  description: string;
  license: string;
  tools: string[];
  commands: string[];
  dir: string;
  /** 配置里开着吗（勾选框跟它走） */
  enabled: boolean;
  /** 这次真的注入了吗（可能与 `enabled` 不一致：用户自己装过同名扩展时会被跳过） */
  inject: boolean;
  skipped: string | null;
}

export function BundledPluginsRow({ onChanged }: { onChanged: () => void }) {
  const [plugins, setPlugins] = useState<BundledPlugin[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void cmd<{ plugins: BundledPlugin[] }>('plugin_bundled')
      .then((r) => setPlugins(r.plugins ?? []))
      .catch((e) => {
        setPlugins([]);
        toast.error(`读取内置插件失败：${String(e)}`);
      });
  }, []);
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
            <span className="pg-bundled-dir" title={p.dir}>
              {p.dir}
            </span>
          </div>
        ))}
      </div>
      <span className="pg-fg-dim">
        这些插件随 Piggy 分发、用 <code>pi --extension</code> 注入（不需要 npm）。
        改开关后**新建会话**生效；已在跑的会话要重启标签页。
      </span>
    </div>
  );
}
