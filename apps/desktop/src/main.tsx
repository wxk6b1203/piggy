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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
