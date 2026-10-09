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
import { createHash } from 'node:crypto';
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
const PLUGINS_DIR = join(HERE, '..', '..', 'src-tauri', 'resources', 'pi-plugins');
const DIR = join(PLUGINS_DIR, 'pi-ask');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

/** 随包分发的全部插件（每个目录一个 `piggy-plugin.json`）。 */
const PLUGINS = readdirSync(PLUGINS_DIR)
  .filter((n) => existsSync(join(PLUGINS_DIR, n, 'piggy-plugin.json')))
  .sort();
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

describe('随包分发的每个插件（自研 + 收录的第三方）', () => {
  it('目录、清单与许可证齐全（随包分发别人的代码必须带许可证）', () => {
    expect(PLUGINS.length, '一个随包插件都没有？').toBeGreaterThan(0);
    for (const name of PLUGINS) {
      const dir = join(PLUGINS_DIR, name);
      const m = JSON.parse(readFileSync(join(dir, 'piggy-plugin.json'), 'utf8')) as {
        name: string;
        entry: string;
        license: string;
        tools: string[];
      };
      expect(m.name, `${name}: 清单里的名字与目录名不一致`).toBe(name);
      expect(existsSync(join(dir, m.entry)), `${name}: 入口 ${m.entry} 不存在`).toBe(true);
      expect(existsSync(join(dir, 'LICENSE')), `${name}: 缺 LICENSE`).toBe(true);
      expect(m.license, `${name}: 许可证没写`).not.toBe('');
      expect(Array.isArray(m.tools), `${name}: tools 必须是数组（限制档位靠它拼白名单）`).toBe(true);
    }
  });

  it('收录的第三方插件必须能证明出处，且内容没被动过（漂移检测）', () => {
    for (const name of PLUGINS) {
      const dir = join(PLUGINS_DIR, name);
      const vendorPath = join(dir, 'vendor.json');
      // 自研插件不需要 vendor.json（它是本仓的一部分，出处就是本仓）
      if (!existsSync(vendorPath)) continue;
      const v = JSON.parse(readFileSync(vendorPath, 'utf8')) as {
        source: { path: string; commit: string | null };
        files: Record<string, string>;
      };
      expect(v.source.path, `${name}: vendor.json 没记来源`).not.toBe('');
      expect(Object.keys(v.files).length, `${name}: vendor.json 没有文件清单`).toBeGreaterThan(0);
      for (const [rel, want] of Object.entries(v.files)) {
        const file = join(dir, rel);
        expect(existsSync(file), `${name}: 清单里的 ${rel} 不在`).toBe(true);
        const got = createHash('sha256').update(readFileSync(file)).digest('hex');
        expect(got, `${name}: ${rel} 被改过（请重跑 scripts/vendor-plugin.mjs）`).toBe(want);
      }
    }
  });

  it('每个插件都不依赖 npm 包（只允许 pi 的虚拟模块与相对路径）', () => {
    const VIRTUAL = new Set(['typebox', '@earendil-works/pi-coding-agent', '@sinclair/typebox']);
    for (const name of PLUGINS) {
      const dir = join(PLUGINS_DIR, name);
      const m = JSON.parse(readFileSync(join(dir, 'piggy-plugin.json'), 'utf8')) as { entry: string };
      const entry = readFileSync(join(dir, m.entry), 'utf8');
      for (const spec of [...entry.matchAll(/from\s+'([^']+)'/g)].map((x) => x[1] ?? '')) {
        const ok = VIRTUAL.has(spec) || spec.startsWith('./') || spec.startsWith('../');
        expect(ok, `${name}: 不允许的依赖 ${spec}（目标机器可能没有 node/npm）`).toBe(true);
      }
    }
  });

  /* 2026-10-09 补：插件目录 10-06 就进来了，而**两个 SKU 的 bundle.resources 都没登记它**
     —— 打包产物一个插件都没有，而构建机上直接跑那个 .app 会看起来正常
     （`pi/resources.rs` 的第三候选 `CARGO_MANIFEST_DIR` 正好命中源码树），换台机器才消失。
     Rust 侧有一条同样的闸门（`pi/plugins.rs::both_skus_register_the_plugin_directory`），
     两条都要留：这条跑在 frontend 作业（ubuntu），那条跑在 rust 作业（macos）。 */
  it('两个 SKU 的 bundle.resources 都登记了插件目录，而且必须是 **/*', () => {
    const appDir = join(HERE, '..', '..');
    for (const conf of ['tauri.conf.json', 'tauri.full.conf.json']) {
      const c = JSON.parse(readFileSync(join(appDir, 'src-tauri', conf), 'utf8')) as {
        bundle: { resources: string[] };
      };
      // `**/*` 而不是 `*`：tauri 用 glob crate，`*` 不跨目录分隔符，
      // 写成 `resources/pi-plugins/*` 会把 `pi-todo/src/*.ts` 全漏掉（docs/17 §3 第 6 条）
      expect(c.bundle.resources, `${conf} 的 bundle.resources 少了插件目录（打包产物会零插件）`).toContain(
        'resources/pi-plugins/**/*',
      );
    }
  });
});
