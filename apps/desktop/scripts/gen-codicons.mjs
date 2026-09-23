/**
 * 从 @vscode/codicons 的 metadata.json 生成合法图标名的字面量联合类型。
 *
 * 为什么需要：图标名是字符串，拼错时 TypeScript 与运行期都不报错，
 * 只会静默渲染成空白——正是"页面看着不对但控制台干净"这类问题的来源。
 * 收窄成联合类型后，拼错立刻是编译错误。
 *
 * 用法：pnpm --filter @piggy/desktop icons:gen
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');

const metaPath = require.resolve('@vscode/codicons/dist/metadata.json', { paths: [pkgDir] });
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const names = Object.keys(meta).sort();

const header = `/**
 * 自动生成，请勿手改。由 @vscode/codicons 的 metadata.json 导出全部合法图标名。
 * 重新生成：pnpm --filter @piggy/desktop icons:gen
 *
 * 存在的意义：图标名是字符串，写错时 TypeScript 与运行期都不会报错，
 * 只会静默渲染成空白方块。收窄成字面量联合后，拼错即是编译错误。
 */
`;

const body =
  'export const CODICON_NAMES = [\n' +
  names.map((n) => `  ${JSON.stringify(n)},`).join('\n') +
  '\n] as const;\n\nexport type IconName = (typeof CODICON_NAMES)[number];\n';

const out = join(pkgDir, 'src/features/common/codicon-names.ts');
writeFileSync(out, header + body, 'utf8');
console.log(`已生成 ${names.length} 个图标名 → ${out}`);
