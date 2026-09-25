/**
 * 「添加插件」对话框（docs/04 §2.3）。
 *
 * 对齐 DSH 的安装向导第一屏：一个来源输入框 + **编号引导**（三种来源各给一条可点的
 * 示例）+ 安全提示 + 作用域选择。DSH 的引导是 1-2-3 排列，每条带"填入示例"——
 * 这一条很关键：pi 的来源语法（`npm:` 前缀、git 的几种写法、本地路径相对谁解析）
 * 光靠一句话说不清，给可点的例子最省事。
 *
 * 这里比 DSH 多一件事：**输入时就校验**（`plugin_check_source`）。
 * pi 的 `isLocalPath` 只看前缀，所以 `@scope/pkg` 这种裸包名会被当成**本地路径**，
 * 实测报错是 `Path does not exist: …/@scope/pkg`——完全看不出要加 `npm:`。
 * 与其让用户在几分钟的 npm 失败之后才发现，不如打字时就告诉他。
 */
import { useEffect, useState } from 'react';
import { Button, Input, Modal, Radio } from 'antd';
import { checkSource, type SourceCheck } from '@/lib/plugins';

interface GuideItem {
  key: string;
  title: string;
  hint: string;
  example: string;
}

/** 三种来源各一条。示例都是能直接用的形状（前两条是公开包名，第三条是路径样子）。 */
const GUIDE: GuideItem[] = [
  {
    key: 'npm',
    title: 'npm 包',
    hint: '包的 npm 名，前面必须加 npm: 前缀。不加前缀 pi 会把它当本地路径去找，报"路径不存在"。',
    example: 'npm:pi-guardrails',
  },
  {
    key: 'git',
    title: 'Git 仓库',
    hint: 'git: 简写或完整的 https/ssh 地址；可以在末尾用 @分支或@标签 钉住版本。',
    example: 'git:github.com/user/pi-plugin',
  },
  {
    key: 'path',
    title: '本地目录',
    hint: '本机上插件目录的路径（相对路径按当前项目目录解析）。文件留在原地，不复制。',
    example: '/Users/me/my-pi-plugin',
  },
];

export function InstallPluginDialog({
  open,
  hasProject,
  onClose,
  onSubmit,
}: {
  open: boolean;
  hasProject: boolean;
  onClose: () => void;
  onSubmit: (source: string, scope: 'global' | 'project') => Promise<void>;
}) {
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [check, setCheck] = useState<SourceCheck | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setSource('');
      setCheck(null);
      setScope('global');
    }
  }, [open]);

  // 输入校验：只在用户停下来时问后端（打字过程中每个字符一次 IPC 太吵）
  useEffect(() => {
    if (!open) return;
    const s = source.trim();
    if (s.length === 0) {
      setCheck(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void checkSource(s)
        .then((r) => alive && setCheck(r))
        .catch(() => alive && setCheck(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [source, open]);

  const empty = source.trim().length === 0;
  const invalid = check !== null && !check.ok;

  return (
    <Modal
      open={open}
      title="添加插件"
      onCancel={onClose}
      width={560}
      footer={
        <Button
          type="primary"
          block
          disabled={empty || invalid || busy}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(source.trim(), scope);
            } finally {
              setBusy(false);
            }
          }}
        >
          安装
        </Button>
      }
    >
      <p className="pg-plugin-dialog-intro">
        输入插件的 npm 包名、Git 仓库地址，或本机上的目录路径。
      </p>

      {check?.problem && (
        <p className="pg-plugin-dialog-error" role="alert">
          {check.problem}
          {check.hint && <> —— {check.hint}</>}
        </p>
      )}

      <Input
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="例如 npm:pi-guardrails"
        aria-label="插件来源"
        status={invalid ? 'error' : undefined}
        onPressEnter={() => {
          if (!empty && !invalid && !busy) void onSubmit(source.trim(), scope);
        }}
      />

      {check?.ok && (
        <p className="pg-plugin-dialog-ok">
          识别为 <strong>{check.sourceKindLabel}</strong>
        </p>
      )}

      <fieldset className="pg-plugin-scope">
        <legend>装到哪儿</legend>
        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
          <Radio value="global">
            全局 <span className="pg-plugin-dim">写 ~/.pi/agent/settings.json，所有项目都能用</span>
          </Radio>
          <Radio value="project" disabled={!hasProject}>
            本项目{' '}
            <span className="pg-plugin-dim">
              {hasProject ? '写 <项目>/.pi/settings.json，只在这个项目里生效' : '（没有打开项目目录）'}
            </span>
          </Radio>
        </Radio.Group>
      </fieldset>

      <div className="pg-plugin-guide">
        <p className="pg-plugin-guide-title">支持的来源</p>
        <ol>
          {GUIDE.map((g, i) => (
            <li key={g.key}>
              <span className="pg-plugin-guide-index" aria-hidden="true">
                {i + 1}
              </span>
              <div className="pg-plugin-guide-main">
                <span className="pg-plugin-guide-name">{g.title}</span>
                <span className="pg-plugin-guide-hint">{g.hint}</span>
                <span className="pg-plugin-guide-example">
                  示例：<code>{g.example}</code>
                </span>
              </div>
              <Button size="small" onClick={() => setSource(g.example)}>
                填入示例
              </Button>
            </li>
          ))}
        </ol>
        <p className="pg-plugin-guide-safety" role="note">
          插件在 pi 进程里**以你的权限**运行：它能读写你的文件、看到你的密钥与会话内容。
          pi 没有沙箱也没有签名校验（<code>docs/security.md</code>），只装你信得过的来源。
        </p>
      </div>
    </Modal>
  );
}
