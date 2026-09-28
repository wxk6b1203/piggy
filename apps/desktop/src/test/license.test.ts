/**
 * 许可元数据的一致性（README「授权」、THIRD_PARTY_NOTICES.md）。
 *
 * 为什么许可也要有测试：这几个事实**散在 8 个文件里**，而它们的失效方式全是静默的——
 *   · 新加一个 workspace 包却忘了写 `license` 字段：`pnpm -r` 一切正常，
 *     只有发布出去之后才有人发现那个包"没有许可"（默认保留所有权利，
 *     与整个项目的 GPL 承诺矛盾）；
 *   · `tauri.conf.json` 的 `bundle.resources` 是手写清单：重排/精简资源时
 *     很容易把 `pi-LICENSE.txt` 顺手删掉——而 MIT 的义务恰恰是"随分发携带声明"。
 *     删掉之后**打包完全成功**，只有安装包少了那张纸。
 *   · `LICENSE` 被"顺手润色"（GPL 明说 *changing it is not allowed*）。
 *
 * 所以这里逐个键断言，而不是"看一遍觉得没问题"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** vitest 的 cwd 是 apps/desktop；仓库根在两级之上。 */
const APP = process.cwd();
const ROOT = join(APP, '..', '..');

const read = (p: string) => readFileSync(p, 'utf8');
const readJson = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

/** 本项目声明的 SPDX 标识（README「授权」里写的就是它）。 */
const SPDX = 'GPL-3.0-or-later';

describe('LICENSE 是 GPLv3 原文', () => {
  const licensePath = join(ROOT, 'LICENSE');

  it('存在，且是**未被改动**的 GPLv3 全文', () => {
    expect(existsSync(licensePath), 'LICENSE 不存在').toBe(true);
    const text = read(licensePath);
    // GPLv3 原文的关键结构（少了任何一条就说明不是原文，或被截断）
    for (const marker of [
      'GNU GENERAL PUBLIC LICENSE',
      'Version 3, 29 June 2007',
      'Everyone is permitted to copy and distribute verbatim copies',
      '0. Definitions.',
      '17. Interpretation of Sections 15 and 16.',
      'END OF TERMS AND CONDITIONS',
      'How to Apply These Terms to Your New Programs',
      '<https://www.gnu.org/licenses/>.',
    ]) {
      expect(text, `LICENSE 缺少 GPLv3 原文标记：${marker}`).toContain(marker);
    }
    // 17 条条款一条都不能少
    for (let i = 0; i <= 17; i += 1) {
      expect(text, `LICENSE 缺少第 ${i} 条`).toMatch(new RegExp(`^\\s*${i}\\. `, 'm'));
    }
    // 不能混进 GPLv2 的东西
    expect(text).not.toContain('Version 2, June 1991');
    // 原文是 674 行 / 35149 字节（gnu.org 版）；改了就必须重新核对上游
    expect(text.split('\n').length - 1, 'LICENSE 行数变了').toBe(674);
  });

  it('sha256 未被改动（改这个常量前请先与 gnu.org 重新对拍）', () => {
    // 出处：https://www.gnu.org/licenses/gpl-3.0.txt
    // 之所以锁哈希：GPL 原文写着 "changing it is not allowed"，
    // 而"顺手润色一下排版"是这类文件最常见的破坏方式。
    const sha = createHash('sha256').update(read(licensePath)).digest('hex');
    expect(sha).toBe('3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986');
  });
});

describe('每个 workspace 包都声明了许可', () => {
  const manifests = [
    ['仓库根', join(ROOT, 'package.json')],
    ['apps/desktop', join(APP, 'package.json')],
    ['packages/pi-protocol', join(ROOT, 'packages', 'pi-protocol', 'package.json')],
    ['packages/piggy-bridge', join(ROOT, 'packages', 'piggy-bridge', 'package.json')],
  ] as const;

  for (const [name, path] of manifests) {
    it(`${name} 的 license = ${SPDX}`, () => {
      expect(readJson(path).license, `${name} 的 package.json 没写 license`).toBe(SPDX);
    });
  }

  it('Rust crate 的 license 与之一致', () => {
    const cargo = read(join(APP, 'src-tauri', 'Cargo.toml'));
    expect(cargo).toMatch(new RegExp(`^license\\s*=\\s*"${SPDX}"`, 'm'));
  });

  it('README 里说明了授权（不然只有 LICENSE 文件，人看不到）', () => {
    const readme = read(join(ROOT, 'README.md'));
    expect(readme).toContain('## 授权');
    // "or later" 必须由**项目自己的声明**表达（LICENSE 只写 v3，不写 or-later）
    expect(readme).toContain('GPL-3.0-or-later');
    expect(readme).toContain('任何更新版本');
    expect(readme).toContain('Copyright (C) 2026 wxk6b1203');
  });
});

describe('随分发携带的第三方声明', () => {
  const piLicense = join(APP, 'src-tauri', 'resources', 'pi-LICENSE.txt');

  it('pi 的 MIT 声明副本在仓库里，且正文是上游原文', () => {
    expect(existsSync(piLicense), 'resources/pi-LICENSE.txt 不见了').toBe(true);
    const text = read(piLicense);
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2025 Mario Zechner');
    // MIT 的关键句：声明必须随"所有副本或实质部分"一起给
    expect(text).toContain(
      'The above copyright notice and this permission notice shall be included in all',
    );
  });

  it('两个 SKU 的 bundle.resources 都登记了它（full 还会捆 pi 本体）', () => {
    for (const conf of ['tauri.conf.json', 'tauri.full.conf.json']) {
      const c = readJson(join(APP, 'src-tauri', conf));
      const resources = (c.bundle as { resources: string[] }).resources;
      expect(resources, `${conf} 的 bundle.resources 少了 pi 的许可`).toContain(
        'resources/pi-LICENSE.txt',
      );
    }
    // full SKU 必须真的把 pi 打进包里（否则"捆绑 pi"是句空话）
    const full = readJson(join(APP, 'src-tauri', 'tauri.full.conf.json'));
    expect((full.bundle as { resources: string[] }).resources).toContain('resources/pi/**/*');
  });

  it('THIRD_PARTY_NOTICES 登记了 pi 与 DSH（两个真正的上游来源）', () => {
    const notices = read(join(ROOT, 'THIRD_PARTY_NOTICES.md'));
    for (const name of ['## pi（', '## DeepSeek Harness（', 'Mario Zechner', 'Copyright (c) 2026 DeepSeek']) {
      expect(notices, `THIRD_PARTY_NOTICES 缺少 ${name}`).toContain(name);
    }
  });
});
