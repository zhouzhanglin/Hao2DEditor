import { BrowserWindow, ipcMain, shell } from 'electron'
import { FILE_SCHEME } from './protocol'
import * as fs from './fileService'
import {
  startPreviewSession,
  stopPreviewSession,
  startHao2dPreview,
  stopHao2dPreview
} from './previewServer'
import { IPC } from '@shared/ipcTypes'
import type {
  BatchFile,
  Hao2dPreviewSession,
  OpenDialogOptions,
  SaveDialogOptions,
  SpinePreviewSession
} from '@shared/ipcTypes'

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** 用系统默认程序打开链接；只认 http(s) */
async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的链接：${url}`)
  }
  await shell.openExternal(parsed.toString())
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.openDialog, (_e, options: OpenDialogOptions | undefined) =>
    fs.safe(() => fs.openDialog(focusedWindow(), options ?? {}))
  )

  ipcMain.handle(IPC.saveDialog, (_e, options: SaveDialogOptions | undefined) =>
    fs.safe(() => fs.saveDialog(focusedWindow(), options ?? {}))
  )

  ipcMain.handle(IPC.readText, (_e, p: string) => fs.safe(() => fs.readText(p)))
  ipcMain.handle(IPC.readBinary, (_e, p: string) => fs.safe(() => fs.readBinary(p)))
  ipcMain.handle(IPC.writeText, (_e, p: string, text: string) =>
    fs.safe(() => fs.writeText(p, text))
  )
  ipcMain.handle(IPC.writeBinary, (_e, p: string, bytes: Uint8Array) =>
    fs.safe(() => fs.writeBinary(p, bytes))
  )
  ipcMain.handle(IPC.writeBatch, (_e, files: BatchFile[]) => fs.safe(() => fs.writeBatch(files)))
  ipcMain.handle(IPC.listDir, (_e, dir: string, recursive: boolean) =>
    fs.safe(() => fs.listDir(dir, Boolean(recursive)))
  )
  ipcMain.handle(IPC.exists, (_e, p: string) => fs.safe(() => fs.pathExists(p)))
  ipcMain.handle(IPC.imageInfo, (_e, paths: string[]) => fs.safe(() => fs.imageInfo(paths)))
  ipcMain.handle(IPC.registerAssetRoot, (_e, dir: string) =>
    fs.safe(() => fs.registerAssetRootFor(dir))
  )

  ipcMain.handle(IPC.recentList, () => fs.safe(() => fs.recentList()))
  ipcMain.handle(IPC.recentAdd, (_e, p: string) => fs.safe(() => fs.recentAdd(p)))
  ipcMain.handle(IPC.revealInFolder, (_e, p: string) => fs.safe(() => fs.revealInFolder(p)))

  ipcMain.handle(IPC.setTitle, (_e, title: string) =>
    fs.safe(() => {
      focusedWindow()?.setTitle(typeof title === 'string' && title.length > 0 ? title : 'Hao2D Editor')
    })
  )

  // 渲染层要加载本地图片时，把它的目录登记为资源根
  ipcMain.handle(`${FILE_SCHEME}:allow`, (_e, dir: string) =>
    fs.safe(() => fs.registerAssetRootFor(dir))
  )

  // 在线预览：起本地网页服务（spine.js 运行时播放），地址不变、可反复替换资源
  ipcMain.handle(IPC.spinePreviewStart, (_e, session: SpinePreviewSession, open: boolean) =>
    fs.safe(() => startPreviewSession(session, Boolean(open)))
  )
  ipcMain.handle(IPC.spinePreviewStop, () => fs.safe(() => stopPreviewSession()))

  // 在线预览：导出运行时预览（hao2d 计算方式 + pixi.js 渲染），地址不变、可反复替换资源
  ipcMain.handle(IPC.hao2dPreviewStart, (_e, session: Hao2dPreviewSession, open: boolean) =>
    fs.safe(() => startHao2dPreview(session, Boolean(open)))
  )
  ipcMain.handle(IPC.hao2dPreviewStop, () => fs.safe(() => stopHao2dPreview()))

  // 在线预览的「在浏览器打开」：只放行 http(s)，别让渲染层的字符串借系统去执行别的东西
  ipcMain.handle(IPC.openExternal, (_e, url: string) => fs.safe(() => openExternal(url)))
}
