/**
 * 设置（WP5，docs/09 §3.1；配置页版式对齐 DSH 设置弹窗的左导航，docs/04 §2.2）。
 *
 * 四节：
 *   · **模型** —— 提供商/密钥/模型目录（`ProvidersSection`），pi 文件的表单化；
 *   · **插件** —— pi 的扩展：安装/删除/升级/启停 + 各来源与"谁说了算"（`PluginsSection`）；
 *   · **通用设置** —— 会话目录 + pi 二进制 + 权限/并发/委派（`GeneralSection`）；
 *   · **高级** —— models.json / settings.json 的原始 JSON 编辑器（`AdvancedSection`）。
 *
 * 左导航而不是顶部胶囊：DSH 的设置就是左侧竖排导航（截图与
 * `ui-settings/src/client/*` 一致），而且这一页的条目会继续长（插件、Agent 预设…），
 * 横排很快就挤成一团。
 *
 * 注意：写的是 pi 的标准配置文件（原子写 + .bak）；已运行的 worker 持有旧配置，
 * 改动对**新建会话**生效（界面明示）。
 */
import { useState } from 'react';
import { ProvidersSection } from './ProvidersSection';
import { GeneralSection } from './GeneralSection';
import { AdvancedSection } from './AdvancedSection';
import { PluginsSection } from './PluginsSection';

type Section = 'models' | 'plugins' | 'general' | 'advanced';

export function SettingsTab() {
  const [section, setSection] = useState<Section>('models');
  return (
    <div className="pg-settings">
      <nav className="pg-settings-nav" aria-label="设置分类">
        {(
          [
            ['models', '模型'],
            ['plugins', '插件'],
            ['general', '通用设置'],
            ['advanced', '高级'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`pg-settings-navitem${section === key ? ' is-active' : ''}`}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="pg-settings-pane">
        {section === 'models' && <ProvidersSection />}
        {section === 'plugins' && <PluginsSection />}
        {section === 'general' && <GeneralSection />}
        {section === 'advanced' && <AdvancedSection />}
      </div>
    </div>
  );
}
