import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
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
    /* ⚠️ 覆盖范围是 src 全树，不是 src/test（2026-09-25 改）。
       原来只认 src/test/，于是把测试写在源码旁边（例如 src/lib/foo.test.ts）
       **不报错、不运行** —— 静默失效正是这个仓库最忌讳的失效方式。
       include 同收两处：src/test/ 下的现有 60 个文件，以及源码旁的测试文件。
       src-tauri 不在此列（Rust 侧走 cargo test）。 */
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
});
