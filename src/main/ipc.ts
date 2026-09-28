import { BrowserWindow, ipcMain } from 'electron'
import { FILE_SCHEME } from './protocol'
import * as fs from './fileService'
import { IPC } from '@shared/ipcTypes'
import type { BatchFile, OpenDialogOptions, SaveDialogOptions } from '@shared/ipcTypes'

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
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
}
