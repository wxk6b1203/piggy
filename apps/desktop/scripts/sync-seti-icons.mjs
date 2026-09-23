/**
 * 从 VS Code 源码同步 Seti 文件图标（docs/13 §7 排名 #8）。
 *
 * 产出：
 *   src/assets/seti.woff              图标字体（原样拷贝）
 *   src/features/common/seti-icons.ts 扩展名/文件名 → 字形+颜色的映射
 *
 * 用法：
 *   node scripts/sync-seti-icons.mjs [VSCODE_REF]
 *   默认 VSCODE_REF=/Users/wxk/Documents/Project/vscode
 *
 * 许可：seti-ui，MIT，Copyright (c) 2014 Jesse Weed（署名见 THIRD_PARTY_NOTICES.md）。
 * 说明：docs/13 E2 更正——Seti 是 **WOFF 字体**不是 SVG，所以"取 SVG 子集"不可行，整体 vendor。
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const VSCODE_REF = process.argv[2] ?? '/Users/wxk/Documents/Project/vscode';
const SRC_DIR = join(VSCODE_REF, 'extensions/theme-seti');

const themePath = join(SRC_DIR, 'icons/vs-seti-icon-theme.json');
const fontPath = join(SRC_DIR, 'icons/seti.woff');

for (const p of [themePath, fontPath]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p}\n请传入 VS Code 检出根目录：node scripts/sync-seti-icons.mjs <VSCODE_REF>`);
    process.exit(2);
  }
}

const theme = JSON.parse(readFileSync(themePath, 'utf8'));
const defs = theme.iconDefinitions ?? {};
const extensions = theme.fileExtensions ?? {};
const fileNames = theme.fileNames ?? {};
const languageIds = theme.languageIds ?? {};
const defaultFile = theme.file ?? '_file';

/**
 * Seti 的 fontCharacter 是**字面转义串**（如 `"\\E001"`，5 个字符：反斜杠 E 0 0 1），
 * 不是真正的 Unicode 字符。直接塞进 DOM 会渲染成 "E001" 这串文字，
 * 必须解析成码点再转成字符。
 */
function toGlyph(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^\\([0-9a-fA-F]{1,6})$/.exec(raw.trim());
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  // 已是真字符（或普通字符串）时原样返回
  return raw.length > 0 ? raw : null;
}

/** 只保留渲染需要的两列，并压掉未使用/空字形。 */
const compactDefs = {};
for (const [key, d] of Object.entries(defs)) {
  const glyph = toGlyph(d?.fontCharacter);
  if (!glyph) continue;
  compactDefs[key] = d.fontColor ? { c: glyph, f: d.fontColor } : { c: glyph };
}

// 字体落地
const assetsDir = join(pkgDir, 'src/assets');
mkdirSync(assetsDir, { recursive: true });
copyFileSync(fontPath, join(assetsDir, 'seti.woff'));

const banner = `/**
 * 自动生成，请勿手改。由 VS Code 的 Seti 图标主题导出。
 * 重新生成：pnpm --filter @piggy/desktop icons:seti
 *
 * 来源：${'extensions/theme-seti/icons/vs-seti-icon-theme.json'}
 * 许可：seti-ui，MIT，Copyright (c) 2014 Jesse Weed（见 THIRD_PARTY_NOTICES.md）
 */`;

const q = (s) => JSON.stringify(s);
const mapBody = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `  ${q(k)}: ${q(v)},`)
    .join('\n');

const out = `${banner}

/** 字形 + 颜色；键名与 Seti 的 iconDefinitions 一致。 */
export interface SetiDef {
  /** 字体码点（已是可直接渲染的字符） */
  c: string;
  /** 十六进制颜色；缺省时继承当前文字色 */
  f?: string;
}

export const SETI_DEFS: Record<string, SetiDef> = {
${Object.entries(compactDefs)
  .map(([k, v]) => `  ${q(k)}: { c: ${q(v.c)}${v.f ? `, f: ${q(v.f)}` : ''} },`)
  .join('\n')}
};

/** 扩展名（小写，不含点）→ 图标键 */
export const SETI_EXT: Record<string, string> = {
${mapBody(extensions)}
};

/** 完整文件名（小写）→ 图标键 */
export const SETI_NAME: Record<string, string> = {
${mapBody(fileNames)}
};

/** 语言 id → 图标键（Monaco/文件树按语言回退时用） */
export const SETI_LANG: Record<string, string> = {
${mapBody(languageIds)}
};

/** 默认文件图标键 */
export const SETI_FILE = ${q(defaultFile)};
`;

const outPath = join(pkgDir, 'src/features/common/seti-icons.ts');
writeFileSync(outPath, out, 'utf8');

console.log(`Seti 同步完成：
  defs    ${Object.keys(compactDefs).length}
  ext     ${Object.keys(extensions).length}
  names   ${Object.keys(fileNames).length}
  langs   ${Object.keys(languageIds).length}
  font    src/assets/seti.woff
  模块    src/features/common/seti-icons.ts (${(out.length / 1024).toFixed(1)} KB)`);
