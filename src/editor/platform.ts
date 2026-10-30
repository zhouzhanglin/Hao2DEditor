import { t } from '@i18n'
import type {
  BatchFile,
  DirEntry,
  HaoBridge,
  Hao2dPreviewSession,
  ImageInfo,
  IpcResult,
  McpInstallReport,
  SkillBundleInfo,
  SkillInstallReport,
  SpinePreviewInfo,
  SpinePreviewSession,
  VideoExportOptions
} from '@shared/ipcTypes'

/**
 * 统一文件/对话框访问层。
 * - Electron 环境：转发到 preload 暴露的 window.hao。
 * - 浏览器环境（dev:web / 自动化验证）：退化为内存文件系统 + file input，
 *   保证渲染层与交互逻辑在两种环境下行为一致。
 */
export interface PickFilesOptions {
  filters?: { name: string; extensions: string[] }[]
  multi?: boolean
  directory?: boolean
  title?: string
}

export interface Platform {
  readonly isElectron: boolean
  readonly platform: string
  pickFiles(options?: PickFilesOptions): Promise<string[]>
  pickSavePath(options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
  readText(path: string): Promise<string>
  readBinary(path: string): Promise<Uint8Array>
  writeText(path: string, text: string): Promise<void>
  writeBinary(path: string, bytes: Uint8Array): Promise<void>
  writeBatch(files: BatchFile[]): Promise<void>
  listDir(dir: string, recursive: boolean): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  /** 删除文件（舞台参考图等编辑器自己写出的文件）；文件不存在返回 false */
  deleteFile(path: string): Promise<boolean>
  imageInfo(paths: string[]): Promise<ImageInfo[]>
  registerAssetRoot(dir: string): Promise<void>
  recentList(): Promise<string[]>
  recentAdd(path: string): Promise<void>
  /** 从最近列表移除一条（工程改名 / 后缀迁移后旧路径会变成死链） */
  recentRemove(path: string): Promise<void>
  revealInFolder(path: string): Promise<void>
  setTitle(title: string): Promise<void>
  fileUrl(path: string): string
  /**
   * 渲染层用来把图片变成纹理的 URL。
   *
   * Electron 下会读文件字节做成 `blob:`（与页面同源）——协议 URL 虽然也能显示，
   * 但它与页面跨源，上传 WebGL 时会被判定成「被污染的图片」，实际渲染成白块。
   */
  imageUrl(path: string): Promise<string>
  /**
   * 释放所有已缓存的图片 URL。
   *
   * `blob:` 必须 revoke，否则背后的图片字节一直被 URL 引用、回收不掉 —— 每导入一个工程就会
   * 多留一份图集页在内存里。新建项目 / 导入别的资源（整份换文档）时调用。
   */
  releaseImageCache(): void
  /** 从系统拖入的 File 取绝对路径；浏览器模式返回内存路径 */
  pathForDroppedFile(file: File): Promise<string>
  /**
   * 在线预览：主进程起一个本地网页服务（用 spine 官方 JS 运行时播放角色），返回本机与局域网地址。
   *
   * 这里**故意**不做 unwrap：失败原因（没有骨架 / 端口起不来）要原样显示给用户，不能吞成空值。
   * 打开浏览器**不在这一层做**：调用方拿到 url 后用下面的 `openExternal`（与「在浏览器打开」同一路径）。
   */
  startSpinePreview(session: SpinePreviewSession): Promise<IpcResult<SpinePreviewInfo>>
  startHao2dPreview(session: Hao2dPreviewSession): Promise<IpcResult<SpinePreviewInfo>>
  /** 停止预览服务：断开连接、释放端口与内存里的资源 */
  stopSpinePreview(): Promise<IpcResult<void>>
  stopHao2dPreview(): Promise<IpcResult<void>>
  /** 用系统默认浏览器打开链接（在线预览面板的「在浏览器打开」；起预览后也走这一条） */
  openExternal(url: string): Promise<void>
  onMenuCommand(cb: (command: string) => void): () => void
  /** 双击工程文件（或从 Finder 拖到图标上）时，主进程把路径推过来 */
  onOpenProjectRequest(cb: (path: string) => void): () => void
  /** 取走启动时排队的「打开这个工程」（双击 `.hao2dproj` 启动的那一次），取完即清空 */
  consumeOpenRequests(): Promise<string[]>
  /** AI 接入：当前命令服务的 MCP 信息（是否在跑、带 token 的 MCP URL） */
  aiMcpInfo(): Promise<IpcResult<{ running: boolean; mcpUrl: string; url: string; token: string }>>
  /** AI 接入：把 MCP URL 写进已识别的 AI 客户端配置（一键安装） */
  aiInstallMcp(): Promise<IpcResult<McpInstallReport>>
  /** AI 接入：随包 AI Skill 的位置与清单 */
  aiSkillsInfo(): Promise<IpcResult<SkillBundleInfo>>
  /** AI 接入：在文件管理器里打开随包 Skill 目录 */
  aiOpenSkillsDir(): Promise<IpcResult<{ path: string }>>
  /** AI 接入：把 Skill 装进 AI 客户端（不传 dir = 已知支持的客户端；传 dir = 指定目录） */
  aiInstallSkill(options?: { name?: string; dir?: string }): Promise<IpcResult<SkillInstallReport>>
  /** 语言：系统语言标签（Electron 走主进程 `app.getLocale()`，浏览器读 `navigator.language`） */
  systemLocale(): Promise<string>
  /** 语言：把当前界面语言同步给主进程（重建菜单）；浏览器模式为空实现 */
  setAppLocale(locale: string): Promise<void>
  /**
   * 视频导出：开会话（主进程 spawn ffmpeg 并打开 rawvideo 管道）。
   *
   * 这几个方法**不做 unwrap**：失败原因（没装 ffmpeg / 路径不可写 / 编码器报错）
   * 必须原样交给面板显示，不能吞成空值。
   */
  startVideoExport(options: VideoExportOptions): Promise<IpcResult<{ sessionId: string; ffmpeg: string }>>
  /** 推一帧 RGBA；返回即代表已写进管道（自带背压） */
  pushVideoFrame(sessionId: string, frame: Uint8Array): Promise<IpcResult<void>>
  /** 收尾：关闭管道等编码完成，成功返回成品路径 */
  finishVideoExport(sessionId: string): Promise<IpcResult<{ path: string }>>
  /** 取消：杀掉 ffmpeg 并删除半成品 */
  cancelVideoExport(sessionId: string): Promise<IpcResult<void>>
}

function unwrap<T>(result: IpcResult<T>, fallback: T): T {
  if (result.ok) return result.data
  console.error(`[hao2d] IPC 失败：${result.error}`)
  return fallback
}

class ElectronPlatform implements Platform {
  readonly isElectron = true
  readonly platform: string
  /** path → blob: URL（图片纹理用），避免同一张图反复走 IPC */
  private readonly imageUrls = new Map<string, string>()

  constructor(private readonly bridge: HaoBridge) {
    this.platform = bridge.platform
  }

  async pickFiles(options?: PickFilesOptions): Promise<string[]> {
    return unwrap(await this.bridge.openDialog({ ...options, title: options?.title ?? t('选择文件') }), [])
  }

  async pickSavePath(options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    return unwrap(await this.bridge.saveDialog(options ?? {}), null)
  }

  readText(path: string): Promise<string> {
    return this.bridge.readText(path).then((r) => unwrap(r, ''))
  }

  readBinary(path: string): Promise<Uint8Array> {
    return this.bridge.readBinary(path).then((r) => unwrap(r, new Uint8Array()))
  }

  async writeText(path: string, text: string): Promise<void> {
    unwrap(await this.bridge.writeText(path, text), undefined)
  }

  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    unwrap(await this.bridge.writeBinary(path, bytes), undefined)
  }

  async writeBatch(files: BatchFile[]): Promise<void> {
    unwrap(await this.bridge.writeBatch(files), undefined)
  }

  listDir(dir: string, recursive: boolean): Promise<DirEntry[]> {
    return this.bridge.listDir(dir, recursive).then((r) => unwrap(r, []))
  }

  exists(path: string): Promise<boolean> {
    return this.bridge.exists(path).then((r) => unwrap(r, false))
  }

  deleteFile(path: string): Promise<boolean> {
    return this.bridge.deleteFile(path).then((r) => unwrap(r, false))
  }

  imageInfo(paths: string[]): Promise<ImageInfo[]> {
    return this.bridge.imageInfo(paths).then((r) => unwrap(r, []))
  }

  async registerAssetRoot(dir: string): Promise<void> {
    unwrap(await this.bridge.registerAssetRoot(dir), undefined)
  }

  recentList(): Promise<string[]> {
    return this.bridge.recentList().then((r) => unwrap(r, []))
  }

  async recentAdd(path: string): Promise<void> {
    unwrap(await this.bridge.recentAdd(path), undefined)
  }

  async recentRemove(path: string): Promise<void> {
    unwrap(await this.bridge.recentRemove(path), undefined)
  }

  async revealInFolder(path: string): Promise<void> {
    unwrap(await this.bridge.revealInFolder(path), undefined)
  }

  async setTitle(title: string): Promise<void> {
    unwrap(await this.bridge.setTitle(title), undefined)
  }

  fileUrl(path: string): string {
    return this.bridge.fileUrl(path)
  }

  /** 读文件字节 → 同源 blob:（缓存，同一张图只读一次） */
  async imageUrl(path: string): Promise<string> {
    const cached = this.imageUrls.get(path)
    if (cached) return cached
    const bytes = await this.readBinary(path)
    if (!bytes || bytes.length === 0) return ''
    const blob = new Blob([bytes as unknown as BlobPart], { type: imageMimeOf(path) })
    const url = URL.createObjectURL(blob)
    this.imageUrls.set(path, url)
    return url
  }

  releaseImageCache(): void {
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url)
    this.imageUrls.clear()
  }

  async pathForDroppedFile(file: File): Promise<string> {
    return this.bridge.getPathForFile(file)
  }

  async startSpinePreview(session: SpinePreviewSession): Promise<IpcResult<SpinePreviewInfo>> {
    /*
     * 开发时热更新只会换掉渲染层：主进程 / preload 还是上次启动的那份，通道根本不存在。
     * 这时若直接调下去只会抛一句看不懂的 TypeError，界面表现出来就是「点了没反应」，
     * 所以这里把它翻译成一句能照做的提示。
     */
    const call = this.bridge.startSpinePreview as
      | ((s: SpinePreviewSession) => Promise<IpcResult<SpinePreviewInfo>>)
      | undefined
    if (typeof call !== 'function') {
      return { ok: false, error: t('预览服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    // 旧版 preload 的签名是 (session, open)：这里少传一个参数也照常工作 ——
    // 浏览器由本层（渲染层）用 openExternal 打开，不依赖主进程那一路
    return call.call(this.bridge, session)
  }

  stopSpinePreview(): Promise<IpcResult<void>> {
    return this.bridge.stopSpinePreview()
  }

  async startHao2dPreview(session: Hao2dPreviewSession): Promise<IpcResult<SpinePreviewInfo>> {
    const call = this.bridge.startHao2dPreview as
      | ((s: Hao2dPreviewSession) => Promise<IpcResult<SpinePreviewInfo>>)
      | undefined
    if (typeof call !== 'function') {
      return { ok: false, error: t('预览服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge, session)
  }

  stopHao2dPreview(): Promise<IpcResult<void>> {
    return this.bridge.stopHao2dPreview()
  }

  async openExternal(url: string): Promise<void> {
    unwrap(await this.bridge.openExternal(url), undefined)
  }

  onMenuCommand(cb: (command: string) => void): () => void {
    return this.bridge.onMenuCommand(cb as never)
  }

  onOpenProjectRequest(cb: (path: string) => void): () => void {
    return this.bridge.onOpenProjectRequest(cb)
  }

  async consumeOpenRequests(): Promise<string[]> {
    const result = await this.bridge.consumeOpenRequests()
    return result.ok ? result.data : []
  }

  async aiMcpInfo(): Promise<IpcResult<{ running: boolean; mcpUrl: string; url: string; token: string }>> {
    const call = this.bridge.aiMcpInfo
    if (typeof call !== 'function') {
      return { ok: false, error: t('命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge)
  }

  async aiInstallMcp(): Promise<IpcResult<McpInstallReport>> {
    const call = this.bridge.aiInstallMcp
    if (typeof call !== 'function') {
      return { ok: false, error: t('命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge)
  }

  async aiSkillsInfo(): Promise<IpcResult<SkillBundleInfo>> {
    const call = this.bridge.aiSkillsInfo
    if (typeof call !== 'function') {
      return { ok: false, error: t('命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge)
  }

  async aiOpenSkillsDir(): Promise<IpcResult<{ path: string }>> {
    const call = this.bridge.aiOpenSkillsDir
    if (typeof call !== 'function') {
      return { ok: false, error: t('命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge)
  }

  async aiInstallSkill(options?: { name?: string; dir?: string }): Promise<IpcResult<SkillInstallReport>> {
    const call = this.bridge.aiInstallSkill
    if (typeof call !== 'function') {
      return { ok: false, error: t('命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）') }
    }
    return call.call(this.bridge, options)
  }

  /** 系统语言：优先问主进程 `app.getLocale()`；通道缺失（旧主进程）时退回 navigator */
  async systemLocale(): Promise<string> {
    const call = this.bridge.systemLocale
    if (typeof call !== 'function') return typeof navigator !== 'undefined' ? navigator.language : ''
    const result = await call.call(this.bridge)
    return result.ok ? result.data : ''
  }

  async setAppLocale(locale: string): Promise<void> {
    const call = this.bridge.setAppLocale
    if (typeof call !== 'function') return
    await call.call(this.bridge, locale)
  }

  startVideoExport(options: VideoExportOptions): Promise<IpcResult<{ sessionId: string; ffmpeg: string }>> {
    return this.bridge.startVideoExport(options)
  }

  pushVideoFrame(sessionId: string, frame: Uint8Array): Promise<IpcResult<void>> {
    return this.bridge.pushVideoFrame(sessionId, frame)
  }

  finishVideoExport(sessionId: string): Promise<IpcResult<{ path: string }>> {
    return this.bridge.finishVideoExport(sessionId)
  }

  cancelVideoExport(sessionId: string): Promise<IpcResult<void>> {
    return this.bridge.cancelVideoExport(sessionId)
  }
}

/** 浏览器模式：内存文件系统 + <input type=file>，仅用于开发调试与自动化验证。 */
class MemoryPlatform implements Platform {
  readonly isElectron = false
  readonly platform = 'browser'

  private files = new Map<string, Uint8Array>()
  private blobs = new Map<string, string>()
  private roots = new Set<string>(['mem:/'])
  private recents: string[] = []
  private counter = 0

  async pickFiles(options?: PickFilesOptions): Promise<string[]> {
    if (typeof document === 'undefined') return []
    if (options?.directory) {
      // 浏览器模式没有目录选择器：固定写到内存目录（便于自动化验证，不弹阻塞对话框）
      return ['mem:/export']
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multi ?? true
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    document.body.appendChild(input)
    const picked = await new Promise<File[]>((resolve) => {
      input.onchange = () => resolve(Array.from(input.files ?? []))
      input.oncancel = () => resolve([])
      input.click()
    })
    input.remove()
    const paths: string[] = []
    for (const file of picked) paths.push(await this.storeFile(file))
    return paths
  }

  async pickSavePath(options?: { defaultPath?: string }): Promise<string | null> {
    const suggested = options?.defaultPath ?? 'project.hao2dproj'
    const value = typeof window === 'undefined' ? null : window.prompt('保存到（内存路径）', suggested)
    return value && value.length > 0 ? value : null
  }

  async readText(path: string): Promise<string> {
    const bytes = this.files.get(path)
    if (!bytes) {
      console.error(`[hao2d] 内存文件不存在：${path}`)
      return ''
    }
    return new TextDecoder().decode(bytes)
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.files.get(path) ?? new Uint8Array()
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(text))
  }

  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }

  async writeBatch(files: BatchFile[]): Promise<void> {
    for (const file of files) {
      if (typeof file.text === 'string') await this.writeText(file.path, file.text)
      else if (file.bytes) await this.writeBinary(file.path, file.bytes)
    }
    console.log(`[hao2d] 内存模式写入 ${files.length} 个文件：`, files.map((f) => f.path).join(', '))
  }

  /**
   * 内存文件系统的「目录」视图：把 `dir/...` 前缀下的文件全部返回（含子目录，等价递归）。
   * 「拖入文件夹 → 展开里面的图片」这条链路因此在浏览器模式下也能跑通（便于自动化验证）：
   * 传文件路径时没有前缀匹配 → 空列表 → 调用方按普通文件处理。
   */
  async listDir(dir: string): Promise<DirEntry[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const out: DirEntry[] = []
    for (const [key, bytes] of this.files) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest.length === 0) continue
      out.push({ path: key, name: rest, relativePath: rest, isDirectory: false, size: bytes.length })
    }
    return out
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  /** 内存文件系统：直接摘掉条目，blob URL 一并回收 */
  async deleteFile(path: string): Promise<boolean> {
    const existed = this.files.delete(path)
    const blob = this.blobs.get(path)
    if (blob) {
      URL.revokeObjectURL(blob)
      this.blobs.delete(path)
    }
    return existed
  }

  async imageInfo(paths: string[]): Promise<ImageInfo[]> {
    const out: ImageInfo[] = []
    for (const p of paths) {
      const bytes = this.files.get(p)
      const size = bytes ? await measureImage(bytes) : { width: 0, height: 0 }
      out.push({ path: p, name: p.split('/').pop() ?? p, width: size.width, height: size.height })
    }
    return out
  }

  async registerAssetRoot(dir: string): Promise<void> {
    this.roots.add(dir)
  }

  async recentList(): Promise<string[]> {
    return [...this.recents]
  }

  async recentAdd(path: string): Promise<void> {
    this.recents = [path, ...this.recents.filter((v) => v !== path)].slice(0, 12)
  }

  async recentRemove(path: string): Promise<void> {
    this.recents = this.recents.filter((v) => v !== path)
  }

  async revealInFolder(path: string): Promise<void> {
    console.log(`[hao2d] 内存模式无文件系统，定位：${path}`)
  }

  async setTitle(title: string): Promise<void> {
    if (typeof document !== 'undefined') document.title = title
  }

  fileUrl(path: string): string {
    const cached = this.blobs.get(path)
    if (cached) return cached
    const bytes = this.files.get(path)
    if (!bytes) return ''
    const blob = new Blob([bytes as unknown as BlobPart])
    const url = URL.createObjectURL(blob)
    this.blobs.set(path, url)
    return url
  }

  /** 浏览器模式的内存文件本来就是 blob:，与展示用的 URL 是同一份 */
  async imageUrl(path: string): Promise<string> {
    return this.fileUrl(path)
  }

  /** 只放 URL 缓存：文件字节留在内存文件系统里（`files`），下次要图会按需重新造 URL */
  releaseImageCache(): void {
    for (const url of this.blobs.values()) URL.revokeObjectURL(url)
    this.blobs.clear()
  }

  async pathForDroppedFile(file: File): Promise<string> {
    return this.storeFile(file)
  }

  /** 浏览器模式没有主进程，起不了本地服务（dev:web 里忽略这个功能） */
  async startSpinePreview(): Promise<IpcResult<SpinePreviewInfo>> {
    return { ok: false, error: t('浏览器模式没有本地预览服务，请在桌面版里使用') }
  }

  async stopSpinePreview(): Promise<IpcResult<void>> {
    return { ok: true, data: undefined }
  }

  async startHao2dPreview(): Promise<IpcResult<SpinePreviewInfo>> {
    return { ok: false, error: t('浏览器模式没有本地预览服务，请在桌面版里使用') }
  }

  async stopHao2dPreview(): Promise<IpcResult<void>> {
    return { ok: true, data: undefined }
  }

  /** 浏览器模式：直接开新标签（被弹窗拦截也无所谓，链接就显示在旁边） */
  async openExternal(url: string): Promise<void> {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
  }

  onMenuCommand(): () => void {
    return () => undefined
  }

  onOpenProjectRequest(): () => void {
    return () => undefined
  }

  async consumeOpenRequests(): Promise<string[]> {
    return []
  }

  async aiMcpInfo(): Promise<IpcResult<{ running: boolean; mcpUrl: string; url: string; token: string }>> {
    return { ok: false, error: t('浏览器模式没有命令服务，请在桌面版里使用') }
  }

  async aiInstallMcp(): Promise<IpcResult<McpInstallReport>> {
    return { ok: false, error: t('浏览器模式没有命令服务，请在桌面版里使用') }
  }

  async aiSkillsInfo(): Promise<IpcResult<SkillBundleInfo>> {
    return { ok: false, error: t('浏览器模式没有随包 Skill，请在桌面版里使用') }
  }

  async aiOpenSkillsDir(): Promise<IpcResult<{ path: string }>> {
    return { ok: false, error: t('浏览器模式没有随包 Skill，请在桌面版里使用') }
  }

  async aiInstallSkill(): Promise<IpcResult<SkillInstallReport>> {
    return { ok: false, error: t('浏览器模式没有随包 Skill，请在桌面版里使用') }
  }

  /** 浏览器模式：直接读 navigator.language */
  async systemLocale(): Promise<string> {
    return typeof navigator !== 'undefined' ? navigator.language : ''
  }

  /** 浏览器模式没有主进程菜单，空实现 */
  async setAppLocale(): Promise<void> {
    // no-op
  }

  /** 浏览器模式没有 ffmpeg：明确报错，别让面板以为「导出成功了」 */
  async startVideoExport(): Promise<IpcResult<{ sessionId: string; ffmpeg: string }>> {
    return { ok: false, error: t('浏览器模式不支持导出视频（请在桌面版里导出）') }
  }

  async pushVideoFrame(): Promise<IpcResult<void>> {
    return { ok: false, error: t('浏览器模式不支持导出视频（请在桌面版里导出）') }
  }

  async finishVideoExport(): Promise<IpcResult<{ path: string }>> {
    return { ok: false, error: t('浏览器模式不支持导出视频（请在桌面版里导出）') }
  }

  async cancelVideoExport(): Promise<IpcResult<void>> {
    return { ok: true, data: undefined }
  }

  private async storeFile(file: File): Promise<string> {
    const path = `mem:/${++this.counter}_${file.name}`
    const buf = await file.arrayBuffer()
    this.files.set(path, new Uint8Array(buf))
    return path
  }
}

async function measureImage(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'undefined') return { width: 0, height: 0 }
  const blob = new Blob([bytes as unknown as BlobPart])
  const bitmap = await createImageBitmap(blob)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

let cached: Platform | null = null

export function getPlatform(): Platform {
  if (cached) return cached
  const bridge = typeof window !== 'undefined' ? window.hao : undefined
  cached = bridge ? new ElectronPlatform(bridge) : new MemoryPlatform()
  return cached
}

export function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir}${sep}${name}`
}

export function dirName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx < 0 ? '' : p.slice(0, idx)
}

export function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx < 0 ? p : p.slice(idx + 1)
}

export function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx <= 0 ? name : name.slice(0, idx)
}

/** 图片扩展名 → MIME（做 blob: 时给上类型，浏览器才好按图片解码） */
function imageMimeOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}
