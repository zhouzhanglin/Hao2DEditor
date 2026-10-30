/**
 * 状态栏提示的**类型规范**。
 *
 * 状态栏原来只收字符串，于是「已保存」和「没目标骨骼，约束不会生效」长得一模一样 ——
 * 后者是需要被注意的，却和流水账一个颜色。这里把「说什么」和「有多要紧」分开：
 *
 * - `info`：做完了什么（默认档；老代码直接传字符串就是这一档，不用改）
 * - `warn`：操作被拒 / 有条件没满足（例：先选中骨骼、锁定不能删、缺目标不会生效）
 * - `error`：执行失败（例：保存 / 打开 / 导入抛错）
 *
 * 判定口径：**用户以为做了、实际没做** → `warn`；**我们该做而没做成** → `error`。
 * 其余（成功、进度、当前状态）一律 `info`。
 */
export type StatusLevel = 'info' | 'warn' | 'error'

export interface StatusMessage {
  text: string
  level: StatusLevel
}

/**
 * 上报状态的函数签名。
 *
 * 收 `string` 就够的地方继续收字符串（当 `info`）；要橙色 / 红色时才传对象 ——
 * 这样几十个既有调用点不必一次性改完，新写的代码也能立刻用上分级。
 */
export type StatusReporter = (message: string | StatusMessage) => void

/** 统一收敛成一种形状：状态栏只处理 `StatusMessage`，不必到处 `typeof` 判断 */
export function toStatusMessage(message: string | StatusMessage): StatusMessage {
  return typeof message === 'string' ? { text: message, level: 'info' } : message
}

export const statusInfo = (text: string): StatusMessage => ({ text, level: 'info' })
export const statusWarn = (text: string): StatusMessage => ({ text, level: 'warn' })
export const statusError = (text: string): StatusMessage => ({ text, level: 'error' })
