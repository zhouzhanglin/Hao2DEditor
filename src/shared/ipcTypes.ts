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

/**
 * 导出视频：一次会话 = 一个动画 = 一个 mp4。
 *
 * 渲染层逐帧把 RGBA 像素推进来（rawvideo 管道），主进程用 ffmpeg 编成 H.264。
 * 宽高必须是**偶数**（H.264 的 4:2:0 色度采样要求，渲染层负责对齐后再传）。
 */
export interface VideoExportOptions {
  /** 输出 mp4 的绝对路径 */
  outputPath: string
  width: number
  height: number
  /** 帧率取自工程的动画帧率 */
  fps: number
  /** H.264 质量（CRF，越小越清晰，默认 18） */
  crf?: number
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
  recentRemove: 'recent:remove',
  revealInFolder: 'shell:reveal',
  setTitle: 'win:setTitle',
  menuCommand: 'menu:command',
  openProjectRequest: 'app:openProjectRequest',
  /** 渲染层就绪后取走「双击工程文件」排队的路径（主进程 → 渲染层拉取，避免时序竞争） */
  consumeOpenRequests: 'app:consumeOpenRequests',
  spinePreviewStart: 'preview:spineStart',
  spinePreviewStop: 'preview:spineStop',
  hao2dPreviewStart: 'preview:hao2dStart',
  hao2dPreviewStop: 'preview:hao2dStop',
  threejsPreviewStart: 'preview:threejsStart',
  threejsPreviewStop: 'preview:threejsStop',
  openExternal: 'shell:openExternal',
  aiMcpInfo: 'ai:mcpInfo',
  aiInstallMcp: 'ai:installMcp',
  aiSkillsInfo: 'ai:skillsInfo',
  aiOpenSkillsDir: 'ai:openSkillsDir',
  aiInstallSkill: 'ai:installSkill',
  i18nSystemLocale: 'i18n:systemLocale',
  i18nSetLocale: 'i18n:setLocale',
  /** 视频导出：开会话 / 推一帧 / 收尾 / 取消 */
  videoStart: 'video:start',
  videoFrame: 'video:frame',
  videoFinish: 'video:finish',
  videoCancel: 'video:cancel'
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
  | 'project:exportThreejs'
  | 'project:exportVideo'
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
  /** hao2d 预览：被本骨架嵌套引用的子骨架（页面据此预取它们的 ske 文本） */
  nested?: Array<{ armatureName: string; id: string }>
}

/** 预览页语言：跟编辑器当前语言走（预览页由主进程返回，渲染层要把语言一起传过去） */
export type PreviewLocale = 'zh-CN' | 'en'

/** 交给主进程起「在线预览」的整份会话数据 */
export interface SpinePreviewSession {
  /** 运行库类型：spine（官方运行时）/ hao2d（pixi 运行库）/ threejs（three.js 运行库） */
  kind?: 'spine' | 'hao2d' | 'threejs'
  /** 页面标题（项目名） */
  title: string
  /** 预览页 UI 语言；缺省按简中 */
  locale?: PreviewLocale
  pages: SpinePreviewPage[]
  skeletons: SpinePreviewSkeleton[]
}

/** 导出运行时预览会话：数据与 spine 预览完全一致（页 + 各骨架 ske/atlas 文本），只是渲染运行库换成 hao2d 的 pixi 运行库 */
export interface Hao2dPreviewSession {
  kind: 'hao2d'
  title: string
  /** 预览页 UI 语言；缺省按简中 */
  locale?: PreviewLocale
  pages: SpinePreviewPage[]
  skeletons: SpinePreviewSkeleton[]
}

/** three.js 运行库预览会话：与 hao2d 预览同一份数据，页面加载 threejs-runtime.js */
export interface ThreejsPreviewSession {
  kind: 'threejs'
  title: string
  /** 预览页 UI 语言；缺省按简中 */
  locale?: PreviewLocale
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

/**
 * 随包分发的 AI Skill（`resources/skills/<name>/SKILL.md`）。
 * 面板显示它、也能一键复制到 AI 客户端的 skills 目录。
 */
export interface SkillInfo {
  /** frontmatter 里的 name */
  name: string
  /** 目录名（安装时落到 `<skills 目录>/<dirName>`） */
  dirName: string
  version?: string
  description: string
  /** 随包目录的绝对路径 */
  path: string
  /** 文件数（面板上给个体量感） */
  files: number
}

export interface SkillBundleInfo {
  /** 随包 Skill 根目录：打包后是 <resources>/skills，开发时是仓库 resources/skills */
  path: string
  exists: boolean
  skills: SkillInfo[]
  /** 手动安装用的复制命令模板（`<目标 skills 目录>` 为占位） */
  copyCommand: string
  /** 每个 AI 客户端里的安装状态（面板据此显示「已装 vX / 可更新」） */
  targets: SkillTargetState[]
}

/** 某个 AI 客户端里这个 Skill 的安装状态 */
export interface SkillTargetState {
  id: string
  label: string
  /** 该客户端的 skills 目录 */
  path: string
  /** 是否检测到该客户端（数据目录存在） */
  detected: boolean
  /** 是否支持自动安装 */
  auto: boolean
  /** 是否已装（skillsDir/<name>/SKILL.md 存在） */
  installed: boolean
  /** 已装版本（读 SKILL.md 的 frontmatter；老版本没写 version 就是 undefined） */
  installedVersion?: string
  /** 已装版本与随包不一致 */
  outdated: boolean
}

export type SkillInstallStatus = 'written' | 'manual' | 'error'

export interface SkillTargetResult {
  id: string
  label: string
  status: SkillInstallStatus
  /** written：写入的目录；manual：该客户端的 skills 目录 */
  path?: string
  error?: string
  /** manual：是否检测到该客户端的数据目录 */
  detected?: boolean
  /** manual：可直接复制执行的安装命令 */
  copyCommand?: string
}

export interface SkillInstallReport {
  items: SkillTargetResult[]
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
  /** 从最近列表移除一条（工程换名 / 后缀迁移后，旧路径不该继续留在列表里） */
  recentRemove(path: string): Promise<IpcResult<void>>
  revealInFolder(path: string): Promise<IpcResult<void>>
  setTitle(title: string): Promise<IpcResult<void>>
  /** 把绝对路径转成渲染层可直接加载的 URL */
  fileUrl(path: string): string
  /**
   * 起本地在线预览服务（spine.js 运行时网页）；返回手机可扫码的地址。
   *
   * **这里不打开浏览器**：打开动作交给渲染层（`openExternal`，和「在浏览器打开」按钮同一条路径）。
   * 主进程里那一路 `shell.openExternal` 在部分机器上会被系统静默丢弃，渲染层调用则稳定生效。
   */
  startSpinePreview(session: SpinePreviewSession): Promise<IpcResult<SpinePreviewInfo>>
  /** 起「导出运行时」预览服务：用项目里的 hao2d 计算方式 + pixi.js 渲染（同样由渲染层打开浏览器） */
  startHao2dPreview(session: Hao2dPreviewSession): Promise<IpcResult<SpinePreviewInfo>>
  /** 起 three.js 运行库预览服务：同一份 ske/atlas 数据 + three.js 渲染 */
  startThreejsPreview(session: ThreejsPreviewSession): Promise<IpcResult<SpinePreviewInfo>>
  /** 停止预览服务，释放端口与缓存 */
  stopSpinePreview(): Promise<IpcResult<void>>
  stopHao2dPreview(): Promise<IpcResult<void>>
  stopThreejsPreview(): Promise<IpcResult<void>>
  /** 用系统默认程序打开 http(s) 链接（在线预览面板的「在浏览器打开」） */
  openExternal(url: string): Promise<IpcResult<void>>
  /** AI 接入：当前命令服务的 MCP 信息（是否在跑、带 token 的 MCP URL） */
  aiMcpInfo(): Promise<IpcResult<{ running: boolean; mcpUrl: string; url: string; token: string }>>
  /** AI 接入：把 MCP URL 写进已识别的 AI 客户端配置（一键安装） */
  aiInstallMcp(): Promise<IpcResult<McpInstallReport>>
  /** AI 接入：随包 AI Skill 的位置与清单 */
  aiSkillsInfo(): Promise<IpcResult<SkillBundleInfo>>
  /** AI 接入：在文件管理器里打开随包 Skill 目录 */
  aiOpenSkillsDir(): Promise<IpcResult<{ path: string }>>
  /**
   * AI 接入：把 Skill 复制进 AI 客户端。
   * 不传参数 = 装到已知支持 Skills 且已安装的客户端；传 `dir` = 装到用户选的目录。
   */
  aiInstallSkill(options?: {
    name?: string
    dir?: string
  }): Promise<IpcResult<SkillInstallReport>>
  /** 语言：主进程侧的系统语言标签（`app.getLocale()`，首次启动用它判定界面语言） */
  systemLocale(): Promise<IpcResult<string>>
  /** 语言：把当前界面语言同步给主进程，让它按该语言重建菜单 */
  setAppLocale(locale: string): Promise<IpcResult<void>>
  /**
   * 视频导出：开会话（spawn ffmpeg）。返回会话 id 与实际使用的 ffmpeg 路径
   * （路径进日志 / 错误提示，方便确认用的是随包二进制还是系统装的）。
   */
  startVideoExport(options: VideoExportOptions): Promise<IpcResult<{ sessionId: string; ffmpeg: string }>>
  /** 推一帧 RGBA 像素（长度必须 = width*height*4）；返回时主进程已写进管道（自带背压） */
  pushVideoFrame(sessionId: string, frame: Uint8Array): Promise<IpcResult<void>>
  /** 收尾：关闭管道并等 ffmpeg 退出；成功返回成品路径 */
  finishVideoExport(sessionId: string): Promise<IpcResult<{ path: string }>>
  /** 取消：杀掉 ffmpeg 并删掉半成品 */
  cancelVideoExport(sessionId: string): Promise<IpcResult<void>>
  /**
   * 本地命令服务（AI / 脚本用）：监听主进程转来的命令请求。
   * 执行完用 `sendCommandResult` 送回结果；返回值是取消监听的函数。
   */
  onCommandRequest(cb: (request: CommandRequest) => void): () => void
  /** 把命令执行结果送回主进程（由命令桥接调用） */
  sendCommandResult(response: CommandResponse): void
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  onOpenProjectRequest(cb: (path: string) => void): () => void
  /**
   * 取走启动时排队的「用编辑器打开这个工程」路径（双击 `.hao2dproj` 启动的那一次）。
   * 渲染层挂载后调一次；之后再双击走 `onOpenProjectRequest` 事件。
   */
  consumeOpenRequests(): Promise<IpcResult<string[]>>
}

declare global {
  interface Window {
    hao?: HaoBridge
  }
}
