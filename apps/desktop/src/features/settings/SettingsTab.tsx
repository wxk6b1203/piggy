/** 设置 tab（WP5 填充；本版先立骨架与"打开 JSON"入口） */
export function SettingsTab() {
  return (
    <div className="pg-settings">
      <h2>设置</h2>
      <p className="pg-fg-dim">
        Provider / 自定义模型 / pi settings 的表单化编辑在 WP5 交付
        （docs/09 §3.1 WP5；底层 config/ 模块与 schema 校验就绪后接入）。
      </p>
      <ul className="pg-fg-dim">
        <li>Provider 认证（auth.json，脱敏读写）</li>
        <li>自定义模型（models.json 表单）</li>
        <li>pi 设置（settings.json 表单 + JSON 编辑器）</li>
        <li>Piggy 应用设置（外观 / 键位 / 资源上限）</li>
      </ul>
    </div>
  );
}
