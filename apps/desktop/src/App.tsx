import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd';
import { useEffect } from 'react';
import { useUi } from '@/stores/ui';
import { watchSessionsChanged } from '@/stores/sessions';
import { useFleet } from '@/stores/fleet';
import { on } from '@/lib/ipc';
import { FeedbackBridge } from '@/lib/feedback';
import { AppFrame } from '@/features/workspace/AppFrame';

// 会话目录 watcher 全局订阅（一次）
void watchSessionsChanged();
// Fleet（A 层）快照全局订阅（一次，docs/06 §5）
void on('fleet:changed', (payload: { runs?: never[] }) => {
  useFleet.getState().applySnapshot(payload as never);
});

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
      {/* antd 的 <App> 才提供 AppContext —— FeedbackBridge 的 useApp() 依赖它。
          少了这层，useApp() 会静默返回 { message: {}, modal: {} }，
          toast.* 调用即抛 TypeError，全应用的错误提示就都没了。
          component={false} = 不额外包一层 div，避免破坏布局。 */}
      <AntdApp component={false}>
        <FeedbackBridge />
        <AppFrame />
      </AntdApp>
    </ConfigProvider>
  );
}
