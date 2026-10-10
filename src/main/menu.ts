import { app, Menu, BrowserWindow } from 'electron'
import { buildMenuTemplate } from './menuTemplate'
import { IPC } from '@shared/ipcTypes'
import type { MenuCommand } from '@shared/ipcTypes'

/** 把菜单命令发给当前窗口的渲染进程（菜单项本身不做事，逻辑都在渲染端） */
function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuCommand, command)
}

export function buildAppMenu(): void {
  const template = buildMenuTemplate({
    appName: app.name,
    isMac: process.platform === 'darwin',
    dispatch: send
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
