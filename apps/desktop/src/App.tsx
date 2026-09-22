/** M0 单工作面：标题栏 + 转录 + Composer + 状态栏（工作区布局 = M1，docs/04 §1） */
import { ConfigProvider, theme as antdTheme } from 'antd';
import { useEffect, useState } from 'react';
import { usePiggy } from '@/hooks/usePiggy';
import { live } from '@/lib/live';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { Transcript } from '@/features/chat/Transcript';
import { Composer } from '@/features/chat/Composer';
import { DialogRouter } from '@/features/dialogs/DialogRouter';

export default function App() {
  usePiggy();
  const [usage, setUsage] = useState('');
  const themeName = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const model = useTabs((s) => s.snapshot?.state?.model);
  const workerState = useTabs((s) => s.workerState);
  const banner = useTabs((s) => s.banner);
  const msgBanner = useMessages((s) => s.banner);
  const stats = useTabs((s) => s.statsText);
  const streaming = useMessages((s) => s.streaming);

  useEffect(() => {
    live.onUsage(setUsage);
    return () => live.onUsage(null);
  }, []);

  // 主题下发：CSS 变量（自研渲染器）+ antd algorithm（docs/04 §6）
  useEffect(() => {
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

  return (
    <ConfigProvider
      theme={{
        algorithm: themeName === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 4, fontFamily: 'inherit', fontSize: 13 },
      }}
    >
      <div className="pg-app">
        <header className="pg-titlebar">
          <span className="pg-logo">🐷 Piggy</span>
          <span className="pg-model">
            {model ? `${model.provider}/${model.id}` : 'connecting…'}
            {streaming ? <span className="pg-streaming-dot" /> : null}
          </span>
          <button className="pg-btn pg-theme-btn" onClick={toggleTheme} title="切换主题（完整主题管线 = M1，docs/10 §2.4）">
            {themeName === 'dark' ? '☀' : '☾'}
          </button>
          <span className={`pg-wstate pg-wstate-${workerState}`}>{workerState}</span>
        </header>
        {(banner ?? msgBanner) && <div className="pg-banner">{banner ?? msgBanner}</div>}
        <main className="pg-main">
          <Transcript />
        </main>
        <Composer />
        <footer className="pg-statusbar">
          <span>{usage || stats || ''}</span>
          <span className="pg-hint">M0 · Enter 发送 · Esc 中断还原 · docs/09 DoD</span>
        </footer>
        <DialogRouter />
      </div>
    </ConfigProvider>
  );
}
