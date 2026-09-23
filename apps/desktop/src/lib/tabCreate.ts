/**
 * 受保护的 tab 创建（docs/05 §4.2）：`MAX_WORKERS` 触顶时先询问用户是否回收最闲会话。
 *
 * 背景：宿主对同时存活的 pi worker 数量有上限；直接报错会让"新建会话"在重度使用下突然失效。
 * 这里把它转成一次可交互的降级：回收最闲会话（休眠不丢消息，激活时自动恢复）后重试一次。
 *
 * 只重试一次：回收后仍失败说明是别的原因（如 pi 缺失），此时把原始错误抛给调用方。
 */
import { cmd } from '@/lib/ipc';
import { confirm } from '@/lib/feedback';
import { createTab, type TabSnapshot } from '@/stores/tabs';

export interface CreateTabInput {
  cwd?: string;
  sessionPath?: string;
  name?: string;
}

/** 宿主容量错误的前缀（Rust 侧抛出，见 docs/02 §7）。 */
const MAX_WORKERS = 'MAX_WORKERS';

export async function createTabGuarded(input: CreateTabInput): Promise<TabSnapshot> {
  try {
    return await createTab(input);
  } catch (e) {
    const text = String(e);
    if (!text.startsWith(MAX_WORKERS)) throw e;

    const reclaimed = await new Promise<boolean>((resolve) => {
      confirm({
        title: '活跃会话已达上限',
        content: `${text.replace(`${MAX_WORKERS}: `, '')}要自动回收最空闲的会话吗？（休眠不丢消息，激活时自动恢复）`,
        okText: '回收最闲并继续',
        cancelText: '取消',
        onOk: async () => {
          try {
            await cmd('tab_sleep_idlest', {});
            resolve(true);
          } catch {
            resolve(false);
          }
        },
        onCancel: () => resolve(false),
      });
    });

    if (!reclaimed) throw e;
    return createTab(input);
  }
}
