// @vitest-environment node
/**
 * 捆绑插件与宿主的**契约**（docs/06 §7）。
 *
 * 这些东西分处两地、隔着语言与进程，靠"两边都记得改"是撑不住的，所以在这里钉死：
 *
 *  1. **信封前缀**：`pi-ask/lib.js` 的 `ASK_TITLE_PREFIX` 与前端 `lib/questionChannel.ts`
 *     的必须一致 —— 不一致的症状是"插件发了请求，宿主不认，弹出一个只有『提交』的奇怪选择框"；
 *  2. **清单与代码一致**：`piggy-plugin.json` 里申报的工具/命令，必须真的在 `index.js` 里
 *     注册（申报了没注册 → 限制档位下白名单里多一个不存在的名字，等于骗模型；
 *     注册了没申报 → 限制档位下工具被 `--tools` 过滤掉，用户以为插件坏了）；
 *  3. **宿主认得的工具名**：前端卡片处理的 `ask_user_question`/`exit_plan_mode` 与清单一致；
 *  4. **可打包**：不依赖 npm 包（只允许 pi 的虚拟模块）、入口存在、许可证写清楚 ——
 *     目标机器上很可能没有 node/npm，这个目录就是最终产物。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ASK_SUBMIT_LABEL, ASK_TITLE_PREFIX } from '@/lib/questionChannel';
/* ⚠️ 路径要从 `src/test/` 数：`src/test/../../../` = `apps/desktop/`（少一层就会落到
   `apps/` 上去 —— 实测踩过）。Vite 只做 URL 解析，不会帮你纠正这个。 */
/* 插件是 plain ESM JS（没有 .d.ts，也不该为一个随包产物加构建步骤）：
   这里显式声明我们用到的那两个纯函数的形状。 */
// @ts-expect-error -- 插件是 JS，没有类型声明（刻意的：它不需要构建）
import * as pluginLibRaw from '../../src-tauri/resources/pi-plugins/pi-ask/lib.js';

const pluginLib = pluginLibRaw as {
  ASK_TITLE_PREFIX: string;
  ASK_SUBMIT_LABEL: string;
  normalizeQuestions(raw: unknown): Array<{ id: string; header: string; question: string; multiSelect: boolean }>;
  renderAnswers(
    questions: Array<{ id: string; header: string }>,
    answers: Array<{ id: string; selected: string[]; custom: string }>,
  ): string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', 'src-tauri', 'resources', 'pi-plugins', 'pi-ask');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const manifest = JSON.parse(read('piggy-plugin.json')) as {
  name: string;
  title: string;
  description: string;
  license: string;
  entry: string;
  tools: string[];
  commands: string[];
};

describe('pi-ask 与宿主的契约', () => {
  it('信封前缀 / 提交选项两边一字不差', () => {
    expect(pluginLib.ASK_TITLE_PREFIX, '插件与宿主的信封前缀不一致').toBe(ASK_TITLE_PREFIX);
    expect(pluginLib.ASK_SUBMIT_LABEL).toBe(ASK_SUBMIT_LABEL);
    expect(ASK_TITLE_PREFIX).toBe('piggy:ask:v1:');
  });

  it('清单申报的工具/命令都在 index.js 里真的注册了', () => {
    const index = read('index.js');
    /* 工具名在代码里是**常量**（`name: ASK_TOOL`），所以按"这个名字在文件里出现过 +
       registerTool 调用次数够"来判。真正的"pi 认不认"由真机探针
       （`scripts/pi-plugin-probe.mjs`）负责 —— 那一条能看见 `getAllTools()` 的真实结果。 */
    for (const t of manifest.tools) {
      expect(index, `清单申报了工具 ${t}，index.js 里连这个名字都没有`).toContain(`'${t}'`);
    }
    const toolCalls = [...index.matchAll(/registerTool\(/g)].length;
    expect(toolCalls, `申报了 ${manifest.tools.length} 个工具，只注册了 ${toolCalls} 个`).toBeGreaterThanOrEqual(
      manifest.tools.length,
    );
    for (const c of manifest.commands) {
      expect(index, `清单申报了命令 /${c}，index.js 里没有注册`).toContain(`registerCommand('${c}'`);
    }
  });

  it('宿主卡片处理的工具名与清单一致（多一个少一个都是 bug）', () => {
    const card = readFileSync(join(HERE, '..', 'features', 'chat', 'ToolCallRow.tsx'), 'utf8');
    const handled = [...card.matchAll(/toolName === '([a-z_]+)'/g)].map((m) => m[1]);
    for (const t of manifest.tools) {
      expect(handled, `卡片没有处理清单里的工具 ${t}`).toContain(t);
    }
  });

  it('可打包：入口存在、没有 npm 依赖、许可证写明', () => {
    expect(manifest.entry).toBe('index.js');
    expect(existsSync(join(DIR, manifest.entry)), '入口文件不在').toBe(true);
    expect(manifest.license, '许可证要写 SPDX（本仓是 GPL-3.0-or-later）').toBe('GPL-3.0-or-later');
    expect(manifest.title).not.toBe('');
    expect(manifest.description).not.toBe('');

    // 只允许 pi 的虚拟模块 `typebox` 与相对路径导入 —— 多一个裸包名就意味着
    // 目标机器上要有 node_modules（而那里很可能没有 node/npm）
    const index = read('index.js');
    const imports = [...index.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.length, 'index.js 没有 import？').toBeGreaterThan(0);
    for (const spec of imports) {
      const ok = spec !== undefined && (spec === 'typebox' || spec.startsWith('./') || spec.startsWith('../'));
      expect(ok, `不允许的依赖：${spec}（只允许 pi 的虚拟模块与相对路径）`).toBe(true);
    }
    // 目录里不该混进构建产物或别的东西（随包分发的东西要一眼看得完）
    const files = readdirSync(DIR).sort();
    expect(files).toEqual(['LICENSE', 'README.md', 'index.js', 'lib.js', 'piggy-plugin.json']);
    expect(read('LICENSE')).toContain('General Public License');
  });

  it('纯逻辑（lib.js）真能用：归一化与渲染（宿主与插件共用同一口径）', () => {
    const questions = pluginLib.normalizeQuestions({
      questions: [
        { question: '用哪个库？', header: '选型', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '   ' },
        { id: 'x', question: '还要改哪些？', multiSelect: true },
      ],
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]!.id).toBe('q1');
    expect(questions[1]!.multiSelect).toBe(true);
    const text = pluginLib.renderAnswers(questions, [
      { id: 'q1', selected: ['A'], custom: '顺便加测试' },
      { id: 'x', selected: ['a.ts'], custom: '' },
    ]);
    expect(text).toContain('选型：A');
    expect(text).toContain('顺便加测试');
    expect(text).toContain('x：a.ts');
  });
});
