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
  /** 显式模型 URI（如 inmemory://piggy/pi-settings.json）：JSON schema fileMatch 依赖它 */
  uri?: string;
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
  //
  // ⚠️ 语言的词法定义要**先加载完再 create**：Monaco 对未注册的 language id 会静默
  // 降级成纯文本（详见 monaco-setup.ensureLanguage 的注释）。所以创建是异步的——
  // 容器 div 立刻就在，编辑器在语言 chunk 到位后才挂进去（本进程已加载过则是一个微任务）。
  useEffect(() => {
    if (!mod || !el) return;
    const lang = props.language ?? 'plaintext';
    let cancelled = false;
    let counted = false;
    let ed: import('monaco-editor').editor.IStandaloneCodeEditor | undefined;
    let model: import('monaco-editor').editor.ITextModel | undefined;
    let dispo: import('monaco-editor').IDisposable | undefined;

    void mod
      .ensureLanguage(lang)
      .catch(() => {
        /* 已在 ensureLanguage 里 console.warn 留痕；这里降级为纯文本继续 */
      })
      .then(() => {
        if (cancelled) return;
        ed = mod.monaco.editor.create(el, {
          value: props.value,
          language: lang,
          readOnly: props.readOnly ?? false,
          theme: mod.currentThemeName(theme),
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
        });
        if (props.uri) {
          const uri = mod.monaco.Uri.parse(props.uri);
          model =
            mod.monaco.editor.getModel(uri) ?? mod.monaco.editor.createModel(props.value, lang, uri);
          ed.setModel(model);
        }
        liveInstances += 1;
        counted = true;
        dispo = ed.onDidChangeModelContent(() => onChangeRef.current?.(ed!.getValue()));
      });

    return () => {
      cancelled = true;
      dispo?.dispose();
      ed?.dispose();
      model?.dispose();
      if (counted) liveInstances = Math.max(0, liveInstances - 1);
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
