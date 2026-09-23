/**
 * monaco-editor 的 exports map 是 `"./*": "./esm/vs/*.js"`，
 * 因此**规范说明符**是 `monaco-editor/editor/editor.api`（而不是 `monaco-editor/esm/vs/...`：
 * 后者会被重写成 `esm/vs/esm/vs/...`，即 docs/13 E6 记的双写问题）。
 * 用规范说明符后类型可直接从包声明解析，本 shim 不再需要。
 *
 * 保留本文件仅作为上述结论的书面记录；如无引用可安全删除。
 */
export {};
