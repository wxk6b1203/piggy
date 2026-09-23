// Piggy 质量门（docs/08 §4）：自定义红线规则
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** docs/10 §2.2：禁 Monaco 全语言打包。 */
const MONACO_ALL_LANGS = {
  group: ['monaco-editor/basic-languages/*', 'monaco-editor/languages/register.all*'],
  message:
    '禁 Monaco 全语言注册（docs/10 §2.2）：合法形态只有 ' +
    'monaco-editor/languages/definitions/<lang>/register 的逐语言字面量 import，' +
    '唯一入口 src/features/common/monaco-langs.ts',
};

export default tseslint.config(
  { ignores: ['dist', 'src-tauri/target', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': ['warn', { allow: ['debug', 'warn', 'error'] }],
    },
  },
  {
    // 04 §2 铁律：转录子树禁止 antd
    //
    // ⚠️ flat config 里**同一条规则后块整体覆盖前块**，不是合并 patterns。
    // 所以 chat 那三刀被下面 Monaco 那块 `ignores` 排除掉，由本块把两条禁令一起管
    // ——否则 Monaco 那块会把这里的作用域连同 antd 禁令一起吃掉。
    files: ['src/features/chat/Transcript.tsx', 'src/features/chat/MessageView.tsx', 'src/features/chat/TrajectoryView.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['antd', '@ant-design/*'], message: 'Transcript/Composer 子树禁止 antd（docs/04 §2 铁律）' },
            MONACO_ALL_LANGS,
          ],
        },
      ],
    },
  },
  {
    // docs/08 §4 + docs/10 §2.2：Monaco 全语言打包红线
    // （这三刀由上一块合并管辖，见那里的注释）
    files: ['src/**'],
    ignores: [
      'src/features/chat/Transcript.tsx',
      'src/features/chat/MessageView.tsx',
      'src/features/chat/TrajectoryView.tsx',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [MONACO_ALL_LANGS] }],
    },
  },
  {
    // 05 §3.1：禁止轮询（回收计时器在 Rust 侧）
    files: ['src/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'setInterval', message: '零轮询架构（docs/05 §3.1）' },
      ],
    },
  },
  {
    // XSS 红线
    files: ['src/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='dangerouslySetInnerHTML']", message: '禁止 dangerouslySetInnerHTML（docs/04 §9）' },
      ],
    },
  },
);
