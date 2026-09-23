# full SKU：捆绑 pi standalone

`tauri.full.conf.json` 是 `tauri.conf.json` 的**增量覆盖**（`tauri build --config` 深合并）。
它只能是纯 JSON —— tauri 的配置 schema 是 `additionalProperties: false`，
写 `$comment` 之类的额外键会直接让构建失败（本文件此前就是这样，从未真正构建成功过）。
所以说明放在这里。

## 构建

```bash
cd apps/desktop
node scripts/fetch-pi-standalone.mjs          # 下载并落位 pi 到 src-tauri/resources/pi/
pnpm tauri build --config src-tauri/tauri.full.conf.json --bundles app
```

默认（lite）SKU 用 `tauri.conf.json`，不捆绑 pi，只需要系统上有一个 `pi`。

## 两条必须遵守的规则

### 1. `resources` 要把基础配置的项**原样重复**一遍

tauri 的 `--config` 是深合并，但**数组是整体替换**，不是拼接。基础配置里的
`resources/piggy-guard.js` 如果在这里漏掉，full SKU 就会缺权限守卫脚本 ——
而默认权限档位「工作区内修改」会以 `GUARD_SCRIPT_MISSING` **拒绝启动任何会话**
（`src/pi/process.rs` 的 `spawn_worker`）。这不是"少个可选文件"，是应用不可用。

### 2. pi 那一项用 `**/*` 而不是 `*`

tauri 用 `glob` crate 展开资源通配符（`tauri-utils/src/resources.rs:250`），
而 `glob` 的 `*` **不跨目录分隔符**。pi 是 Bun 单文件可执行，资源按
`dirname(process.execPath)` 解析（`packages/coding-agent/src/config.ts:396-399`），
`export-html/`、`theme/`、`photon_rs_bg.wasm` 都在子目录里。
用 `resources/pi/*` 只会把顶层文件打进包，`pi_export_html` 会在运行期抛异常
（`core/export-html/index.ts:143` 是无保护的 `readFileSync`）。

另外 `glob` **匹配不到任何文件时会直接报错**（`Error::GlobPathNotFound`），
所以没有先跑 `fetch-pi-standalone.mjs` 就构 full SKU 会失败 —— 这是有意的，
比打出一个没有 pi 的包要好。

## 用自定义（fork）的 pi

三条路，按侵入性从低到高：

1. **`PI_STANDALONE_FILE`** —— 指向你自己 `bun build --compile` 出来的产物或
   pi 官方资产，脚本只做校验 + 落位：
   ```bash
   PI_STANDALONE_FILE=~/my-pi/pi-darwin-arm64.tar.gz node scripts/fetch-pi-standalone.mjs
   ```
2. **`PI_STANDALONE_URL`** —— 换成你自己的下载地址模板（占位符 `{VERSION}` `{OS}` `{ARCH}` `{ASSET}`）。
3. **`PI_BIN` 环境变量** —— 运行期覆盖发现链，优先级高于内置二进制
   （`src/pi/discovery.rs`：显式路径 → `PI_BIN` → 内置 → `PATH`）。
   macOS 上 GUI 启动的 `.app` 拿不到 shell 环境变量，所以这条实际只适合开发/QA。

自定义 pi **必须保持**的东西：`--version` 退出码 0、`--mode rpc` 的 JSONL 分帧、
`pi/client.rs` 里用到的那批 RPC 命令、响应信封
`{type:"response",id,command,success,data|error}`、`get_state.sessionFile/sessionId`、
`get_entries.leafId`，以及 `pi/protocol.rs` 里匹配的那批事件 `type` 字面量。
除此之外没有任何版本协商。
