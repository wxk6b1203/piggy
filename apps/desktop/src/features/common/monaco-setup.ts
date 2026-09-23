/**
 * Monaco 基座（WP4，docs/10 §2）：懒加载 + 本地 workers + 主题注册 + 实例纪律。
 * 本模块只在首个 Monaco 挂载点被 import（保持空载 0 成本，05 §5.5）。
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import { VSCODE_THEME_RULES } from './vscode-theme-tokens';
// JSON 语言贡献 + workers（M1 范围：JSON 编辑/预览；其余语言 M2 按需加）
import 'monaco-editor/language/json/monaco.contribution';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

// Workers 经 Vite ?worker 打包（同源 URL）；docs/10 §2.2
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};

// 主题 = 两层：
//   ① 外壳（background/foreground/行号/光标…）取 DSH 令牌值（docs/12 §2.3），与 styles/tokens.css 同源；
//      Monaco 的 defineTheme 只吃字面色值、读不到 CSS 变量，所以这里是**手工镜像**，改 tokens 时必须同步。
//   ② 语法着色（rules）直接复用 **VS Code 内置主题的 tokenColors**（Dark/Light Modern，
//      由 scripts/sync-vscode-themes.mjs 生成），这样标识符/字符串/注释的配色与 VS Code 一致，
//      而不是停留在 Monaco 的 vs-dark 底座默认值。
// 注：`inherit: true` 让未命中的 scope 继续回落到 vs-dark / vs 底座。
monaco.editor.defineTheme('piggy-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [...VSCODE_THEME_RULES['vscode-dark-modern']],
  colors: {
    'editor.background': '#151517', // alias-bg-base
    'editor.foreground': '#f9fafb', // alias-label-primary
    'editorLineNumber.foreground': '#6f7276', // label-caption 压暗，避免行号抢视线
    'editorLineNumber.activeForeground': '#adb2b8', // alias-label-tertiary
    'editor.selectionBackground': '#34415b', // state-business-tertiary
    'editor.lineHighlightBackground': '#232324', // alias-bg-layer-1
    'editorCursor.foreground': '#7aaaff', // state-business-primary
    'editorIndentGuide.background1': '#ffffff0f',
    'editorWidget.background': '#232324',
    'editorWidget.border': '#ffffff1f',
  },
});
monaco.editor.defineTheme('piggy-light', {
  base: 'vs',
  inherit: true,
  rules: [...VSCODE_THEME_RULES['vscode-light-modern']],
  colors: {
    'editor.background': '#ffffff', // alias-bg-base
    'editor.foreground': '#0f1115', // alias-label-primary
    'editorLineNumber.foreground': '#adb2b8',
    'editorLineNumber.activeForeground': '#61666b',
    'editor.selectionBackground': '#dbeafe',
    'editor.lineHighlightBackground': '#f1f3f5', // interactive-bg-hover-solid
    'editorCursor.foreground': '#4176e6',
  },
});

/** 当前主题名（uiStore 变化时由 Host 切换） */
export function currentThemeName(theme: 'dark' | 'light') {
  return theme === 'dark' ? 'piggy-dark' : 'piggy-light';
}

/** JSON Schema 注册入口（WP5：pi settings/models schema，docs/10 §3.3） */
export function setJsonSchemas(schemas: unknown[]) {
  const langs = monaco.languages as unknown as {
    json: { jsonDefaults: { setDiagnosticsOptions(o: unknown): void } };
  };
  langs.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: schemas as never[],
  });
}

/** pi 配置文件 schema（M2 顺延 WP5：settings/models 表单编辑器带校验） */
const PI_SCHEMAS = [
  {
    uri: 'piggy://schemas/pi-settings.json',
    fileMatch: ['pi-settings.json'],
    schema: {
      type: 'object',
      properties: {
        defaultModel: { type: 'string', description: '默认模型 id' },
        defaultProvider: { type: 'string', description: '默认 provider id' },
        defaultThinkingLevel: {
          enum: ['off', 'minimal', 'medium', 'high', 'max'],
          description: '默认 thinking 级别',
        },
        sessionDir: { type: 'string', description: '会话根目录（绝对路径；相对路径随项目 cwd）' },
        theme: { enum: ['dark', 'light'] },
        packages: { type: 'array', items: { type: 'string' }, description: '扩展包列表 npm:<pkg>' },
      },
    },
  },
  {
    uri: 'piggy://schemas/pi-models.json',
    fileMatch: ['pi-models.json'],
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string' },
          api: { type: 'string' },
          apiKey: { type: 'string' },
          models: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
];

export function registerPiggySchemas() {
  setJsonSchemas(PI_SCHEMAS);
}

export { monaco };
