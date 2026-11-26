import { BrowserWindow } from 'electron'
import { FSWatcher, watch } from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipcTypes'
import type { AssetsChangedPayload } from '@shared/ipcTypes'
import { createLogger } from './logger'
import { assertSafePath } from './fileService'

const log = createLogger('assets')

/** 监视器 + 去抖定时器：项目目录变化时先关掉旧的，避免多个 watcher 同时回调 */
let watcher: FSWatcher | null = null
let parentWatcher: FSWatcher | null = null
let notifyTimer: NodeJS.Timeout | null = null
let watchedDir: string | null = null

/** fs.watch 在保存时会连发 rename/change；合并成一次通知，渲染层再按目录对账 */
const NOTIFY_DELAY_MS = 250

function closeWatchers(): void {
  watcher?.close()
  parentWatcher?.close()
  watcher = null
  parentWatcher = null
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
}

function notify(dir: string): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    const payload: AssetsChangedPayload = { dir }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.assetsChanged, payload)
    }
  }, NOTIFY_DELAY_MS)
}

/**
 * 开始 / 停止监视项目的 `images/` 目录。
 *
 * 同时监视工程目录本身：`images/` 可能是保存时才创建的（新工程第一次保存），
 * 只盯 `images/` 就会漏掉「目录从无到有」这一次变化。
 * 渲染层收到通知后只做一件事：重新 listDir + 与 `document.images` 对账（见 assetFolderSync）。
 */
export function watchAssetsDir(dir: string | null): void {
  closeWatchers()
  watchedDir = null
  if (!dir) return
  let target: string
  try {
    target = assertSafePath(dir)
  } catch (error) {
    log.warn(`拒绝监视非法资源目录：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  watchedDir = target

  const onChanged = (): void => notify(target)
  try {
    watcher = watch(target, { persistent: false }, onChanged)
    watcher.on('error', (error) => log.warn(`资源目录监视失败（${target}）：${error.message}`))
  } catch (error) {
    // 目录还不存在：只监视父目录，等它创建出来再由父 watcher 重新挂上
    log.info(`资源目录尚不存在，改盯父目录：${target}`)
  }
  try {
    const parent = path.dirname(target)
    const basename = path.basename(target)
    parentWatcher = watch(parent, { persistent: false }, (_event, filename) => {
      if (filename === null || path.basename(String(filename)) !== basename) return
      // 目录刚创建 / 被改名：重建子 watcher，让之后的图片变化继续可见
      if (!watcher) {
        try {
          watcher = watch(target, { persistent: false }, onChanged)
          watcher.on('error', (error) => log.warn(`资源目录监视失败（${target}）：${error.message}`))
        } catch {
          return
        }
      }
      notify(target)
    })
    parentWatcher.on('error', (error) => log.warn(`工程目录监视失败（${parent}）：${error.message}`))
  } catch (error) {
    log.warn(`无法监视工程目录（${path.dirname(target)}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 退出前释放 watcher，别让 Electron 卡在退出流程 */
export function closeAssetWatcher(): void {
  closeWatchers()
  watchedDir = null
}

export function currentAssetWatchDir(): string | null {
  return watchedDir
}
