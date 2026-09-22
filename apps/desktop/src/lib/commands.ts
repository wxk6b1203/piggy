/**
 * CommandRegistry（docs/07 §1）：一切可执行动作的唯一 id 来源；键位/面板共用。
 */

export interface CommandContext {
  activeTabId: string | null;
}

export interface Command {
  id: string;
  title: string;
  category: '会话' | '视图' | '模型' | '应用';
  /** 键位缺省（07 §2 表）；可被用户覆盖覆盖 */
  keys?: string;
  /** 输入框聚焦时是否仍触发（默认仅 Cmd/Ctrl 组合触发） */
  whenInInput?: boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

const registry = new Map<string, Command>();

export function registerCommand(c: Command): void {
  if (typeof window !== 'undefined' && isMock) {
    console.debug('[commands] register', c.id, 'size→', registry.size + 1);
  }
  registry.set(c.id, c);
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function registrySize(): number {
  return registry.size;
}

// mock 环境：调试钩子
import { isMock } from '@/lib/mockBackend';
if (typeof window !== 'undefined' && isMock) {
  (window as unknown as Record<string, unknown>).__piggyCommands = {
    size: () => registry.size,
    ids: () => [...registry.keys()],
  };
}
