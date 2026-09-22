import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // monaco exports map 的 ./* 目标存在重写错误（esm/vs/* 双写），alias 直达目录绕过（docs/10 §2.2）
      {
        find: 'monaco-editor/esm',
        replacement: fileURLToPath(new URL('./node_modules/monaco-editor/esm', import.meta.url)),
      },
    ],
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', {}]],
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 5195,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
});
