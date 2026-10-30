import path from 'node:path'
import { createLogger } from './logger'

const log = createLogger('open')

/**
 * 「用编辑器打开这个工程」请求的等待队列。
 *
 * 触发来源有三种，时机完全不同：
 * - macOS 双击 / 拖到 Dock 图标 → `open-file` 事件（**可能在 ready 之前**就到达）；
 * - Windows / Linux 双击 → 启动参数里带文件路径；
 * - 程序已在运行时再次双击 → `second-instance` 的 argv。
 *
 * 渲染层可能还没挂载（首启双击就是这样），所以路径先在这里排队，等渲染层
 * 调 `app:consumeOpenRequests` 时一并取走；渲染层已就绪则直接推事件，不再排队，
 * 避免同一次打开被执行两遍。
 */
const pending: string[] = []
let rendererReady = false

/** 从命令行参数里挑出工程文件（双击打开时路径就在 argv 里） */
export function findProjectArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!/\.(hao2dproj|hao2d\.proj)$/i.test(arg)) continue
    // dev 下 argv 里可能混着 `.`、相对路径：只接受绝对路径，避免把 Electron 的参数当文件
    if (!path.isAbsolute(arg)) continue
    return arg
  }
  return null
}

export function queueOpenProject(filePath: string): void {
  if (!filePath) return
  if (pending.includes(filePath)) return
  pending.push(filePath)
  // 只留最近 8 条：连点一堆文件时不该无限攒（打开最后一个是用户真正的意图）
  if (pending.length > 8) pending.splice(0, pending.length - 8)
  log.info(`排队打开工程：${filePath}`)
}

/** 渲染层就绪标记 + 取走排队中的请求（之后新请求改走事件推送） */
export function markRendererReady(): string[] {
  rendererReady = true
  return pending.splice(0, pending.length)
}

export function isRendererReady(): boolean {
  return rendererReady
}

/** 渲染层重新加载（HMR / 刷新）后要继续用事件推送，但队列已清空，这里只重置标记 */
export function resetRendererReady(): void {
  rendererReady = false
}
