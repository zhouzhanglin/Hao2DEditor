import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipcTypes'

export interface MenuTemplateOptions {
  /** 应用名（macOS 的 app 菜单标题） */
  appName: string
  /** 是否 macOS：决定 app 菜单与「退出」放哪儿 */
  isMac: boolean
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
  const { appName, isMac, dispatch } = options

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
      item('导出 Unity…', 'project:exportHao2d', 'CmdOrCtrl+Shift+E'),
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
      // 拷贝 / 粘贴改成自定义命令：组合键在渲染进程里按上下文分流——
      // 焦点在输入框时走浏览器原生文本复制（见 App 的 edit:copy / edit:paste），
      // 否则复制 / 粘贴层级节点或关键帧。剪切 / 全选仍用标准角色，避免自实现文本编辑。
      item('拷贝', 'edit:copy', 'CmdOrCtrl+C'),
      item('粘贴', 'edit:paste', 'CmdOrCtrl+V'),
      item('复制生成', 'edit:duplicate', 'CmdOrCtrl+D'),
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
      item('删除', 'edit:delete', 'Delete')
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
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }
  template.push(fileMenu, editMenu, animMenu, viewMenu)

  return template
}
