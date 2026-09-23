/**
 * antd 反馈桥（message / modal）。
 *
 * 问题：antd v6 的**静态** `message.xxx()` / `Modal.confirm()` 无法读取 `ConfigProvider`
 * 的上下文，因此不会跟随主题——控制台会打印
 * `Static function can not consume context like dynamic theme`。
 * 这是 `ui:debug --strict` 抓到的真实缺陷，不是噪音。
 *
 * 解法：在 `<ConfigProvider>` 内挂一个桥组件，用 `App.useApp()` 取到**带上下文**的实例，
 * 存进模块变量；业务代码统一用本模块导出的 `toast` / `confirm`，不再直接用 antd 静态 API。
 * 桥未挂载时（例如单元测试直接渲染子组件）回退到静态 API，保证不会空指针。
 */
import { App } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import type { HookAPI as ModalHookAPI } from 'antd/es/modal/useModal';
import type { ModalStaticFunctions } from 'antd/es/modal/confirm';
import { message as staticMessage, Modal as staticModal } from 'antd';

type ModalApi = Omit<ModalStaticFunctions, 'warn'> & Pick<ModalHookAPI, 'confirm'>;

let ctxMessage: MessageInstance | null = null;
let ctxModal: ModalApi | null = null;

/** 挂在 `<ConfigProvider>` 内、`<AppFrame>` 之前；渲染 `null`。 */
export function FeedbackBridge() {
  const app = App.useApp();
  ctxMessage = app.message;
  ctxModal = app.modal as unknown as ModalApi;
  return null;
}

const call =
  <K extends keyof MessageInstance>(kind: K) =>
  (...args: Parameters<MessageInstance[K]>) => {
    const fn = (ctxMessage ?? staticMessage)[kind] as (...a: unknown[]) => unknown;
    return fn(...args);
  };

/** 主题感知的消息提示；接口与 antd 静态 `message` 对齐。 */
export const toast = {
  error: call('error'),
  success: call('success'),
  info: call('info'),
  warning: call('warning'),
  loading: call('loading'),
};

/** 主题感知的确认框；接口与 antd 静态 `Modal.confirm` 对齐。 */
export function confirm(...args: Parameters<ModalApi['confirm']>) {
  return (ctxModal ?? (staticModal as unknown as ModalApi)).confirm(...args);
}
