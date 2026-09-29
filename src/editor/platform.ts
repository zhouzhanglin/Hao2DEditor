import type { BatchFile, DirEntry, HaoBridge, ImageInfo, IpcResult } from '@shared/ipcTypes'

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
  imageInfo(paths: string[]): Promise<ImageInfo[]>
  registerAssetRoot(dir: string): Promise<void>
  recentList(): Promise<string[]>
  recentAdd(path: string): Promise<void>
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
  /** 从系统拖入的 File 取绝对路径；浏览器模式返回内存路径 */
  pathForDroppedFile(file: File): Promise<string>
  onMenuCommand(cb: (command: string) => void): () => void
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
    return unwrap(await this.bridge.openDialog({ ...options, title: options?.title ?? '选择文件' }), [])
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

  async pathForDroppedFile(file: File): Promise<string> {
    return this.bridge.getPathForFile(file)
  }

  onMenuCommand(cb: (command: string) => void): () => void {
    return this.bridge.onMenuCommand(cb as never)
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
    const suggested = options?.defaultPath ?? 'project.hao2d.proj'
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

  async listDir(): Promise<DirEntry[]> {
    return []
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
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

  async pathForDroppedFile(file: File): Promise<string> {
    return this.storeFile(file)
  }

  onMenuCommand(): () => void {
    return () => undefined
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
