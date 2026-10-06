// Piggy 质量门（docs/08 §4）：自定义红线规则。
//
// ⚠️ 这份配置在 2026-09-25 之前**从来没有被任何脚本或 CI 调用过**（`pnpm lint` 是空转：
// 根 package.json 有 `lint: pnpm -r --if-present lint`，但没有一个子包定义 `lint`），
// 于是 docs/08 §4 那四条"PR 阻断红线"一条都没在跑，而 `eslint-disable-next-line
// react-hooks/exhaustive-deps` 这种注释还会因为**规则根本没装**而报
// `Definition for rule ... was not found`。现在：`apps/desktop` 有 `lint` 脚本、
// CI 的 frontend 作业跑 `pnpm -r --if-present lint`。
//
// 三条纪律（都是踩过的坑）：
//   ① flat config 里**同一条规则后块整体覆盖前块**，不是合并 patterns ——
//      所以"chat 子树的 antd 禁令"与"其余文件的 Monaco 禁令"必须用 ignores 划清边界；
//   ② `src-tauri/resources/**` 是**构建产物**（piggy-bridge.js 由 esbuild 生成），
//      不在 ignores 里就会贡献十几条 no-undef 噪音；
//   ③ 脚本（`scripts/**`）跑在 Node 上，需要 node globals 与放开的 no-console ——
//      它们本来就是命令行工具，打印就是它的输出通道。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** docs/10 §2.2：禁 Monaco 全语言打包。 */
const MONACO_ALL_LANGS = {
  group: ['monaco-editor/basic-languages/*', 'monaco-editor/languages/register.all*'],
  message:
    '禁 Monaco 全语言注册（docs/10 §2.2）：合法形态只有 ' +
    'monaco-editor/languages/definitions/<lang>/register 的逐语言字面量 import，' +
    '唯一入口 src/features/common/monaco-langs.ts',
};

/** 04 §2 铁律：转录子树禁止 antd。 */
const NO_ANTD = {
  group: ['antd', '@ant-design/*'],
  message: 'Transcript 子树禁止 antd（docs/04 §2 铁律）',
};

/** 04 §9：禁止直接塞 HTML。 */
const NO_INNER_HTML = {
  selector: "MemberExpression[property.name='dangerouslySetInnerHTML']",
  message: '禁止 dangerouslySetInnerHTML（docs/04 §9）',
};

/**
 * 05 §3.1：零轮询。
 *
 * ⚠️ 只禁 `window.setInterval` 会漏掉裸调用 `setInterval(...)`（同一个函数，
 * 只是走了全局作用域），所以下面还配了一条 `CallExpression` 的语法禁令。
 * docs/05 §3.1 只允许"空闲回收计时器"这一处周期任务，而它在 Rust 侧（sweep），
 * 前端一个都不许有。
 */
const NO_POLLING = [
  { object: 'window', property: 'setInterval', message: '零轮询架构（docs/05 §3.1）' },
];

/** 帧处理路径（04 §4.1）：`pi:frame:*` → ipc → tabEvents → store，中间不许碰 React。 */
const FRAME_PATH = [
  'src/lib/tabEvents.ts',
  'src/lib/ipc.ts',
  'src/stores/messages.ts',
  'src/lib/coalesce.ts',
];

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri/target',
      // 构建产物（src-tauri/resources/piggy-bridge.js 由 packages/piggy-bridge 生成）
      'src-tauri/resources',
      'perf-results',
      'scripts/.tmp-*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 应用代码与测试：沿用原口径 + React Hooks 两条。
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-console': ['warn', { allow: ['debug', 'warn', 'error'] }],
      // 条件式调用 Hook、循环里用 Hook 这类**真 bug**：error
      'react-hooks/rules-of-hooks': 'error',
      // 依赖数组漏项：warn（本仓几处刻意漏项的地方已带"为什么"的 disable 注释）
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 04 §2 铁律：转录子树禁止 antd（**整个目录**，不是几个文件）。
    //
    // 2026-09-24 Transcript 拆成"薄视图 + 三个类"时名单是逐个文件列的 ——
    // 结果 `src/features/chat/` 下 21 个 .tsx 里只有 7 个在名单内，新加的文件天然漏网。
    // 现在按目录匹配，并与下面那块用 ignores 划清边界（见文件头纪律 ①）。
    files: ['src/features/chat/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_ANTD, MONACO_ALL_LANGS] }],
    },
  },
  {
    // docs/08 §4 + docs/10 §2.2：Monaco 全语言打包红线（chat 子树由上一块管辖）
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/chat/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [MONACO_ALL_LANGS] }],
    },
  },
  {
    // 05 §3.1 零轮询 + 04 §9 禁 innerHTML
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': ['error', ...NO_POLLING],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='setInterval']", message: '零轮询架构（docs/05 §3.1）' },
        NO_INNER_HTML,
      ],
    },
  },
  {
    // 04 §4.1：帧处理路径**不许**碰 React。
    //
    // 这条红线此前只写在 docs/08 §4 里，配置里根本没有对应规则（"文档说有、实际没有"）。
    // 判据按文件路径给出：帧从 `pi:frame:*` 进来，经 `lib/ipc` → `tabEvents` 分发，
    // 最后只许写 store —— 中间任何一次 `useState`/`setState` 都会把 60Hz 的帧
    // 变成 60Hz 的 React 渲染（docs/04 §4.1 整节就在讲这件事）。
    files: FRAME_PATH,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react-dom/*'], message: '帧处理路径禁止引入 React（docs/04 §4.1）' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='useState']", message: '帧处理路径禁止 useState（docs/04 §4.1）' },
        { selector: "CallExpression[callee.name='useReducer']", message: '帧处理路径禁止 useReducer（docs/04 §4.1）' },
        { selector: "CallExpression[callee.property.name='setState']", message: '帧处理路径禁止 setState（docs/04 §4.1）' },
        NO_INNER_HTML,
      ],
    },
  },
  {
    // 脚本（Node 环境 + Playwright 页面上下文）：node globals + 放开 console。
    //
    // ⚠️ 为什么**同时**要有浏览器全局：这些脚本是 Playwright 驱动，
    // `page.evaluate(() => { document.querySelector(...) })` 里的代码跑在**页面**里，
    // 而 ESLint 只看静态文本、不区分闭包被谁执行 —— 只给 node globals 会留下
    // 200+ 条 `no-undef` 噪音（实测：改之前 542 条，全在 scripts/）。
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.ts'],
    languageOptions: {
      globals: {
        // Node
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        // 两边都有
        performance: 'readonly',
        fetch: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // 浏览器（page.evaluate 里）
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        KeyboardEvent: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        Element: 'readonly',
        Image: 'readonly',
        DOMParser: 'readonly',
        CustomEvent: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // 脚本是一次性工具：没有 React 路径，也不受"零轮询"约束（回收计时器在 Rust 侧）
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
