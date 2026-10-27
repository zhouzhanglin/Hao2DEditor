/**
 * 运行库（预览播放器）专用的 `@i18n` 替身。
 *
 * 为什么需要它：`src/core` 与 `src/render` 里有若干**返回给编辑器看的提示文本**走 `t()`
 * （混合模式降级、嵌套骨架校验、编解码报错等），而运行库是 `scripts/build-hao2d-runtime.mjs`
 * 用 esbuild 单独打的 IIFE 包。如果让它解析到真正的 `@i18n`：
 * - 会把 `react`（`useSyncExternalStore`）拖进播放器 —— 播放器根本不用 React；
 * - 还会把中英两份完整词典一起打进去，包体白涨一大截。
 *
 * 所以那个脚本把 `@i18n` 指到这里：`t()` 原样返回词条 key（本项目的 key 就是中文原文），
 * 插值规则与正式实现一致，只是不做翻译 —— 播放器里没有语言切换，也就没有翻译的必要。
 */
export type TParams =
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean

/** 与 `@i18n` 同签名，但恒等返回（中文原文） */
export function t(key: string, params?: TParams): string {
  if (params === undefined) return key
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const map = params as Record<string, unknown>
    return key.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = map[name]
      return value === undefined ? match : String(value)
    })
  }
  const list = Array.isArray(params) ? params : [params]
  return key.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = list[Number(index)]
    return value === undefined ? match : String(value)
  })
}
