/** 文件预览 tab（✦ 预览语义，docs/04 §1.6）：只读 Monaco，语言按扩展名 */
import { useEffect, useState } from 'react';
import { MonacoHost } from '@/features/common/MonacoHost';

interface PreviewData {
  path: string;
  size: number;
  lines: number;
  content: string;
}

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
  sh: 'shell', bash: 'shell', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', lock: 'ini',
};

export function FilePreview({ path }: { path: string }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [path]);

  if (path === '__missing__') {
    return <div className="pg-missing">会话文件不存在或已删除（可关闭此标签）</div>;
  }
  if (error) return <div className="pg-missing">预览失败：{error}</div>;
  if (!data) return <div className="pg-missing">加载中…</div>;

  const ext = data.path.split('.').at(-1)?.toLowerCase() ?? '';
  const lang = LANG[ext] ?? 'plaintext';

  return (
    <div className="pg-filepreview">
      <div className="pg-filepreview-bar">
        <span className="pg-filepreview-path">{data.path}</span>
        <span className="pg-fg-dim">
          {data.lines.toLocaleString()} 行 · {(data.size / 1024).toFixed(1)} KB
        </span>
      </div>
      <MonacoHost value={data.content} language={lang} readOnly />
    </div>
  );
}
