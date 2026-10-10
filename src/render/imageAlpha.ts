import { loadImageElement } from './imageLoader'

/**
 * 图片 alpha 缓存（附件像素拾取用）。
 *
 * 拾取需要回答「鼠标这一点对应的纹素是不是不透明的」，但纹理在 GPU 上读不出来，
 * 所以这里把图片解码到离屏 canvas，**只留 alpha 通道**（每像素 1 字节，
 * 比整张 RGBA 省 3/4），按名字缓存。
 *
 * 尚未解码完 / 解码失败时 `alphaAt` 一律返回 1（当作不透明）：拾取退化成几何命中，
 * 不会出现「刚打开工程、图还没解码完就点不中」。
 */
export interface ImageAlphaEntry {
  width: number
  height: number
  /** 逐像素 alpha（0..255），行优先，长度 = width * height */
  alpha: Uint8Array
}

export class ImageAlphaCache {
  private entries = new Map<string, ImageAlphaEntry>()
  private failed = new Set<string>()
  private pending = new Set<string>()

  /** 是否已就绪（测试与调试用） */
  has(name: string): boolean {
    return this.entries.has(name)
  }

  /**
   * 取整张遮罩（自动生成网格要遍历像素，逐点 alphaAt 太慢）。
   * 未就绪 / 未知图片返回 null —— 调用方据此提示「图片还没解码好」。
   */
  entryOf(name: string): ImageAlphaEntry | null {
    return this.entries.get(name) ?? null
  }

  /**
   * 采样 uv 处的不透明度（0..1）。
   * 未就绪 / 未知图片 / uv 越界一律返回 1 —— 让拾取退化为几何命中而不是「点不中」。
   */
  alphaAt(name: string, u: number, v: number): number {
    const entry = this.entries.get(name)
    if (!entry) return 1
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return 1
    const width = entry.width
    const height = entry.height
    // 最近邻取样：uv 的 [0,1] 映射到像素格，落在格子边界的点取右侧/下侧像素。
    // v 方向与渲染保持一致 —— 运行时附件的 uv 在构建时已经按图片行方向对齐
    // （附件上半对应的 v 接近 0，正好采到第 0 行 = 图片顶部）。
    // 这是实测定的：一张「上半不透明、下半透明」的图放进场景后，
    // 点附件上半命中、点下半的透明区不命中。
    let px = Math.floor(u * width)
    let py = Math.floor(v * height)
    if (px < 0) px = 0
    else if (px >= width) px = width - 1
    if (py < 0) py = 0
    else if (py >= height) py = height - 1
    return entry.alpha[py * width + px] / 255
  }

  /** 异步解码并缓存一张图的 alpha（url 由平台层提供，与纹理加载用的是同一个） */
  ensure(name: string, url: string): void {
    if (!name || !url) return
    if (this.entries.has(name) || this.failed.has(name) || this.pending.has(name)) return
    this.pending.add(name)
    void this.decode(name, url)
  }

  private async decode(name: string, url: string): Promise<void> {
    try {
      const image = await loadImageElement(url)
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (width <= 0 || height <= 0) throw new Error('图片尺寸为空')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('无法创建 2D 上下文')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, width, height).data
      const alpha = new Uint8Array(width * height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]
      this.entries.set(name, { width, height, alpha })
    } catch {
      // 解码失败（图片损坏 / 权限）：标记一次，之后不再重试，拾取退化为几何命中
      this.failed.add(name)
    } finally {
      this.pending.delete(name)
    }
  }

  /**
   * 释放某张图的像素缓存。
   *
   * 换资源时必须用：图集页**同名**很常见（DragonBones 示例里 4 个角色都叫 `texture.png`），
   * 不释放会继续按旧像素做拾取判断（点不中 / 点错零件）。
   */
  delete(name: string): void {
    this.entries.delete(name)
    this.failed.delete(name)
    this.pending.delete(name)
  }

  clear(): void {
    this.entries.clear()
    this.failed.clear()
    this.pending.clear()
  }
}
