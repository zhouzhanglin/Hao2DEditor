import { app, Menu, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipcTypes'
import { IPC } from '@shared/ipcTypes'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuCommand, command)
}

const item = (
  label: string,
  command: MenuCommand,
  accelerator?: string
): MenuItemConstructorOptions => ({
  label,
  accelerator,
  click: () => send(command)
})

export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      item('新建工程', 'project:new', 'CmdOrCtrl+N'),
      item('打开工程…', 'project:open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      item('保存', 'project:save', 'CmdOrCtrl+S'),
      item('另存为…', 'project:saveAs', 'CmdOrCtrl+Shift+S'),
      { type: 'separator' },
      item('导入 Spine…', 'project:importSpine'),
      item('导入 DragonBones…', 'project:importDragonBones'),
      item('导入图片…', 'project:importImages', 'CmdOrCtrl+I'),
      { type: 'separator' },
      item('导出运行时数据…', 'project:exportRuntime', 'CmdOrCtrl+E'),
      item('导出 .hao2d…', 'project:exportHao2d', 'CmdOrCtrl+Shift+E'),
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      item('撤销', 'edit:undo', 'CmdOrCtrl+Z'),
      item('重做', 'edit:redo', 'CmdOrCtrl+Shift+Z'),
      { type: 'separator' },
      item('删除', 'edit:delete', 'Delete'),
      item('复制', 'edit:duplicate', 'CmdOrCtrl+D'),
      item('全选', 'edit:selectAll', 'CmdOrCtrl+A')
    ]
  }

  const animMenu: MenuItemConstructorOptions = {
    label: '动画',
    submenu: [
      item('播放 / 暂停', 'anim:playPause', 'Space'),
      item('上一帧', 'anim:prevFrame', 'Left'),
      item('下一帧', 'anim:nextFrame', 'Right'),
      { type: 'separator' },
      item('为选中项打关键帧', 'anim:keySelected', 'K')
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      item('适配视野', 'view:fitViewport', 'F'),
      item('重置面板布局', 'view:resetLayout'),
      { type: 'separator' },
      { role: 'reload', label: '重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' }
    ]
  }

  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Hao2D Editor' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }
  template.push(fileMenu, editMenu, animMenu, viewMenu)

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
