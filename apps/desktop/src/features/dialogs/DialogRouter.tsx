/** Extension UI 弹窗路由（docs/02 §8）：dialog 串行队列 + notify 即时通知 */
import { useState } from 'react';
import { Input, Modal, notification } from 'antd';
import { cmd } from '@/lib/ipc';
import { useDialogs, type UiRequest } from '@/stores/dialogs';
import { useTabs } from '@/stores/tabs';

export function DialogRouter() {
  const current = useDialogs((s) => s.current);
  const next = useDialogs((s) => s.next);
  const tabId = useTabs((s) => s.tabId);
  const [value, setValue] = useState('');

  const reply = async (payload: Record<string, unknown>) => {
    if (!current || !tabId) return;
    try {
      await cmd('ui_reply', {
        tabId,
        response: { type: 'extension_ui_response', id: current.id, ...payload },
      });
    } finally {
      setValue('');
      next();
    }
  };

  if (!current) return null;
  const req = current as UiRequest & {
    title?: string;
    message?: string;
    options?: string[];
    prefill?: string;
    placeholder?: string;
  };

  switch (current.method) {
    case 'select':
      return (
        <Modal
          open
          title={req.title ?? '选择'}
          footer={null}
          onCancel={() => void reply({ cancelled: true })}
          destroyOnHidden
        >
          {(req.options ?? []).map((opt) => (
            <button key={opt} className="pg-select-opt" onClick={() => void reply({ value: opt })}>
              {opt}
            </button>
          ))}
        </Modal>
      );
    case 'confirm':
      return (
        <Modal
          open
          title={req.title ?? '确认'}
          okText="确认"
          cancelText="取消"
          onOk={() => void reply({ confirmed: true })}
          onCancel={() => void reply({ cancelled: true })}
          destroyOnHidden
        >
          <p>{req.message}</p>
        </Modal>
      );
    case 'input':
      return (
        <Modal
          open
          title={req.title ?? '输入'}
          okText="提交"
          cancelText="取消"
          onOk={() => void reply({ value })}
          onCancel={() => void reply({ cancelled: true })}
          destroyOnHidden
        >
          <Input
            autoFocus
            placeholder={req.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={() => void reply({ value })}
          />
        </Modal>
      );
    case 'editor':
      return (
        <Modal
          open
          title={req.title ?? '编辑'}
          width={720}
          okText="提交"
          cancelText="取消"
          onOk={() => void reply({ value })}
          onCancel={() => void reply({ cancelled: true })}
          destroyOnHidden
        >
          <Input.TextArea
            autoFocus
            rows={16}
            className="pg-mono"
            value={value || req.prefill || ''}
            onChange={(e) => setValue(e.target.value)}
          />
        </Modal>
      );
    default:
      // fire-and-forget 类（notify/setStatus/setWidget/setTitle/set_editor_text）
      return null;
  }
}

/** notify → antd notification；其余 fire-and-forget M0 记 console（docs/02 §8 M1 全量视觉化） */
export function handleFireAndForget(req: UiRequest) {
  if (req.method === 'notify') {
    const r = req as { message?: string; notifyType?: string };
    notification[r.notifyType === 'error' ? 'error' : r.notifyType === 'warning' ? 'warning' : 'info']({
      message: '扩展通知',
      description: r.message ?? '',
      placement: 'bottomRight',
    });
  } else {
    console.debug('[extension-ui]', req.method, req);
  }
}
