/**
 * 权限档位选择器（Composer 工具行左侧，DSH `conversation.input.permission` 位）。
 *
 * ## 为什么文案不写死在前端
 * 三个档位的**真实能力**由 `pi --tools` 白名单 + 守卫扩展决定（见 src-tauri/src/pi/permission.rs）。
 * 如果这里硬编码一份"看起来对"的描述，后端一改就会变成谎话——所以档位名、工具清单、
 * 是否有路径守卫全部从 `permission_modes` 命令读，前端只负责呈现。
 *
 * ## 切档为什么会有一次重启
 * `--tools` / `-e` 都是 pi 的 CLI 参数，RPC 没有运行期改工具的接口。
 * 因此后端会"停旧进程 → 按新档复活"，会话文件与游标不变（复用崩溃复活路径）。
 * 这里明确告知用户，而不是让切换看起来是零成本的。
 */
import { useEffect, useState } from 'react';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { useTabs } from '@/stores/tabs';
import { Icon } from '@/features/common/Icon';
import { Picker, type PickerItem } from '@/features/common/Picker';

export type PermissionModeId = 'read-only' | 'workspace' | 'full';

export interface PermissionModeInfo {
  id: PermissionModeId;
  label: string;
  /** `--tools` 白名单；null = 不传（不限制） */
  tools: string | null;
  unrestricted: boolean;
  pathGuard: boolean;
}

/** 后端不可用时的兜底展示（只影响文案；真实行为始终由后端决定）。 */
const FALLBACK: PermissionModeInfo[] = [
  { id: 'read-only', label: '仅可查看', tools: 'read,grep,find,ls', unrestricted: false, pathGuard: false },
  {
    id: 'workspace',
    label: '工作区内修改',
    tools: 'read,grep,find,ls,write,edit',
    unrestricted: false,
    pathGuard: true,
  },
  { id: 'full', label: '完全权限', tools: null, unrestricted: true, pathGuard: false },
];

/** 进程内缓存：档位矩阵是编译期常量，一个会话里取一次就够。 */
let cached: PermissionModeInfo[] | null = null;

export function PermissionPicker({ tabId }: { tabId: string }) {
  const permission = useTabs((s) => s.tabs[tabId]?.permission ?? 'workspace');
  const patch = useTabs((s) => s.patch);
  const [modes, setModes] = useState<PermissionModeInfo[]>(cached ?? FALLBACK);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    void cmd<{ modes: PermissionModeInfo[] }>('permission_modes')
      .then((r) => {
        if (!alive || !r.modes?.length) return;
        cached = r.modes;
        setModes(r.modes);
      })
      .catch(() => {
        /* 兜底 FALLBACK 已经显示，静默保留 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const current = modes.find((m) => m.id === permission) ?? modes[1]!;

  const items: PickerItem[] = modes.map((m) => ({
    id: m.id,
    label: m.label,
    icon: m.id === 'read-only' ? 'eye' : m.id === 'workspace' ? 'shield' : 'unlock',
    active: m.id === permission,
    detail: describe(m),
  }));

  const pick = async (id: string) => {
    if (id === permission || busy) return;
    setBusy(true);
    try {
      await cmd('pi_set_permission_mode', { tabId, mode: id });
      patch(tabId, { permission: id as PermissionModeId });
      const label = modes.find((m) => m.id === id)?.label ?? id;
      toast.success(`权限档位已切换为「${label}」`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Picker
      className="pg-pill pg-perm-select"
      buttonTitle={`权限档位：${current.label}\n${describe(current)}\n\n${SWITCH_NOTE}`}
      items={items}
      onPick={(id) => void pick(id)}
      title="权限档位"
      width={330}
      disabled={busy}
      footer={SWITCH_NOTE}
    >
      <Icon name={current.id === 'read-only' ? 'eye' : current.id === 'workspace' ? 'shield' : 'unlock'} size={12} />
      {current.label}
      <Icon name="chevron-down" size={12} />
    </Picker>
  );
}

const SWITCH_NOTE =
  '切换档位需要重启该会话的 pi 进程（工具白名单是启动参数），会话内容与游标不受影响。';

/** 把后端能力矩阵翻译成一句人话——不夸大：只读档不提"沙箱"，工作区档明说有边界守卫。 */
function describe(m: PermissionModeInfo): string {
  switch (m.id) {
    case 'read-only':
      return '只能读取文件，不提供写入与命令执行工具';
    case 'workspace':
      return '可读可写，但写入被限制在会话工作区目录内；不提供命令执行（bash）工具';
    case 'full':
      return '不做任何限制，包含命令执行与自定义/插件工具';
    default:
      return m.tools ? `工具：${m.tools}` : '不限制工具';
  }
}
