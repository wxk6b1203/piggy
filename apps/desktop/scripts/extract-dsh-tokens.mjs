/**
 * 从 DSH 源码抽取设计 token 的解析值（亮/暗两套），用于生成 Piggy 的 tokens.css。
 * 只读：不修改 DSH 仓库。
 *
 * 用法：node scripts/extract-dsh-tokens.mjs <design-platform.css> [out.json]
 *
 * 该文件里 `body {}` 与 `body[data-ds-dark-theme] {}` **各出现两次**
 * （先静态调色板、后语义 alias），因此必须取全部同名块合并，不能只取第一个。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
const out = process.argv[3];
if (!src) {
  console.error('用法: node extract-dsh-tokens.mjs <design-platform.css> [out.json]');
  process.exit(2);
}
const css = readFileSync(src, 'utf8');

/** 收集 selector 的**全部**块体并拼接。 */
function allBlocks(sel) {
  let acc = '';
  let from = 0;
  for (;;) {
    const i = css.indexOf(sel, from);
    if (i < 0) break;
    let depth = 0;
    let j = css.indexOf('{', i);
    const start = j;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    acc += `\n${css.slice(start + 1, j)}`;
    from = j + 1;
  }
  return acc;
}

const light = allBlocks('body {');
const dark = allBlocks('body[data-ds-dark-theme] {');

// 静态调色板（明暗同值，两处都声明）
const statics = {};
for (const m of css.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  statics[m[1]] ??= m[2].trim();
}

/** 递归解析 var() 到字面值。 */
function resolve(v, depth = 0) {
  if (depth > 6) return v.trim();
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v.trim());
  if (!m) return v.trim();
  return statics[m[1]] ? resolve(statics[m[1]], depth + 1) : v.trim();
}

/** 逐字列出需要的 token 全名（不做前缀猜测——DSH 里 alias/specific/markdown 前缀并不统一）。 */
const TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-link',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-brand-primary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-sidebar-nav-item-active',
  '--dsw-specific-sidebar-nav-item-hover',
  '--dsw-specific-input-major',
  '--dsw-specific-selector',
  '--dsw-specific-bubble',
  '--dsw-specific-menu',
  '--dsw-specific-tip',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-tooltip-bg',
  '--dsw-alias-toast-bg',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
];

function grab(blockText) {
  const found = {};
  const missing = [];
  for (const name of TOKENS) {
    const re = new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`);
    const m = re.exec(blockText);
    if (m) found[name] = resolve(m[1]);
    else missing.push(name);
  }
  return { found, missing };
}

const L = grab(light);
const D = grab(dark);

const show = (title, r) => {
  console.log(`\n=== ${title} ===`);
  for (const [k, v] of Object.entries(r.found)) console.log(`  ${k.replace('--dsw-', '').padEnd(44)} ${v}`);
  if (r.missing.length) console.log(`  [未定义] ${r.missing.join(', ')}`);
};
show('DARK', D);
show('LIGHT', L);

if (out) {
  writeFileSync(out, JSON.stringify({ dark: D.found, light: L.found }, null, 2), 'utf8');
  console.log(`\n已写出 ${out}`);
}
