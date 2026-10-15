import { app } from 'electron'
import { labelsFor, normalizeLocale, type Locale, type MenuLabels } from './menuLabels'

/**
 * 主进程侧的语言状态。
 *
 * 主进程与渲染进程各自持有「当前语言」：
 * - 主进程在启动时按系统语言（`app.getLocale()`）决定初始菜单文案；
 * - 渲染进程读自己的 localStorage 存档（用户上次的选择），启动后通过 IPC 把结果同步过来，
 *   主进程据此重建菜单（见 `ipc.ts` 的 `i18n:setLocale`）。
 *
 * 之所以不复用渲染进程的 `src/i18n`，是因为它依赖 React / DOM，打包进主进程不合适；
 * 文案数据本身放在 `./menuLabels`（纯数据，便于单测），这里只管状态与系统语言探测。
 */
export type { Locale, MenuLabels }
export { labelsFor, normalizeLocale }

let current: Locale = 'zh-CN'

export function getLocale(): Locale {
  return current
}

export function setLocale(next: Locale): void {
  current = next
}

/** 操作系统语言（Electron 的 app locale，默认跟随系统） */
export function systemLocale(): Locale {
  return normalizeLocale(app.getLocale())
}

/** 当前语言对应的菜单文案 */
export function menuLabels(): MenuLabels {
  return labelsFor(current)
}
