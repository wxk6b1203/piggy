/**
 * 从 VS Code 源码同步**主题的 tokenColors**，生成 Monaco 可用的语法着色规则。
 *
 * 为什么只要 tokenColors（而不是整套主题）：
 *   docs/13 E4 已查明，主题 JSON 只覆盖 26% 的颜色 id，缺的键要靠颜色注册表默认值补，
 *   而那需要一个 1–1.5 人日的生成管线。**但 tokenColors 不依赖任何默认值层**——
 *   它就是一张 scope → 样式表，可以独立使用。
 *   外壳（chrome）的颜色继续走 DSH 令牌（styles/tokens.css），
 *   这里只解决"Monaco 的语法着色与外壳不搭"这个问题（docs/13 §3.2）。
 *
 * 用法：node scripts/sync-vscode-themes.mjs [VSCODE_REF]
 *
 * 许可：VS Code 内置主题为 MIT（Microsoft）；第三方主题（extensions/theme-<name>）
 * 另有 Colorsublime 署名。本脚本默认只取 theme-defaults（微软自研）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const VSCODE_REF = process.argv[2] ?? '/Users/wxk/Documents/Project/vscode';
const SRC = join(VSCODE_REF, 'extensions/theme-defaults');

/**
 * JSONC → JS 对象。
 * 必须写成状态机：主题文件里有 `"https://…"` 这类字符串，
 * 朴素的 `replace(/\/\/.*$/)` 会把 `//` 之后的内容连字符串一起吃掉（docs/13 E3 的坑）。
 */
function parseJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 1;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // 去尾逗号（同样只在字符串外）
  let cleaned = '';
  inStr = false;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (inStr) {
      cleaned += c;
      if (c === '\\') {
        cleaned += out[i + 1] ?? '';
        i += 1;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cleaned += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') continue; // 丢掉这个逗号
    }
    cleaned += c;
  }
  return JSON.parse(cleaned);
}

/** 解析 include 链（VS Code 主题靠 include 继承，tokenColors 会叠加）。 */
function loadTheme(file, seen = new Set()) {
  if (seen.has(file)) return { tokenColors: [], colors: {} };
  seen.add(file);
  const raw = readFileSync(join(SRC, 'themes', file), 'utf8');
  const theme = parseJsonc(raw);
  let base = { tokenColors: [], colors: {} };
  if (theme.include) {
    const inc = theme.include.replace(/^\.\//, '');
    base = loadTheme(inc, seen);
  }
  return {
    tokenColors: [...base.tokenColors, ...(theme.tokenColors ?? [])],
    colors: { ...base.colors, ...(theme.colors ?? {}) },
  };
}

/**
 * VS Code 的 tokenColor → Monaco 的 `rules` 条目。
 * 差异（docs/13 §3.3）：scope→token；foreground 去掉 `#`；`background` 在 standalone 里
 * 已被标为 deprecated/unsupported，直接丢弃；fontStyle 原样保留。
 */
function toMonacoRules(tokenColors) {
  const rules = [];
  for (const tc of tokenColors) {
    const settings = tc.settings ?? {};
    if (!settings.foreground && !settings.fontStyle) continue;
    const scopes =
      typeof tc.scope === 'string'
        ? tc.scope.split(',').map((s) => s.trim())
        : Array.isArray(tc.scope)
          ? tc.scope.map((s) => String(s).trim())
          : [];
    for (const token of scopes) {
      if (!token) continue;
      const rule = { token };
      if (settings.foreground) rule.foreground = String(settings.foreground).replace(/^#/, '');
      if (settings.fontStyle) {
        const fs = String(settings.fontStyle);
        if (fs.includes('italic')) rule.fontStyle = 'italic';
        if (fs.includes('bold')) rule.fontStyle = rule.fontStyle ? 'bold italic' : 'bold';
        if (fs.includes('underline')) rule.fontStyle = rule.fontStyle ? `${rule.fontStyle} underline` : 'underline';
      }
      if (rule.foreground || rule.fontStyle) rules.push(rule);
    }
  }
  return rules;
}

const WANTED = [
  { file: 'dark_modern.json', id: 'vscode-dark-modern', base: 'vs-dark', label: 'Dark Modern' },
  { file: 'light_modern.json', id: 'vscode-light-modern', base: 'vs', label: 'Light Modern' },
];

const built = [];
for (const w of WANTED) {
  const path = join(SRC, 'themes', w.file);
  if (!existsSync(path)) {
    console.error(`找不到 ${path}`);
    process.exit(2);
  }
  const theme = loadTheme(w.file);
  const rules = toMonacoRules(theme.tokenColors);
  built.push({ ...w, rules, tokenColorCount: theme.tokenColors.length, colorCount: Object.keys(theme.colors).length });
  console.log(`${w.label.padEnd(14)} tokenColors ${String(theme.tokenColors.length).padStart(4)} → rules ${String(rules.length).padStart(4)}  (colors ${Object.keys(theme.colors).length})`);
}

const banner = `/**
 * 自动生成，请勿手改。由 VS Code 内置主题的 \\\`tokenColors\\\` 导出。
 * 重新生成：pnpm --filter @piggy/desktop themes:sync
 *
 * 来源：VS Code \\\`extensions/theme-defaults/themes/{dark,light}_modern.json\\\`（含 include 链）
 * 许可：MIT，Microsoft（见 THIRD_PARTY_NOTICES.md）
 *
 * 仅承载**语法着色**；编辑器外壳颜色仍由 styles/tokens.css 的 DSH 令牌决定。
 */`;

const body = built
  .map(
    (b) => `
/** ${b.label}：${b.tokenColorCount} 条 tokenColors → ${b.rules.length} 条 Monaco rule */
export const ${b.id.replace(/-/g, '_').toUpperCase()}_RULES = ${JSON.stringify(b.rules, null, 2)} as const;`,
  )
  .join('\n');

const meta = `
/** 可用的 VS Code 语法主题（id 必须匹配 /^[a-z0-9-]+$/i，否则 Monaco 的 defineTheme 会抛错）。 */
export const VSCODE_THEMES = ${JSON.stringify(
  built.map((b) => ({ id: b.id, label: b.label, base: b.base })),
  null,
  2,
)} as const;

export type VscodeThemeId = (typeof VSCODE_THEMES)[number]['id'];

/** id → 该主题的 Monaco rules */
export const VSCODE_THEME_RULES: Record<VscodeThemeId, readonly { token: string; foreground?: string; fontStyle?: string }[]> = {
${built.map((b) => `  ${JSON.stringify(b.id)}: ${b.id.replace(/-/g, '_').toUpperCase()}_RULES,`).join('\n')}
};
`;

const outPath = join(pkgDir, 'src/features/common/vscode-theme-tokens.ts');
writeFileSync(outPath, `${banner}\n${body}\n${meta}`, 'utf8');
console.log(`\n已写出 ${outPath}`);
