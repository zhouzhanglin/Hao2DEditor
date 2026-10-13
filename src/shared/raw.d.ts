/**
 * Vite 的 `?raw` 后缀：把文件内容当字符串内联进产物。
 * 在线预览页（preview/page.html、preview/app.js）与 spine 官方运行时源码都靠它打进主进程包。
 */
declare module '*?raw' {
  const content: string
  export default content
}
