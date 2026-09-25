/**
 * 高级（docs/04 §2.2）：pi 配置文件的原始 JSON 编辑器 —— 表单覆盖不到的部分的逃生口。
 *
 * 为什么还留着：pi 的 models.json / settings.json schema 极大
 * （`model-config.ts` 里光 compat 就有几十个字段），表单只覆盖最常用的那几个。
 * 手写字段（`compat.thinkingFormat`、`modelOverrides`、`promptCache`…）必须有个地方能改，
 * 否则用户只能去终端里 vim。
 *
 * 为什么**没有** auth.json：里面的密钥只在 Rust 侧脱敏读出（`auth_list`），
 * 明文不进渲染进程（docs/03 §2.10）。要改密钥请走「模型」页。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from 'antd';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { MonacoHost } from '@/features/common/MonacoHost';

function RawJsonEditor({
  title,
  hint,
  readCmd,
  writeCmd,
  height,
}: {
  title: string;
  hint: string;
  readCmd: string;
  writeCmd: string;
  height: string;
}) {
  const [text, setText] = useState('{}');
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(() => {
    void cmd<Record<string, unknown>>(readCmd)
      .then((v) => {
        setText(JSON.stringify(v, null, 2));
        setDirty(false);
      })
      .catch((e) => toast.error(String(e)));
  }, [readCmd]);

  useEffect(reload, [reload]);

  const save = async () => {
    try {
      const v = JSON.parse(text);
      await cmd(writeCmd, { value: v });
      toast.success(`${title} 已保存`);
      setDirty(false);
    } catch (e) {
      toast.error(`JSON 无效: ${e}`);
    }
  };

  return (
    <section className="pg-rawfile" data-raw-file={readCmd}>
      <div className="pg-settings-row">
        <span className="pg-settings-label">{title}</span>
        <Button type="primary" disabled={!dirty} onClick={() => void save()}>
          保存
        </Button>
        <Button onClick={reload}>放弃更改</Button>
        <span className="pg-fg-dim">{hint}</span>
      </div>
      <div className="pg-settings-mono" style={{ height }}>
        <MonacoHost
          value={text}
          language="json"
          height={height}
          onChange={(v) => {
            setText(v);
            setDirty(true);
          }}
        />
      </div>
    </section>
  );
}

export function AdvancedSection() {
  return (
    <div className="pg-settings-editor">
      <h2 className="pg-settings-title">高级</h2>
      <p className="pg-settings-intro">
        直接编辑 pi 的配置文件。表单覆盖不到的字段（<code>compat</code>、<code>modelOverrides</code>、
        <code>promptCache</code> 等）在这里改。
      </p>
      <RawJsonEditor
        title="models.json"
        hint="自定义提供商与模型目录；密钥建议在「模型」页里写（会进 pi 凭据库）"
        readCmd="models_read"
        writeCmd="models_write"
        height="320px"
      />
      <RawJsonEditor
        title="settings.json"
        hint="pi 的全局设置（默认模型、压缩、主题…）"
        readCmd="settings_read"
        writeCmd="settings_write"
        height="280px"
      />
      <p className="pg-fg-dim pg-settings-note">
        auth.json 的密钥不在这里明文显示；要增删改密钥请用「模型」页。
      </p>
    </div>
  );
}
