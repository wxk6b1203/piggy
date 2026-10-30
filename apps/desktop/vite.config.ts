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
    /* ⚠️ 目标保持 esnext + 用 terser 压缩，不是"随手升级"（2026-10-30 Windows 真机）。
       原因：`build.target` 只要不是 esnext（或 minify 仍是 esbuild），Vite 的
       `vite:esbuild-transpile` 就会在 **renderChunk** 阶段把每个产物 chunk 再喂给 esbuild。
       Monaco 的 `json.worker`（1.2MB）和 editor chunk（6MB+）超过 esbuild 的 1MB 阈值，
       esbuild 会先把输入写进 `%TEMP%\esbuild-*` 再让 Go 侧删除；Windows Defender 的
       实时扫描会短暂占住这个文件，删除报 `The process cannot access the file`，
       整个 `vite build` / `tauri build` 直接失败（可稳定复现，不是杀软误报的偶发）。
       源码 target 已由 `tsconfig.base.json` 钉在 ES2022，esnext 只是不再对
       **依赖产物**做二次降级；压缩交给 terser（纯 JS、不落临时文件）。
       改回 es2022 / esbuild minify 之前，先在 Windows 上跑一次 `pnpm build` 验证。 */
    target: 'esnext',
    minify: 'terser',
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
