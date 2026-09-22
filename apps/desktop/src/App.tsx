import { ConfigProvider, theme as antdTheme } from 'antd';
import { useEffect } from 'react';
import { useUi } from '@/stores/ui';
import { watchSessionsChanged } from '@/stores/sessions';
import { AppFrame } from '@/features/workspace/AppFrame';

// 会话目录 watcher 全局订阅（一次）
void watchSessionsChanged();

export default function App() {
  const themeName = useUi((s) => s.theme);

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
      <AppFrame />
    </ConfigProvider>
  );
}
