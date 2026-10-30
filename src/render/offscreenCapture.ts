import { Graphics, RenderTexture } from 'pixi.js'
import type { Renderer } from 'pixi.js'
import type { Viewport } from './viewport'
import type { ExportView } from './exportCamera'

export interface FrameCaptureOptions {
  /** 视频像素尺寸（调用方已保证是偶数） */
  width: number
  height: number
  /** 背景色（0xRRGGBB）；不支持透明 */
  background: number
  view: ExportView
}

/**
 * 按**任意分辨率**把角色渲染到离屏纹理并读回 RGBA 字节。
 *
 * 为什么不用视口自己的画布：视口尺寸 = 面板尺寸，与 1920×1080 无关。
 * 这里复用同一个渲染器（同一个 WebGL 上下文），只把 `world` 容器用一套临时的
 * 相机变换画进 RenderTexture —— 棋盘格挂在 `app.stage` 上、不在 `world` 里，
 * 所以天然不会被拍到；坐标轴 / 骨骼叠加层 / 舞台参考图则临时隐藏。
 */
export class OffscreenCapture {
  private texture: RenderTexture | null = null
  private textureWidth = 0
  private textureHeight = 0
  /** 读回的像素是否是自底向上（首次捕获时用一个非对称小图自检一次） */
  private flipRows: boolean | null = null
  private readonly probe = new Graphics()
  /** 复用的帧缓冲：每帧一次 `set()`，稳态零分配（1080p 一帧 8MB，不能每帧新建） */
  private buffer: Uint8Array | null = null

  constructor(private readonly viewport: Viewport) {}

  /**
   * 捕获一帧。
   *
   * @returns RGBA 像素（长度 = width*height*4，**左上原点**）；渲染器不可用时返回 null
   */
  capture(options: FrameCaptureOptions): Uint8Array | null {
    const renderer = this.viewport.app.renderer
    if (!renderer) return null
    const { width, height, view, background } = options
    const world = this.viewport.world
    const target = this.ensureTexture(width, height)

    // 临时相机：世界单位 → 视频像素（y 轴向上，所以 scale.y 取负）
    const savedScaleX = world.scale.x
    const savedScaleY = world.scale.y
    const savedX = world.position.x
    const savedY = world.position.y
    const savedStage = this.viewport.stageLayer.visible
    const savedAxis = this.viewport.axisLayer.visible
    const savedOverlay = this.viewport.overlayLayer.visible

    // 只留角色：参考图 / 坐标轴 / 骨骼线都属于「编辑器辅助显示」，不该进成片
    this.viewport.stageLayer.visible = false
    this.viewport.axisLayer.visible = false
    this.viewport.overlayLayer.visible = false
    world.scale.set(view.zoom, -view.zoom)
    world.position.set(width / 2 - view.centerX * view.zoom, height / 2 + view.centerY * view.zoom)

    try {
      renderer.render({ container: world, target, clear: true, clearColor: background })
    } finally {
      world.scale.set(savedScaleX, savedScaleY)
      world.position.set(savedX, savedY)
      this.viewport.stageLayer.visible = savedStage
      this.viewport.axisLayer.visible = savedAxis
      this.viewport.overlayLayer.visible = savedOverlay
    }

    const extracted = renderer.extract.pixels(target)
    const pixels = extracted.pixels
    if (this.flipRows === null) this.flipRows = this.detectFlip(renderer)
    const byteLength = width * height * 4
    if (!this.buffer || this.buffer.length !== byteLength) this.buffer = new Uint8Array(byteLength)
    // extract 给的是 Uint8ClampedArray：拷进自己的缓冲（IPC 传 Uint8Array 更稳，也便于就地翻转）
    this.buffer.set(new Uint8Array(pixels.buffer, pixels.byteOffset, Math.min(pixels.byteLength, byteLength)))
    if (this.flipRows) flipVertically(this.buffer, width, height)
    return this.buffer
  }

  destroy(): void {
    this.texture?.destroy(true)
    this.texture = null
    this.textureWidth = 0
    this.textureHeight = 0
    this.probe.destroy()
  }

  /** 同一尺寸连续导多帧时复用纹理（1080p 一张 ≈ 8MB，不该每帧新建） */
  private ensureTexture(width: number, height: number): RenderTexture {
    if (this.texture && this.textureWidth === width && this.textureHeight === height) return this.texture
    this.texture?.destroy(true)
    this.texture = RenderTexture.create({ width, height, resolution: 1, antialias: true })
    this.textureWidth = width
    this.textureHeight = height
    return this.texture
  }

  /**
   * 自检像素方向：画一张 2×2 的图（上红下蓝），读回来第一行是红 → 已经是左上原点。
   *
   * 为什么要自检而不是写死：`extract.pixels` 的翻转行为跟 pixi 版本 / 是否 WebGL2
   * 有关，写死一个方向就可能整段视频上下颠倒；自检只花一次 2×2 的渲染。
   */
  private detectFlip(renderer: Renderer): boolean {
    const texture = RenderTexture.create({ width: 2, height: 2, resolution: 1 })
    const probe = this.probe
    probe.clear()
    probe.rect(0, 0, 2, 1).fill(0xff0000)
    probe.rect(0, 1, 2, 1).fill(0x0000ff)
    try {
      renderer.render({ container: probe, target: texture, clear: true, clearColor: 0x000000 })
      const { pixels } = renderer.extract.pixels(texture)
      // 第一行第 0 个像素：红 → 顶行就是图像顶行，无需翻转
      return pixels[0] < pixels[2]
    } catch {
      // 自检失败（驱动异常）时按「不需要翻转」处理，至少不引入确定性的错误
      return false
    } finally {
      texture.destroy(true)
    }
  }
}

/** 就地上下翻转 RGBA 缓冲 */
function flipVertically(pixels: Uint8Array, width: number, height: number): void {
  const stride = width * 4
  const half = Math.floor(height / 2)
  const row = new Uint8Array(stride)
  for (let y = 0; y < half; y++) {
    const top = y * stride
    const bottom = (height - 1 - y) * stride
    row.set(pixels.subarray(top, top + stride))
    pixels.copyWithin(top, bottom, bottom + stride)
    pixels.set(row, bottom)
  }
}
