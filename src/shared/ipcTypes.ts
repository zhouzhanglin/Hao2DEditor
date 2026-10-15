import type { CommandRequest, CommandResponse } from './commandTypes'

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
  deleteFile: 'fs:deleteFile',
  stat: 'fs:stat',
  imageInfo: 'fs:imageInfo',
  registerAssetRoot: 'assets:registerRoot',
  recentList: 'recent:list',
  recentAdd: 'recent:add',
  revealInFolder: 'shell:reveal',
  setTitle: 'win:setTitle',
  menuCommand: 'menu:command',
  openProjectRequest: 'app:openProjectRequest',
  spinePreviewStart: 'preview:spineStart',
  spinePreviewStop: 'preview:spineStop',
  hao2dPreviewStart: 'preview:hao2dStart',
  hao2dPreviewStop: 'preview:hao2dStop',
  openExternal: 'shell:openExternal',
  aiMcpInfo: 'ai:mcpInfo',
  aiInstallMcp: 'ai:installMcp',
  aiCommandApiDoc: 'ai:commandApiDoc',
  i18nSystemLocale: 'i18n:systemLocale',
  i18nSetLocale: 'i18n:setLocale'
} as const

export type MenuCommand =
  | 'project:new'
  | 'project:open'
  | 'project:save'
  | 'project:saveAs'
  | 'project:importSpine'
  | 'project:importDragonBones'
  | 'project:importImages'
  | 'project:importPsd'
  | 'project:exportRuntime'
  | 'project:exportHao2d'
  | 'project:exportSpine'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:delete'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:duplicate'
  | 'edit:selectAll'
  | 'view:fitViewport'
  | 'view:resetLayout'
  | 'app:settings'
  | 'app:aiIntegration'
  | 'anim:playPause'
  | 'anim:nextFrame'
  | 'anim:prevFrame'
  | 'anim:keySelected'
  | 'mode:toggle'

/** 在线预览：一页图集（PNG 字节；所有骨架共用同一份） */
export interface SpinePreviewPage {
  name: string
  bytes: Uint8Array
}

/** 在线预览：单个骨架的文本产物（页数据在 `SpinePreviewSession.pages` 里按名引用） */
export interface SpinePreviewSkeleton {
  id: string
  name: string
  json: string
  atlas: string
  animations: string[]
  skins: string[]
  defaultAnimation: string
  defaultSkin: string
}

/** 交给主进程起「在线预览」的整份会话数据 */
export interface SpinePreviewSession {
  /** 运行库类型：spine（官方运行时）/ hao2d（项目自带的 pixi 运行库） */
  kind?: 'spine' | 'hao2d'
  /** 页面标题（项目名） */
  title: string
  pages: SpinePreviewPage[]
  skeletons: SpinePreviewSkeleton[]
}

/** 导出运行时预览会话：数据与 spine 预览完全一致（页 + 各骨架 ske/atlas 文本），只是渲染运行库换成 hao2d 的 pixi 运行库 */
export interface Hao2dPreviewSession {
  kind: 'hao2d'
  title: string
  pages: SpinePreviewPage[]
  skeletons: SpinePreviewSkeleton[]
}

export interface SpinePreviewInfo {
  /** 本机打开用的地址 */
  url: string
  /** 同一局域网内其他设备（手机）可用的地址，可能有多个网卡 */
  lanUrls: string[]
  /** 会话路径里的随机段 */
  token: string
}

export type PreviewInfo = SpinePreviewInfo

/**
 * 「一键安装 AI 集成」的结果：每个目标客户端一项。
 * - auto 客户端（Claude / Cursor / VSCode）会真的把 MCP URL 写进配置；
 * - 其它 agent（Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode）schema 未公开，
 *   不自动写，只报告「是否已检测到安装目录」，由用户手动把 URL 填进对应设置。
 */
export type McpClientStatus = 'written' | 'error' | 'manual'

export interface McpClientResult {
  id: string
  label: string
  status: McpClientStatus
  /** auto 客户端：写入的配置文件路径 */
  path?: string
  /** error：失败原因 */
  error?: string
  /** manual：是否检测到该客户端的目录（仅作提示） */
  installed?: boolean
}

export interface McpInstallReport {
  /** 命令服务是否在跑（没跑就没有可用的 URL） */
  running: boolean
  /** 可直接填进 AI 客户端的完整 MCP URL（含 token） */
  mcpUrl: string
  items: McpClientResult[]
}

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
  /** 删除文件（舞台参考图等编辑器自己写出的文件）；返回是否真的删了（不存在返回 false） */
  deleteFile(path: string): Promise<IpcResult<boolean>>
  imageInfo(paths: string[]): Promise<IpcResult<ImageInfo[]>>
  /** 把目录登记为可被 hao2d-file:// 读取的资源根（导入碎图时调用） */
  registerAssetRoot(dir: string): Promise<IpcResult<void>>
  recentList(): Promise<IpcResult<string[]>>
  recentAdd(path: string): Promise<IpcResult<void>>
  revealInFolder(path: string): Promise<IpcResult<void>>
  setTitle(title: string): Promise<IpcResult<void>>
  /** 把绝对路径转成渲染层可直接加载的 URL */
  fileUrl(path: string): string
  /** 起本地在线预览服务（spine.js 运行时网页），open=true 时同时在浏览器打开；返回手机可扫码的地址 */
  startSpinePreview(session: SpinePreviewSession, open: boolean): Promise<IpcResult<SpinePreviewInfo>>
  /** 起「导出运行时」预览服务：用项目里的 hao2d 计算方式 + pixi.js 渲染，open=true 时同时在浏览器打开 */
  startHao2dPreview(session: Hao2dPreviewSession, open: boolean): Promise<IpcResult<SpinePreviewInfo>>
  /** 停止预览服务，释放端口与缓存 */
  stopSpinePreview(): Promise<IpcResult<void>>
  stopHao2dPreview(): Promise<IpcResult<void>>
  /** 用系统默认程序打开 http(s) 链接（在线预览面板的「在浏览器打开」） */
  openExternal(url: string): Promise<IpcResult<void>>
  /** AI 接入：当前命令服务的 MCP 信息（是否在跑、带 token 的 MCP URL） */
  aiMcpInfo(): Promise<IpcResult<{ running: boolean; mcpUrl: string; url: string; token: string }>>
  /** AI 接入：把 MCP URL 写进已识别的 AI 客户端配置（一键安装） */
  aiInstallMcp(): Promise<IpcResult<McpInstallReport>>
  /** AI 接入：返回内置命令接口文档（随包发布的 docs/ai-command-api.md 内容），供写出到工程目录让 AI 免配置上手 */
  aiCommandApiDoc(): Promise<IpcResult<{ text: string }>>
  /** 语言：主进程侧的系统语言标签（`app.getLocale()`，首次启动用它判定界面语言） */
  systemLocale(): Promise<IpcResult<string>>
  /** 语言：把当前界面语言同步给主进程，让它按该语言重建菜单 */
  setAppLocale(locale: string): Promise<IpcResult<void>>
  /**
   * 本地命令服务（AI / 脚本用）：监听主进程转来的命令请求。
   * 执行完用 `sendCommandResult` 送回结果；返回值是取消监听的函数。
   */
  onCommandRequest(cb: (request: CommandRequest) => void): () => void
  /** 把命令执行结果送回主进程（由命令桥接调用） */
  sendCommandResult(response: CommandResponse): void
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  onOpenProjectRequest(cb: (path: string) => void): () => void
}

declare global {
  interface Window {
    hao?: HaoBridge
  }
}
