import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'dockview-react/dist/styles/dockview.css';
// VS Code 官方图标字体（docs/13）：与 VS Code 同一 npm 源，字形一致
import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { ErrorBoundary, installGlobalErrorReporting } from './features/common/ErrorBoundary';

// 必须在任何应用代码之前装：这样连模块求值期的异常也能被捕获并送到宿主终端
installGlobalErrorReporting();

/**
 * 开发期调试钩子（仅 DEV）。
 *
 * 存在的理由：从 Playwright 里 `import('/src/stores/tabs.ts')` **可能拿到另一个模块实例**
 * （URL 与 HMR 时间戳不同即算不同模块），于是断言读到的是空 store ——
 * 2026-09-23 排查启动问题时因此得出过完全错误的结论。这里导出**应用自己用的那几个实例**，
 * 核对脚本读它才等于读应用的状态。生产构建下这段被摇掉。
 */
if (import.meta.env.DEV) {
  void Promise.all([
    import('@/stores/tabs'),
    import('@/stores/messages'),
    import('@/stores/trajectory'),
    import('@/stores/fleet'),
    // 命令表也要走这个钩子：`ui:startup` 第 7 段要拿**应用自己那份注册表**去核
    // 空编辑区列出的快捷键与标题。另 import 一份 `@/lib/commands` 会得到**空表**
    // （模块实例不同，见上），断言会集体假红 —— 实测踩过。
    import('@/lib/commands'),
  ]).then(([tabs, messages, trajectory, fleet, commands]) => {
    (globalThis as Record<string, unknown>).__piggyStores = {
      useTabs: tabs.useTabs,
      useMessages: messages.useMessages,
      useTrajectory: trajectory.useTrajectory,
      useFleet: fleet.useFleet,
    };
    (globalThis as Record<string, unknown>).__piggyCommands = commands;
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
