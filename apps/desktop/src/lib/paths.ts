/**
 * 路径字符串处理（前端）。
 *
 * **为什么要专门一个模块**：Rust 侧传给界面的路径是**平台原生**的
 * （`PathBuf::to_string_lossy()`），Windows 上就是 `C:\Users\x\proj`。
 * 而界面里到处是 `p.split('/')` 这种"只认正斜杠"的写法，
 * 于是 Windows 上：项目分组标题变成**整条路径**、标签页标题变成整条路径、
 * Monaco 认不出 `Makefile`（没有语言高亮）。
 *
 * 判定规则（Rust `Path::components` 的最小近似）：分隔符 = `/` 或 `\`。
 * POSIX 上 `\` 本来是合法文件名字符，但 Piggy 里的路径都来自 pi 与系统选择器，
 * 不存在这种文件名，所以统一两边都认——漏掉 Windows 才是真出问题。
 */

/** 最后一个分隔符的下标（`/` 或 `\`），没有则 -1。 */
export function lastSeparator(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
}

/** 去掉末尾分隔符后的长度（`/a/b/` → 4；`/` → 0）。 */
function trimmedLength(p: string): number {
  let end = p.length;
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return end;
}

/** 取路径最后一段（basename）。末尾分隔符忽略：`/a/b/` → `b`。 */
export function baseName(p: string): string {
  const end = trimmedLength(p);
  if (end === 0) return '';
  const cut = lastSeparator(p.slice(0, end));
  return p.slice(cut + 1, end);
}

/** 拆成 `{ dir, name }`；`dir` 保留末尾分隔符（界面要把目录部分灰显）。 */
export function splitPath(p: string): { dir: string; name: string } {
  const end = trimmedLength(p);
  if (end === 0) return { dir: p, name: '' };
  const cut = lastSeparator(p.slice(0, end));
  if (cut < 0) return { dir: '', name: p };
  return { dir: p.slice(0, cut + 1), name: p.slice(cut + 1, end) };
}

/** 是不是绝对路径（POSIX 的 `/`、Windows 的 `C:\` 与 UNC 的 `\\`）。 */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 把工具参数里的路径解析成**绝对路径**。
 *
 * 工具参数里的路径两种都可能出现：`src/stores/messages.ts`（相对会话 cwd）与
 * `/tmp/render-test.py`（绝对）。预览面板读文件用的是绝对路径，所以这里补一层解析。
 *
 * @param cwd - 会话工作目录；拿不到时只能原样返回（预览会报"读不到"）
 * @param path - 工具参数里的路径
 */
export function resolveAgainst(cwd: string | null | undefined, path: string): string {
  if (!path) return path;
  if (isAbsolutePath(path)) return path;
  if (!cwd) return path;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return cwd.replace(/[\\/]+$/, '') + sep + path.replace(/^\.?[\\/]/, '');
}
