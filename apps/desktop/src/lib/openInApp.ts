/**
 * 「打开方式」前端载体（移植 DSH `dsh-client-ui-open-in-app` 的 controller，docs/11 §2.1）。
 *
 * 三条与 DSH 对齐的语义：
 * 1. **可用列表每页只读一次**，失败当作"空表"（→ 不渲染按钮，而不是渲染一个坏按钮）；
 * 2. **上次选择跨会话、跨重启记住**（DSH 用持久化 snapshot store，这里用 localStorage）；
 * 3. **启动只报成功/失败**，失败时按钮进 error 态 2 秒再自己复位。
 *
 * 图标按需拉取并缓存在模块里（一次 8KB 左右；34 个应用不该在打开菜单前全下下来）。
 */
import { cmd } from '@/lib/ipc';
import { windowEvents } from '@/lib/windowEvents';

/** 上次用哪个应用打开（DSH 的持久化键叫 `dsh.open-in-app.choice`）。 */
const CHOICE_KEY = 'piggy.open-in-app.choice';

let appsPromise: Promise<string[]> | null = null;

/**
 * 本机装了哪些（宿主解析过的那份白名单）。
 * 同一页里并发调用共享同一次读取；失败 → 空数组（**不抛**：没有能力就不长按钮）。
 *
 * 载荷**必须校验形状**：DSH 的 controller 也是 `Array.isArray(payload.apps)` 才认。
 * 少了这一步，后端一旦回一个非数组（旧版后端、反序列化失败、测试里的通配 mock），
 * 前端会在渲染期 `apps.find is not a function` —— 整棵会话树跟着挂掉，
 * 而"打开方式"本来只是个可选按钮。这个坑是既有用例逼出来的（app-init/empty-editor/
 * sidebar-rail 三处通配 mock 都会回 `{}`）。
 */
export function loadApps(): Promise<string[]> {
  appsPromise ??= cmd<unknown>('open_in_app_list')
    .then((raw) => {
      if (!Array.isArray(raw)) {
        console.warn('[open-in-app] 宿主回的载荷不是数组，按"没有可用应用"处理', raw);
        return [];
      }
      return raw.filter((id): id is string => typeof id === 'string');
    })
    .catch((e) => {
      console.error('[open-in-app] 读取可用应用失败', e);
      return [];
    });
  return appsPromise;
}

const icons = new Map<string, string | null>();

/** 某个应用的图标（data URL）；拿不到 → null（调用方画通用图标）。 */
export async function loadIcon(id: string): Promise<string | null> {
  if (icons.has(id)) return icons.get(id) ?? null;
  let url: string | null = null;
  try {
    url = await cmd<string | null>('open_in_app_icon', { id });
  } catch (e) {
    // 图标不是功能：拉不到不该让菜单变空，也不该刷一屏错误
    console.warn('[open-in-app] 图标读取失败', id, e);
  }
  icons.set(id, url ?? null);
  return url ?? null;
}

export function readChoice(): string {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeChoice(id: string): void {
  try {
    localStorage.setItem(CHOICE_KEY, id);
  } catch {
    // 隐私模式等写不进去：本次会话内仍然生效（调用方自己持有状态）
  }
  // 广播给**其它已经挂载的会话头部**。DSH 的 choice 是一份共享 store，
  // 所以"在 A 会话来切成 GoLand"之后 B 会话的主按钮也是 GoLand；
  // Piggy 每个会话头部各持一份 state，不广播就会出现两个头部各说各话
  // （而且 B 的主按钮点下去启动的还是旧应用）。
  windowEvents.emit(CHOICE_EVENT, id);
}

const CHOICE_EVENT = 'open-in-app-choice';

/** 订阅"别处改了选择"（返回退订函数）。 */
export function onChoiceChange(handler: (id: string) => void): () => void {
  return windowEvents.on(CHOICE_EVENT, (id) => {
    if (id) handler(id);
  });
}

/**
 * 在某个应用里打开一个目录。
 * 宿主侧只认它自己解析过的启动器 + 已存在的绝对目录（见 Rust `open_in_app_open`）。
 */
export async function openInApp(id: string, path: string): Promise<void> {
  await cmd<void>('open_in_app_open', { id, path });
}

/** 仅供测试：清掉模块级缓存（应用列表 / 图标 / 选择）。 */
export function resetOpenInAppCache(): void {
  appsPromise = null;
  icons.clear();
}
