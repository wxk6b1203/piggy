/**
 * MonacoHost（WP4，docs/10 §2.3）：所有 Monaco 挂载点经此组件。
 * 实例纪律：懒加载 chunk、**可见才创建**、按水位回收、dispose 纪律（05 §5.5、monaco-pool.ts）。
 *
 * 这里曾经有一条硬上限（`liveInstances >= 6` → 渲染"Monaco 实例已达上限，请关闭部分预览标签"），
 * 它的两个毛病都有实测证据：**每开一个预览标签就永久多一个实例**（dockview 保留非活动面板的
 * React 树），而且"已超限"只在首次渲染算一次，撞上之后关标签也回不来。
 * 现在：不可见 = 不创建；超过水位 = 回收最久没显示过的隐藏实例；**没有拒绝这条路径**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUi } from '@/stores/ui';
import { acquireEditor, releaseEditor, setEditorVisible } from './monaco-pool';

type MonacoModule = typeof import('./monaco-setup');
let setupPromise: Promise<MonacoModule> | null = null;
function loadMonaco() {
  if (!setupPromise) setupPromise = import('./monaco-setup');
  return setupPromise;
}

let hostSeq = 0;

export function MonacoHost(props: {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  height?: string;
  /** 显式模型 URI（如 inmemory://piggy/pi-settings.json）：JSON schema fileMatch 依赖它 */
  uri?: string;
  /**
   * 这个挂载点当前是否可见（dockview 面板 api 给的）。
   * `false` = **不创建编辑器**（内容还在，切回来再建）。
   * 缺省 `true`：不接可见性的挂载点按"一直显示"处理（与改动前行为一致）。
   */
  visible?: boolean;
}) {
  const [mod, setMod] = useState<MonacoModule | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  /** 被池子回收后 +1 → 重新创建（只有仍可见时才真的重建）。 */
  const [epoch, setEpoch] = useState(0);
  const theme = useUi((s) => s.theme);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const visible = props.visible ?? true;
  // 每个挂载点一个稳定 id（StrictMode 双挂载也复用同一个）
  const hostId = useMemo(() => `monaco-${(hostSeq += 1)}`, []);
  /** 活着的实例（隐藏时保留，交给池子决定何时回收）。 */
  const edRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | undefined>(undefined);
  const modelRef = useRef<import('monaco-editor').editor.ITextModel | undefined>(undefined);
  const dispoRef = useRef<import('monaco-editor').IDisposable | undefined>(undefined);

  useEffect(() => {
    void loadMonaco().then(setMod);
  }, []);

  // 池子只关心"曾经建出来过"的实例；这里汇报可见性（LRU 顺序）
  useEffect(() => {
    if (!visible) setEditorVisible(hostId, false);
  }, [hostId, visible]);

  // 销毁（卸载时，或被池子回收时）
  const destroy = useCallback(() => {
    dispoRef.current?.dispose();
    dispoRef.current = undefined;
    edRef.current?.dispose();
    edRef.current = undefined;
    modelRef.current?.dispose();
    modelRef.current = undefined;
    releaseEditor(hostId);
  }, [hostId]);

  // 卸载即销毁
  useEffect(() => destroy, [destroy]);

  // 创建：只在"可见"时建；**隐藏不销毁**（留给池子按 LRU 回收，来回切标签才不会每次都重建）
  //
  // ⚠️ 语言的词法定义要**先加载完再 create**：Monaco 对未注册的 language id 会静默
  // 降级成纯文本（详见 monaco-setup.ensureLanguage 的注释）。所以创建是异步的——
  // 容器 div 立刻就在，编辑器在语言 chunk 到位后才挂进去（本进程已加载过则是一个微任务）。
  useEffect(() => {
    if (!mod || !el || !visible || edRef.current) return;
    const lang = props.language ?? 'plaintext';
    let cancelled = false;

    void mod
      .ensureLanguage(lang)
      .catch(() => {
        /* 已在 ensureLanguage 里 console.warn 留痕；这里降级为纯文本继续 */
      })
      .then(() => {
        if (cancelled || edRef.current) return;
        // 申请一个位置：超过水位时会把最久没显示过的隐藏实例回收掉
        acquireEditor(hostId, () => {
          destroy();
          setEpoch((n) => n + 1); // 若仍可见，这个 effect 会重建；隐藏着就等切回来
        });
        const ed = mod.monaco.editor.create(el, {
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
        edRef.current = ed;
        if (props.uri) {
          const uri = mod.monaco.Uri.parse(props.uri);
          modelRef.current =
            mod.monaco.editor.getModel(uri) ?? mod.monaco.editor.createModel(props.value, lang, uri);
          ed.setModel(modelRef.current);
        }
        dispoRef.current = ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));
      });

    // ⚠️ 这里**只取消"这一次创建"**，不销毁已经建好的实例 —— 隐藏时保留正是本组件的设计
    return () => {
      cancelled = true;
    };
    // value/language 只在创建时生效（预览内容静态，docs/10 §2.3）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, el, visible, epoch, hostId, destroy]);

  // 主题热切换
  useEffect(() => {
    if (mod) mod.monaco.editor.setTheme(mod.currentThemeName(theme));
  }, [theme, mod]);

  return (
    <div
      ref={setEl}
      className="pg-monaco"
      data-monaco-mounted={mod ? '' : undefined}
      style={{ height: props.height ?? '100%' }}
    />
  );
}
