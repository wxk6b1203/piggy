/**
 * Monaco 基座（WP4，docs/10 §2）：懒加载 + 本地 workers + 主题注册 + 实例纪律。
 * 本模块只在首个 Monaco 挂载点被 import（保持空载 0 成本，05 §5.5）。
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import { VSCODE_THEME_RULES } from './vscode-theme-tokens';
import { LANG_LOADERS } from './monaco-langs';
// JSON 语言贡献 + workers（JSON 走带 worker 的语言服务，schema 校验见 §3.3；
// 其余语言的**词法定义**按需加载，见下方 ensureLanguage 与 monaco-langs.ts）
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

/**
 * 按需加载一门语言的**词法定义**（一门一个 chunk，纪律见 monaco-langs.ts）。
 *
 * ⚠️ 必须在 `createModel` **之前** await 完。未注册的 language id 会被
 * `LanguageService._createAndGetLanguageIdentifier` **静默降级成 plaintext**
 * （源码原话：`Fall back to plain text if language is unknown`）——
 * 界面上就是"语言条写着 go、正文一片白"，而且不报任何错。
 * 事后补救是**能**救回来的（此时模型 id 已经是 `plaintext`、不等于目标 id，
 * 不会撞上 `TokenizationTextModelPart.setLanguageId` 那句
 * `if (this._languageId === languageId) return`）—— 但那是"先错后改"：
 * 白跑一次 tokenize，还得把"什么时候算好了"再接出来。不如先 await 干净。
 *
 * 失败（chunk 404 / 语法模块坏）时**不吞**：`console.warn` 留痕并让调用方继续以纯文本渲染。
 * 缓存按语言 id 去重；失败则逐出，让"重新加载"按钮能再试一次。
 */
const langPromises = new Map<string, Promise<void>>();
export function ensureLanguage(langId: string): Promise<void> {
  const load = LANG_LOADERS[langId];
  if (!load) return Promise.resolve(); // plaintext / json（已静态注册）/ 未收录 → 纯文本
  let p = langPromises.get(langId);
  if (!p) {
    p = Promise.resolve(load()).then(
      () => undefined,
      (e: unknown) => {
        langPromises.delete(langId);
        console.warn(`[monaco] 语言定义加载失败：${langId}`, e);
        throw e;
      },
    );
    langPromises.set(langId, p);
  }
  return p;
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
