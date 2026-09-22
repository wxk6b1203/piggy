/**
 * MonacoHost（WP4，docs/10 §2.3）：所有 Monaco 挂载点经此组件。
 * 实例纪律：懒加载 chunk、并发上限、dispose 纪律（05 §5.5）。
 */
import { useEffect, useRef, useState } from 'react';
import { useUi } from '@/stores/ui';

type MonacoModule = typeof import('./monaco-setup');
let setupPromise: Promise<MonacoModule> | null = null;
function loadMonaco() {
  if (!setupPromise) setupPromise = import('./monaco-setup');
  return setupPromise;
}

let liveInstances = 0;
const MAX_INSTANCES = 6; // 10 §2.3

export function MonacoHost(props: {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  height?: string;
}) {
  const [mod, setMod] = useState<MonacoModule | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const theme = useUi((s) => s.theme);
  const overLimit = useRef(liveInstances >= MAX_INSTANCES);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    if (!overLimit.current) void loadMonaco().then(setMod);
  }, []);

  // 创建 / 销毁（预览内容静态：value/language 仅创建时生效）
  useEffect(() => {
    if (!mod || !el) return;
    const ed = mod.monaco.editor.create(el, {
      value: props.value,
      language: props.language ?? 'plaintext',
      readOnly: props.readOnly ?? false,
      theme: mod.currentThemeName(theme),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
    });
    liveInstances += 1;
    const dispo = ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));
    return () => {
      dispo.dispose();
      ed.dispose();
      liveInstances = Math.max(0, liveInstances - 1);
    };
  }, [mod, el]);

  // 主题热切换
  useEffect(() => {
    if (mod) mod.monaco.editor.setTheme(mod.currentThemeName(theme));
  }, [theme, mod]);

  if (overLimit.current) {
    return <div className="pg-missing">Monaco 实例已达上限（{MAX_INSTANCES}），请关闭部分预览标签</div>;
  }
  return <div ref={setEl} className="pg-monaco" style={{ height: props.height ?? '100%' }} />;
}
