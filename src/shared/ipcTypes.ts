/**
 * 主进程与渲染进程共享的 IPC 契约。
 * 所有 invoke 通道统一返回 IpcResult<T>，渲染进程无需 try/catch。
 */

export interface IpcOk<T> {
  ok: true
  data: T
}

export interface IpcErr {
  ok: false
  error: string
}

export type IpcResult<T> = IpcOk<T> | IpcErr

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  title?: string
  filters?: FileFilter[]
  /** 允许多选 */
  multi?: boolean
  /** 选择目录而不是文件 */
  directory?: boolean
  defaultPath?: string
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: FileFilter[]
}

export interface ImageInfo {
  path: string
  name: string
  width: number
  height: number
}

export interface DirEntry {
  path: string
  name: string
  /** 相对 root 的路径，统一使用 / 分隔 */
  relativePath: string
  isDirectory: boolean
  size: number
}

export interface BatchFile {
  path: string
  /** 文本内容或二进制内容，二选一 */
  text?: string
  bytes?: Uint8Array
}

export const IPC = {
  openDialog: 'dialog:open',
  saveDialog: 'dialog:save',
  readText: 'fs:readText',
  readBinary: 'fs:readBinary',
  writeText: 'fs:writeText',
  writeBinary: 'fs:writeBinary',
  writeBatch: 'fs:writeBatch',
  listDir: 'fs:listDir',
  exists: 'fs:exists',
  stat: 'fs:stat',
  imageInfo: 'fs:imageInfo',
  registerAssetRoot: 'assets:registerRoot',
  recentList: 'recent:list',
  recentAdd: 'recent:add',
  revealInFolder: 'shell:reveal',
  setTitle: 'win:setTitle',
  menuCommand: 'menu:command',
  openProjectRequest: 'app:openProjectRequest'
} as const

export type MenuCommand =
  | 'project:new'
  | 'project:open'
  | 'project:save'
  | 'project:saveAs'
  | 'project:importSpine'
  | 'project:importDragonBones'
  | 'project:importImages'
  | 'project:exportRuntime'
  | 'project:exportHao2d'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:delete'
  | 'edit:duplicate'
  | 'edit:selectAll'
  | 'view:fitViewport'
  | 'view:resetLayout'
  | 'anim:playPause'
  | 'anim:nextFrame'
  | 'anim:prevFrame'
  | 'anim:keySelected'
  | 'mode:toggle'

/** preload 暴露到 window.hao 的 API。 */
export interface HaoBridge {
  readonly isElectron: true
  readonly platform: string
  /** 由系统拖入的 File 取绝对路径（Electron webUtils） */
  getPathForFile(file: File): string
  openDialog(options?: OpenDialogOptions): Promise<IpcResult<string[]>>
  saveDialog(options?: SaveDialogOptions): Promise<IpcResult<string | null>>
  readText(path: string): Promise<IpcResult<string>>
  readBinary(path: string): Promise<IpcResult<Uint8Array>>
  writeText(path: string, text: string): Promise<IpcResult<void>>
  writeBinary(path: string, bytes: Uint8Array): Promise<IpcResult<void>>
  writeBatch(files: BatchFile[]): Promise<IpcResult<void>>
  listDir(dir: string, recursive: boolean): Promise<IpcResult<DirEntry[]>>
  exists(path: string): Promise<IpcResult<boolean>>
  imageInfo(paths: string[]): Promise<IpcResult<ImageInfo[]>>
  /** 把目录登记为可被 hao2d-file:// 读取的资源根（导入碎图时调用） */
  registerAssetRoot(dir: string): Promise<IpcResult<void>>
  recentList(): Promise<IpcResult<string[]>>
  recentAdd(path: string): Promise<IpcResult<void>>
  revealInFolder(path: string): Promise<IpcResult<void>>
  setTitle(title: string): Promise<IpcResult<void>>
  /** 把绝对路径转成渲染层可直接加载的 URL */
  fileUrl(path: string): string
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  onOpenProjectRequest(cb: (path: string) => void): () => void
}

declare global {
  interface Window {
    hao?: HaoBridge
  }
}
