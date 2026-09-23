/**
 * antd 反馈桥（message / modal）。
 *
 * 问题：antd v6 的**静态** `message.xxx()` / `Modal.confirm()` 无法读取 `ConfigProvider`
 * 的上下文，因此不会跟随主题——控制台会打印
 * `Static function can not consume context like dynamic theme`。
 * 这是 `ui:debug --strict` 抓到的真实缺陷，不是噪音。
 *
 * 解法：在 `<ConfigProvider>` **内、antd `<App>` 组件内**挂一个桥组件，
 * 用 `App.useApp()` 取到**带上下文**的实例，存进模块变量；
 * 业务代码统一用本模块导出的 `toast` / `confirm`，不再直接用 antd 静态 API。
 *
 * ## 两个必须同时成立的细节（都踩过）
 *
 * 1. **桥必须包在 antd 的 `<App>` 里**。`App.useApp()` 读的是 `AppContext`，
 *    而它的默认值是 `{ message: {}, notification: {}, modal: {} }`（`antd/es/app/context.js:3-7`）。
 *    只包 `ConfigProvider` 的话 `useApp()` 会**静默返回这组空对象**，不报任何错。
 *
 * 2. **兜底要按方法判断，不能按对象判断**。空对象 `{}` 是真值，
 *    `ctxMessage ?? staticMessage` 的 `??` 不会生效，于是 `{}['error']` 是 `undefined`，
 *    调用即 `TypeError: fn is not a function`——**报错通道自己抛异常，所有错误都被吞掉**。
 *    所以这里逐个方法做特性检测。
 */
import { App } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import type { HookAPI as ModalHookAPI } from 'antd/es/modal/useModal';
import type { ModalStaticFunctions } from 'antd/es/modal/confirm';
import { message as staticMessage, Modal as staticModal } from 'antd';

type ModalApi = Omit<ModalStaticFunctions, 'warn'> & Pick<ModalHookAPI, 'confirm'>;

let ctxMessage: Partial<MessageInstance> | null = null;
let ctxModal: Partial<ModalApi> | null = null;

/** 挂在 `<ConfigProvider>` **内、antd `<App>` 内**、`<AppFrame>` 之前；渲染 `null`。 */
export function FeedbackBridge() {
  const app = App.useApp();
  // useApp() 在 <App> 之外会返回空对象（不抛错），所以先看一眼方法在不在
  ctxMessage = typeof app?.message?.error === 'function' ? app.message : null;
  ctxModal = typeof app?.modal?.confirm === 'function' ? (app.modal as unknown as ModalApi) : null;
  return null;
}

const call =
  <K extends keyof MessageInstance>(kind: K) =>
  (...args: Parameters<MessageInstance[K]>) => {
    // 逐个方法回退：桥没挂上 / 挂错位置时仍然可用（虽然不带主题）
    const fromCtx = ctxMessage?.[kind];
    const fn = (typeof fromCtx === 'function' ? fromCtx : staticMessage[kind]) as (
      ...a: unknown[]
    ) => unknown;
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
  const fromCtx = ctxModal?.confirm;
  const api = typeof fromCtx === 'function' ? (ctxModal as ModalApi) : (staticModal as unknown as ModalApi);
  return api.confirm(...args);
}
