// monaco-editor 的 exports map 使 esm 子路径的 TS 类型不可达（./* 目标重写错误），
// 运行时 vite 可正常解析；这里给出精确的类型面（WP5 schema 接入时按需扩充）。
declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  import * as monaco from 'monaco-editor';
  export = monaco;
}
declare module 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
