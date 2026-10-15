import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipcTypes'
import type { MenuLabels } from './i18n'

export interface MenuTemplateOptions {
  /** 应用名（macOS 的 app 菜单标题） */
  appName: string
  /** 是否 macOS：决定 app 菜单与「退出」放哪儿 */
  isMac: boolean
  /** 当前语言下的菜单文案（见 main/i18n.ts） */
  labels: MenuLabels
  /** 菜单项点下去之后，把命令派发给渲染进程（由主进程实现） */
  dispatch: (command: MenuCommand) => void
}

/**
 * 应用菜单模板（纯数据，方便单测）。
 *
 * 这里有两个**只在桌面版才会中招**的坑，改菜单时务必留意：
 *
 * 1. **标准编辑角色不能少**：macOS 的 ⌘X / ⌘C / ⌘V / ⌘A 是由**菜单角色**派发给 webview 的
 *    （`cut` / `copy` / `paste` / `selectAll`）。自定义菜单里不挂这几项，输入框里就完全
 *    没法剪切 / 复制 / 粘贴 / 全选 —— Web 版走浏览器默认行为，所以只有打包后的桌面版会出问题。
 *
 * 2. **不带 ⌘ 的快捷键不要注册**：菜单加速键是**全局**的，`Space` / `Delete` / `Left` / `F` / `K`
 *    这类会被系统提前吃掉 —— 在输入框里打空格会变成「播放 / 暂停」、按 Delete 会去删对象。
 *    渲染进程自己已经带「正在输入就跳过」的保护（见 App 的全局 keydown），
 *    所以这里只**显示**提示、不注册（`registerAccelerator: false`，macOS 专用开关）。
 */
export function buildMenuTemplate(options: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const { appName, isMac, labels, dispatch } = options

  /**
   * 普通菜单项：点击 → 把命令发给渲染进程。
   *
   * 纯键加速键（Space / Delete / F / K…）只当提示，不真正注册（见文件头注释 2）：
   * macOS 用 `registerAccelerator: false` 保留提示；其它平台这个开关不生效，
   * 干脆不写加速键 —— 宁可少个提示，也不能让菜单把输入框里的空格 / Delete 抢走。
   */
  const item = (
    label: string,
    command: MenuCommand,
    accelerator?: string
  ): MenuItemConstructorOptions => {
    const plainHint = Boolean(accelerator) && !/Cmd|Ctrl/.test(accelerator as string)
    return {
      label,
      ...(plainHint ? (isMac ? { accelerator, registerAccelerator: false } : {}) : { accelerator }),
      click: () => dispatch(command)
    }
  }

  /**
   * 「设置 / AI 接入」菜单项。
   * macOS 放进 app 菜单（符合系统习惯，偏好设置紧跟「关于」）；
   * 其它平台没有 app 菜单，仍留在文件菜单末尾，避免功能入口丢失。
   */
  const settingsItems: MenuItemConstructorOptions[] = [
    item(labels.settings, 'app:settings', 'CmdOrCtrl+,'),
    item(labels.aiIntegration, 'app:aiIntegration')
  ]

  const fileMenu: MenuItemConstructorOptions = {
    label: labels.file,
    submenu: [
      item(labels.newProject, 'project:new', 'CmdOrCtrl+N'),
      item(labels.openProject, 'project:open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      item(labels.save, 'project:save', 'CmdOrCtrl+S'),
      item(labels.saveAs, 'project:saveAs', 'CmdOrCtrl+Shift+S'),
      { type: 'separator' },
      item(labels.importSpine, 'project:importSpine'),
      item(labels.importDragonBones, 'project:importDragonBones'),
      item(labels.importImages, 'project:importImages', 'CmdOrCtrl+I'),
      item(labels.importPsd, 'project:importPsd'),
      { type: 'separator' },
      item(labels.exportRuntime, 'project:exportRuntime', 'CmdOrCtrl+E'),
      item(labels.exportHao2d, 'project:exportHao2d', 'CmdOrCtrl+Shift+E'),
      item(labels.exportSpine, 'project:exportSpine', 'CmdOrCtrl+Alt+E'),
      { type: 'separator' },
      ...(isMac ? [] : ([...settingsItems, { type: 'separator' }] as MenuItemConstructorOptions[])),
      isMac ? { role: 'close', label: labels.closeWindow } : { role: 'quit', label: labels.quit }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: labels.edit,
    submenu: [
      item(labels.undo, 'edit:undo', 'CmdOrCtrl+Z'),
      item(labels.redo, 'edit:redo', 'CmdOrCtrl+Shift+Z'),
      { type: 'separator' },
      // 拷贝 / 粘贴改成自定义命令：组合键在渲染进程里按上下文分流——
      // 焦点在输入框时走浏览器原生文本复制（见 App 的 edit:copy / edit:paste），
      // 否则复制 / 粘贴层级节点或关键帧。剪切 / 全选仍用标准角色，避免自实现文本编辑。
      item(labels.copy, 'edit:copy', 'CmdOrCtrl+C'),
      item(labels.paste, 'edit:paste', 'CmdOrCtrl+V'),
      item(labels.duplicate, 'edit:duplicate', 'CmdOrCtrl+D'),
      { type: 'separator' },
      { role: 'cut', label: labels.cut },
      { role: 'selectAll', label: labels.selectAll },
      { type: 'separator' },
      item(labels.delete, 'edit:delete', 'Delete')
    ]
  }

  const animMenu: MenuItemConstructorOptions = {
    label: labels.animation,
    submenu: [
      item(labels.playPause, 'anim:playPause', 'Space'),
      item(labels.prevFrame, 'anim:prevFrame', 'Left'),
      item(labels.nextFrame, 'anim:nextFrame', 'Right'),
      { type: 'separator' },
      item(labels.keySelected, 'anim:keySelected', 'K')
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: labels.view,
    submenu: [
      item(labels.fitViewport, 'view:fitViewport', 'F'),
      item(labels.resetLayout, 'view:resetLayout'),
      { type: 'separator' },
      { role: 'reload', label: labels.reload },
      { role: 'toggleDevTools', label: labels.devTools },
      { type: 'separator' },
      { role: 'resetZoom', label: labels.actualSize },
      { role: 'zoomIn', label: labels.zoomIn },
      { role: 'zoomOut', label: labels.zoomOut }
    ]
  }

  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: labels.about.replace('{app}', appName) },
        { type: 'separator' },
        ...settingsItems,
        { type: 'separator' },
        { role: 'hide', label: labels.hide },
        { role: 'hideOthers', label: labels.hideOthers },
        { type: 'separator' },
        { role: 'quit', label: labels.quit }
      ]
    })
  }
  template.push(fileMenu, editMenu, animMenu, viewMenu)

  return template
}
