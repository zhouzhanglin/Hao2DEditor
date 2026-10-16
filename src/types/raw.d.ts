/**
 * vite 的 `?raw` 导入声明（构建期把文件原样内联成字符串）。
 *
 * AI 文档（docs/*.md）走这条路编译进 bundle：打包安装后零磁盘依赖，
 * 不再需要 extraResources 副本与「运行时读文件」的 IPC 链。
 * 两个 tsconfig 的 types 只有 node，vite/client 未引入，所以这里手工声明。
 */
declare module '*?raw' {
  const content: string
  export default content
}
