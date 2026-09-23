/**
 * i18n（docs/09 M4）：zh-CN（默认）/ en-US 词典 + 轻量 t()。
 * 语言持久化 localStorage('pg.lang')；切换经 windowEvents('lang-changed') 通知重渲染。
 * M4 范围：应用壳关键文案；会话内容永远是模型原文不翻译。
 */
import { windowEvents } from '@/lib/windowEvents';

export type Lang = 'zh-CN' | 'en-US';

export const DICT = {
  'zh-CN': {
    'app.newSession': '新会话',
    'app.settings': '设置',
    'palette.placeholder': '输入命令或搜索会话…',
    'palette.empty': '无匹配',
    'welcome.hint': '从左侧选择一个会话，或新建会话开始',
    'status.hint': 'M4',
    'status.noSession': '无活动会话',
    'fleet.none': '暂无编排任务',
    'fleet.start': '启动 Fleet',
    'fleet.taskPlaceholder': '任务描述…',
    'fleet.hostRuns': '宿主编排（A 层）',
    'fleet.inSession': '会话内子代理（B 层）',
    'fleet.refresh': '刷新子代理状态（/piggy:status）',
    'fleet.notInstalled': ' · 未安装 piggy-bridge/pi-subagents',
    'fleet.notSynced': '尚未同步（需安装 piggy-bridge 扩展）',
  },
  'en-US': {
    'app.newSession': 'New Session',
    'app.settings': 'Settings',
    'palette.placeholder': 'Type a command or search sessions…',
    'palette.empty': 'No matches',
    'welcome.hint': 'Pick a session on the left, or start a new one',
    'status.hint': 'M4',
    'status.noSession': 'No active session',
    'fleet.none': 'No fleet runs yet',
    'fleet.start': 'Start Fleet',
    'fleet.taskPlaceholder': 'Task description…',
    'fleet.hostRuns': 'Hosted runs (layer A)',
    'fleet.inSession': 'In-session subagents (layer B)',
    'fleet.refresh': 'Refresh subagents (/piggy:status)',
    'fleet.notInstalled': ' · piggy-bridge/pi-subagents not installed',
    'fleet.notSynced': 'Not synced yet (install piggy-bridge)',
  },
} as const;

export type DictKey = keyof (typeof DICT)['zh-CN'];

let current: Lang = readStored();

function readStored(): Lang {
  if (typeof localStorage === 'undefined') return 'zh-CN';
  const v = localStorage.getItem('pg.lang');
  return v === 'en-US' ? 'en-US' : 'zh-CN';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('pg.lang', lang);
  }
  windowEvents.emit('lang-changed');
}

/** 翻译：缺 key 回落 zh-CN，再缺回 key 本身（永不 undefined） */
export function t(key: string): string {
  const dicts = DICT as Record<Lang, Record<string, string>>;
  return dicts[current][key] ?? dicts['zh-CN'][key] ?? key;
}
