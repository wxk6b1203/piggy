// Piggy 质量门（docs/08 §4）：自定义红线规则
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    files: ['src/features/chat/Transcript.tsx', 'src/features/chat/MessageView.tsx', 'src/features/chat/TrajectoryView.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['antd', '@ant-design/*'], message: 'Transcript/Composer 子树禁止 antd（docs/04 §2 铁律）' }] },
      ],
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
