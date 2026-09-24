/**
 * 文档预览（DSH `TextPreview`，docs/12 §6.5）：**面包屑行与"语言条"是同一行，38px**。
 *
 * 对齐要点：
 *  - 头部 38px、padding `0 6px 0 16px`、底 `0.5px` 的 border-l3 发丝线；
 *  - 路径溢出时**遮罩淡出而非省略号**（DSH 用 `mask-image`，且由测量决定是否加 `data-clipped`）；
 *  - 目录灰、文件名亮（`PathLabel`）；
 *  - 工具按钮 28px 圆钮、图标 15px、hover 才出现底色；
 *  - 代码区圆角 0、底透明（露出面板底色），行号交给 Monaco（等价于 DSH 的 CSS counter 方案）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MonacoHost } from '@/features/common/MonacoHost';
import { Icon } from '@/features/common/Icon';
import { OpenPathAction } from './OpenPathAction';
import { langForPath } from '@/features/common/monaco-langs';
import { toast } from '@/lib/feedback';

interface PreviewData {
  path: string;
  size: number;
  lines: number;
  content: string;
}

/** `root` = 项目根，仅用于展示相对路径的语境（读取仍走绝对 `path`）。 */
export function FilePreview({ path, root }: { path: string; root?: string }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pathRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!path || path === '__missing__') return;
    let alive = true;
    setData(null);
    setError(null);
    import('@/lib/ipc')
      .then(({ cmd }) => cmd<PreviewData>('fs_preview_read', { path }))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [path, nonce]);

  // 路径溢出检测 → data-clipped（DSH PathLabel 同款：遮罩淡出而不是省略号）
  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    el.toggleAttribute('data-clipped', !!inner && inner.offsetWidth > el.clientWidth);
  }, [path, data]);

  const { dir, name } = useMemo(() => splitPath(data?.path ?? path), [data?.path, path]);
  // 语言**只有这一处判定**（`monaco-langs.ts` 的表 + 逐门懒加载）。
  // 这里原来还有一张 16 项的本地表：`.rs`/`.java`/`.toml`/`Dockerfile`/`.rb`… 全都不在表里，
  // 于是"语言条写着 plaintext、正文一行都不上色"——正是 docs/15 规矩 25 那类静默降级。
  const lang = langForPath(data?.path ?? path);

  if (path === '__missing__') {
    return <div className="pg-missing">会话文件不存在或已删除（可关闭此标签）</div>;
  }

  return (
    <div className="pg-preview">
      {/* 38px：面包屑 + 语言 + 工具，同一行 */}
      <div className="pg-preview-head">
        <span className="pg-preview-path" ref={pathRef} title={data?.path ?? path}>
          <span className="pg-preview-pathtext">
            <span className="pg-preview-dir">{dir}</span>
            <span className="pg-preview-name">{name}</span>
          </span>
        </span>
        <span className="pg-preview-lang" title="语言">
          {lang}
        </span>
        <button
          className="pg-preview-tool"
          aria-pressed={wrap}
          title={wrap ? '关闭自动换行' : '开启自动换行'}
          onClick={() => setWrap((w) => !w)}
        >
          <Icon name="word-wrap" size={15} />
        </button>
        <button
          className="pg-preview-tool"
          title="重新加载"
          onClick={() => setNonce((n) => n + 1)}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          className="pg-preview-tool"
          title="复制全文"
          disabled={!data}
          onClick={() => {
            if (!data) return;
            void navigator.clipboard.writeText(data.content).then(() => toast.success('已复制'));
          }}
        >
          <Icon name="copy" size={15} />
        </button>
        {/* DSH `sidebar.right.tab.document.actions` 位：用外部应用打开**这个文件**
            （系统文件关联，不是工作区目录那一档）。桌面能力不可用时它自己不渲染。 */}
        <OpenPathAction path={data?.path ?? path} />
      </div>

      <div className="pg-preview-body" data-wrap={wrap || undefined}>
        {error ? (
          <div className="pg-missing">预览失败：{error}</div>
        ) : !data ? (
          <div className="pg-missing">加载中…</div>
        ) : (
          <>
            <MonacoHost value={data.content} language={lang} readOnly />
            <div className="pg-preview-meta">
              {data.lines.toLocaleString()} 行 · {(data.size / 1024).toFixed(1)} KB
              {root ? ` · ${data.path.startsWith(root) ? data.path.slice(root.length + 1) : ''}` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 目录部分灰、文件名亮；目录末尾保留分隔符以便视觉衔接。 */
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  if (i < 0) return { dir: '', name: p };
  return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}
