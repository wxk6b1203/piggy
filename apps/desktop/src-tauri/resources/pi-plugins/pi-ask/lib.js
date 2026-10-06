/**
 * pi-ask 的**纯逻辑**（没有 pi 依赖，可以直接单测）。
 *
 * 与 `index.js` 分家的理由：入口要 `import { Type } from 'typebox'` —— 那是 pi 提供的
 * **虚拟模块**，离开了 pi 就解析不了（node 直接 import 会 ERR_MODULE_NOT_FOUND）。
 * 把"问题怎么归一化、回答怎么渲染"这些真正会出错的部分放在这里，测试就不必假装自己是 pi。
 */

/** 宿主标识：Piggy 起 pi 时会带上它（`pi/process.rs::spawn_envs`）。 */
export const HOST_ENV = 'PIGGY_HOST';

/** 提问卡信封前缀（版本化：宿主与插件都要能各自升级）。 */
export const ASK_TITLE_PREFIX = 'piggy:ask:v1:';

/** 提问卡固定选项（真正的选项在工具参数里）。 */
export const ASK_SUBMIT_LABEL = '提交';

/** 计划模式的状态键（`ui.setStatus`）。 */
export const PLAN_STATUS_KEY = 'pi-ask/plan';

/** 计划模式下会被拦下的工具（写文件的那些）。 */
export const WRITE_TOOLS = ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch'];

export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 8;

/** 计划模式下给每条用户消息加的说明（模型据此知道"只出方案、先别动手"）。 */
export const PLAN_PREAMBLE = [
  '[计划模式] 现在只做调研与规划，**不要**改任何文件（edit/write 会被拦下）。',
  '把方案写清楚（要动哪些文件、按什么顺序、有什么风险），然后用 `exit_plan_mode` 提交给用户审批。',
  '',
].join('\n');

/**
 * 参数归一化（模型可能少给 id/header，也一次给太多问题）。
 *
 * @param raw - 工具参数
 * @returns 规整后的问题数组
 */
export function normalizeQuestions(raw) {
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  const out = [];
  for (let i = 0; i < list.length && out.length < MAX_QUESTIONS; i += 1) {
    const q = list[i] ?? {};
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (question === '') continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({
        label: typeof o?.label === 'string' ? o.label.trim() : '',
        ...(typeof o?.description === 'string' && o.description.trim() !== ''
          ? { description: o.description.trim() }
          : {}),
      }))
      .filter((o) => o.label !== '')
      .slice(0, MAX_OPTIONS);
    out.push({
      id: typeof q.id === 'string' && q.id.trim() !== '' ? q.id.trim() : `q${out.length + 1}`,
      header: typeof q.header === 'string' ? q.header.trim() : '',
      question,
      options,
      multiSelect: q.multiSelect === true,
      // 有选项时默认也给自由文本：问"选哪个"往往还需要一句补充
      allowCustom: q.allowCustom !== false,
    });
  }
  return out;
}

/**
 * 回答 → 工具结果文本（模型读这一段）。
 *
 * @param questions - 归一化后的问题
 * @param answers - 用户回答
 * @returns 结果文本
 */
export function renderAnswers(questions, answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const lines = [];
  for (const q of questions) {
    const a = byId.get(q.id);
    const picked = a?.selected ?? [];
    const custom = typeof a?.custom === 'string' && a.custom.trim() !== '' ? a.custom.trim() : '';
    const label = q.header !== '' ? q.header : q.id;
    if (picked.length === 0 && custom === '') {
      lines.push(`- ${label}：(未回答)`);
      continue;
    }
    const head = picked.length > 0 ? picked.join('、') : '(自由文本)';
    lines.push(`- ${label}：${head}${custom !== '' ? ` （用户补充：${custom}）` : ''}`);
  }
  return `用户回答了：\n${lines.join('\n')}`;
}

