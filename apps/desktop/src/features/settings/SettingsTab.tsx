/**
 * 设置（WP5，docs/09 §3.1；配置页版式对齐 DSH 设置弹窗的左导航，docs/04 §2.2）。
 *
 * 三节：
 *   · **模型** —— 提供商/密钥/模型目录（`ProvidersSection`），pi 文件的表单化；
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

type Section = 'models' | 'general' | 'advanced';

export function SettingsTab() {
  const [section, setSection] = useState<Section>('models');
  return (
    <div className="pg-settings">
      <nav className="pg-settings-nav" aria-label="设置分类">
        {(
          [
            ['models', '模型'],
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
        {section === 'general' && <GeneralSection />}
        {section === 'advanced' && <AdvancedSection />}
      </div>
    </div>
  );
}
