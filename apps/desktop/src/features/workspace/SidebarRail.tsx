/**
 * 折叠态图标轨（DSH `SIDEBAR_COLLAPSED = 56`，docs/12 §1.5/§5.2）。
 *
 * 为什么必须有这条轨：折叠侧栏原先的实现是 `{sidebarOpen && <Panel…>}` —— 折叠之后
 * **什么都不剩**，界面上再没有任何可点的东西能把侧栏叫回来（只剩 ⌘B 与命令面板，
 * 对不知道快捷键的人等于没有）。用户截图就是这个死局：没有打开的标签 + 没有侧栏
 * = 一屏黑，无处可点。
 *
 * DSH 的折叠态是保留一条 56px 竖轨（`SIDEBAR_COLLAPSED = 56` = 24px 图标列 + 左右各 16px），
 * 里面留着品牌标（= 展开开关，hover 时换成面板图标）、新建会话、底部设置 —— 这里照做。
 * 注：DSH 在 macOS 桌面把折叠宽度取 0（完全隐藏），代价是必须靠标题栏里的
 * `HeaderLeadingControls` 才能叫回来（docs/12 §1.5 末条）。Piggy 用的是**系统标题栏**
 * （docs/04 §1：无自绘标题栏），没有那块地皮，所以取"保留竖轨"这一支。
 */
import { Icon } from '@/features/common/Icon';
import { newSessionTab } from '@/lib/appCommands';
import { useUi } from '@/stores/ui';
import { openSettingsTab } from './EditorArea';

export function SidebarRail() {
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  return (
    <div className="pg-rail-left" role="toolbar" aria-label="折叠的侧栏" aria-orientation="vertical">
      {/* 品牌标 = 展开开关：默认显示 logo，hover 换成"展开侧栏"的面板图标（DSH 同款） */}
      <button
        type="button"
        className="pg-rail-toggle"
        title="展开侧栏（⌘B）"
        aria-label="展开侧栏"
        aria-expanded={false}
        onClick={() => setSidebarOpen(true)}
      >
        <span className="pg-rail-logo" aria-hidden="true">
          🐷
        </span>
        <span className="pg-rail-toggle-icon" aria-hidden="true">
          <Icon name="layout-sidebar-left" size={16} />
        </span>
      </button>

      <button
        type="button"
        className="pg-rail-btn"
        title="新建会话（⌘N）"
        aria-label="新建会话"
        onClick={() => void newSessionTab()}
      >
        <Icon name="add" size={16} />
      </button>

      <div className="pg-rail-spacer" />

      <button
        type="button"
        className="pg-rail-btn"
        title="设置（⌘,）"
        aria-label="设置"
        onClick={() => openSettingsTab()}
      >
        <Icon name="settings-gear" size={16} />
      </button>
    </div>
  );
}
