/**
 * Monaco 基座（WP4，docs/10 §2）：懒加载 + 本地 workers + 主题注册 + 实例纪律。
 * 本模块只在首个 Monaco 挂载点被 import（保持空载 0 成本，05 §5.5）。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
// JSON 语言贡献 + workers（M1 范围：JSON 编辑/预览；其余语言 M2 按需加）
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';

// Workers 经 Vite ?worker 打包（同源 URL）；docs/10 §2.2
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};

// 主题：与 --pg-* token 对齐（正式管线 M1 由 VS Code 主题 JSON 生成，10 §2.4）
monaco.editor.defineTheme('piggy-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1f22',
    'editor.foreground': '#dfe1e5',
    'editorLineNumber.foreground': '#9da0a8',
    'editorLineNumber.activeForeground': '#dfe1e5',
    'editor.selectionBackground': '#2f3946',
    'editor.lineHighlightBackground': '#2b2d30',
  },
});
monaco.editor.defineTheme('piggy-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#24292f',
    'editorLineNumber.foreground': '#6e7781',
    'editor.selectionBackground': '#ddf4ff',
    'editor.lineHighlightBackground': '#f6f7f8',
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

export { monaco };
