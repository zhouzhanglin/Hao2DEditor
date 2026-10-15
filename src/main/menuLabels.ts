/**
 * 菜单文案数据（纯数据，不依赖 electron，方便单测直接引用）。
 *
 * 语言状态与系统语言探测放在 `./i18n`，那边会 import electron。
 */

export type Locale = 'zh-CN' | 'en'

/** 目前只分「中文 / 其它」两类：以 zh 开头走简中，其余一律英文 */
export function normalizeLocale(tag: string | undefined | null): Locale {
  if (!tag) return 'zh-CN'
  return tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** 菜单文案表。键名与 menuTemplate 里用到的位置一一对应 */
export interface MenuLabels {
  about: string
  settings: string
  aiIntegration: string
  file: string
  newProject: string
  openProject: string
  save: string
  saveAs: string
  importSpine: string
  importDragonBones: string
  importImages: string
  importPsd: string
  exportRuntime: string
  exportHao2d: string
  exportSpine: string
  closeWindow: string
  quit: string
  edit: string
  undo: string
  redo: string
  copy: string
  paste: string
  duplicate: string
  cut: string
  selectAll: string
  delete: string
  animation: string
  playPause: string
  prevFrame: string
  nextFrame: string
  keySelected: string
  view: string
  fitViewport: string
  resetLayout: string
  reload: string
  devTools: string
  actualSize: string
  zoomIn: string
  zoomOut: string
  hide: string
  hideOthers: string
}

const ZH: MenuLabels = {
  about: '关于 {app}',
  settings: '设置…',
  aiIntegration: 'AI 接入…',
  file: '文件',
  newProject: '新建工程',
  openProject: '打开工程…',
  save: '保存',
  saveAs: '另存为…',
  importSpine: '导入 Spine…',
  importDragonBones: '导入 DragonBones…',
  importImages: '导入图片…',
  importPsd: '导入 PSD…',
  exportRuntime: '导出运行时数据…',
  exportHao2d: '导出 Unity…',
  exportSpine: '导出 Spine…',
  closeWindow: '关闭窗口',
  quit: '退出',
  edit: '编辑',
  undo: '撤销',
  redo: '重做',
  copy: '拷贝',
  paste: '粘贴',
  duplicate: '复制生成',
  cut: '剪切',
  selectAll: '全选',
  delete: '删除',
  animation: '动画',
  playPause: '播放 / 暂停',
  prevFrame: '上一帧',
  nextFrame: '下一帧',
  keySelected: '为选中项打关键帧',
  view: '视图',
  fitViewport: '适配视野',
  resetLayout: '重置面板布局',
  reload: '重新加载',
  devTools: '开发者工具',
  actualSize: '实际大小',
  zoomIn: '放大',
  zoomOut: '缩小',
  hide: '隐藏',
  hideOthers: '隐藏其他'
}

const EN: MenuLabels = {
  about: 'About {app}',
  settings: 'Settings…',
  aiIntegration: 'AI Integration…',
  file: 'File',
  newProject: 'New Project',
  openProject: 'Open Project…',
  save: 'Save',
  saveAs: 'Save As…',
  importSpine: 'Import Spine…',
  importDragonBones: 'Import DragonBones…',
  importImages: 'Import Images…',
  importPsd: 'Import PSD…',
  exportRuntime: 'Export Runtime Data…',
  exportHao2d: 'Export Unity…',
  exportSpine: 'Export Spine…',
  closeWindow: 'Close Window',
  quit: 'Quit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  copy: 'Copy',
  paste: 'Paste',
  duplicate: 'Duplicate',
  cut: 'Cut',
  selectAll: 'Select All',
  delete: 'Delete',
  animation: 'Animation',
  playPause: 'Play / Pause',
  prevFrame: 'Previous Frame',
  nextFrame: 'Next Frame',
  keySelected: 'Keyframe Selected',
  view: 'View',
  fitViewport: 'Fit View',
  resetLayout: 'Reset Panel Layout',
  reload: 'Reload',
  devTools: 'Developer Tools',
  actualSize: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  hide: 'Hide',
  hideOthers: 'Hide Others'
}

/** 取某语言下的菜单文案 */
export function labelsFor(locale: Locale): MenuLabels {
  return locale === 'en' ? EN : ZH
}
