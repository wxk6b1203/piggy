/**
 * 产物新鲜度门禁：`apps/desktop/src-tauri/resources/piggy-bridge.js` 必须与
 * `src/index.ts` 的当前内容一致。
 *
 * 存在的理由：资源文件是**被 pi 实际加载**的那份代码，源码只是它的来源。
 * 一旦两者漂移，测试全绿而用户跑的是旧逻辑——本仓库已经出过一次同类事故
 * （陈旧副本静默覆盖了新实现）。所以这里把它变成会红的测试。
 */
import { describe, expect, it } from 'vitest';
import { isArtifactFresh, OUT_FILE } from '../scripts/build.mjs';

describe('piggy-bridge 产物', () => {
  it('与 src/index.ts 一致（过期请运行 pnpm build:bridge）', async () => {
    const result = await isArtifactFresh();
    const detail = result.fresh ? '' : result.reason;
    expect(result.fresh, `${detail}\n产物路径：${OUT_FILE}`).toBe(true);
  });
});
