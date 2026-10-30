import { Application, Container } from 'pixi.js'
import { Checkerboard, pickCellSize } from './checkerboard'
// 缩放限位与「居中取景」的数学在 camera.ts（纯计算，不依赖 Pixi，可单测）
import { clampZoom, framingCamera } from './camera'

export interface ViewportBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 空场景（无内容可适配）时的默认缩放：PPU，1 单位 = 100px */
const EMPTY_SCENE_ZOOM = 100

export interface ViewportOptions {
  background?: string
  onZoomChange?: (zoom: number) => void
}

/**
 * pixi Application + 相机。
 *
 * 世界容器使用 **scale.y = -zoom**（y 轴向上，与骨架数据一致），
 * 因此在世界空间里画线/画点时坐标可以直接用骨骼/顶点的原始值。
 * 关闭了自动 ticker：由编辑器按需调用 render()（脏标记驱动）。
 */
export class Viewport {
  readonly app = new Application()
  /** 角色与叠加层共用的世界容器（相机变换作用于此） */
  readonly world = new Container()
  readonly contentLayer = new Container()
  readonly overlayLayer = new Container()

  private offsetX = 0
  private offsetY = 0
  private zoomValue = 1
  private ready = false
  private destroyed = false

  /** 坐标轴图层：位于棋盘格之上、角色之下 */
  readonly axisLayer = new Container()
  /**
   * 舞台参考图图层：棋盘格之上、坐标轴与角色**之下** —— 参考图是背景，
   * 原点 / 轴线要一直压在它上面看得见，角色更是要盖住它。
   */
  readonly stageLayer = new Container()

  private readonly onZoomChange: (zoom: number) => void
  private readonly canvas: HTMLCanvasElement
  /** 铺满整块画布的棋盘格背景（世界锚定，随缩放/平移走） */
  private readonly checker = new Checkerboard()
  /**
   * 宿主尺寸监听放在 Viewport 内部：编辑器挂载时宿主可能还没布局（尺寸为 0），
   * 仅靠渲染层的 ResizeObserver 容易漏掉，导致画布停在 pixi 默认的 800×600 而没铺满面板。
   */
  private readonly hostObserver: ResizeObserver | null

  /**
   * canvas 由 Viewport 自己创建并挂到 host 上：
   * 避免复用同一个 DOM 节点时（开发环境 StrictMode 双挂载 / HMR）出现两个 WebGL 上下文。
   */
  constructor(private readonly host: HTMLElement, options: ViewportOptions = {}) {
    this.canvas = document.createElement('canvas')
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    host.appendChild(this.canvas)
    this.onZoomChange = options.onZoomChange ?? (() => undefined)
    this.world.addChild(this.stageLayer, this.axisLayer, this.contentLayer, this.overlayLayer)
    this.app.stage.addChild(this.world)
    this.hostObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.syncHostSize())
    this.hostObserver?.observe(host)
  }

  /**
   * 让画布始终与宿主（视口面板）等大。幂等、可每帧调用：
   * 尺寸没变时只是一次 clientWidth 读取，尺寸变了就重建相机与背景。
   *
   * 之所以每帧兜底：面板尺寸变化可能发生在渲染层 ResizeObserver 之前/之外
   * （Electron 窗口初始化、面板折叠、HMR 留下的旧实例……），漏一次就会看到
   * 「画布/棋盘格比面板小」的残影。
   */
  syncHostSize(): boolean {
    if (!this.isReady) return false
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    if (width <= 0 || height <= 0) return false
    if (Math.abs(this.width - width) < 0.5 && Math.abs(this.height - height) < 0.5) return false
    this.resize(width, height)
    return true
  }

  /**
   * 让棋盘格与当前相机/尺寸保持一致（幂等，可每帧调用）。
   *
   * 直接比对 Sprite 的**实际状态**而不是缓存一份期望值：这样任何原因导致的
   * 尺寸/偏移不一致都会在下一帧被纠正，等于自带自愈能力。
   */
  syncBackground(): boolean {
    if (!this.isReady) return false
    const cell = Math.max(4, pickCellSize(this.zoomValue) * this.zoomValue)
    const originX = this.width * 0.5 + this.offsetX
    const originY = this.height * 0.5 + this.offsetY
    const sprite = this.checker.sprite
    const matches =
      Math.abs(sprite.width - this.width) < 0.01 &&
      Math.abs(sprite.height - this.height) < 0.01 &&
      Math.abs(sprite.tileScale.x - cell) < 0.01 &&
      Math.abs(sprite.tilePosition.x - originX) < 0.01 &&
      Math.abs(sprite.tilePosition.y - originY) < 0.01
    if (matches) return false
    this.checker.layout(this.width, this.height, cell, originX, originY)
    return true
  }

  async init(options: ViewportOptions = {}): Promise<void> {
    await this.app.init({
      canvas: this.canvas,
      background: options.background ?? '#1a1a1c',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      preference: 'webgl',
      autoStart: false,
      powerPreference: 'high-performance'
    })
    if (this.destroyed) {
      // 销毁时**不要**传 true：`destroy(true)` 等价于 releaseGlobalResources，
      // 会清空 Pixi 的**模块级全局批处理池**（GlobalResourceRegistry 里把所有
      // 池内 Batch 都 destroy 掉，textures 被置 null）。池是跨渲染器共享的，
      // 清掉之后另一个还活着的渲染器会从池里拿到已销毁的 Batch，
      // 表现为 `Batcher.break` 里抛 "Cannot read properties of null (reading 'clear')"。
      // React StrictMode 下「挂载 → 卸载 → 再挂载」时，第一次 init 未完成就走这里，
      // 正好会踩中。这里只想释放自己的 renderer，不动全局池。
      this.app.destroy({ removeView: false })
      return
    }
    // 背景棋盘格在最底层，铺满整块画布
    this.app.stage.addChildAt(this.checker.sprite, 0)
    this.ready = true
    // pixi 初始化时 renderer 是默认的 800×600，先按宿主真实尺寸对齐一次；
    // 若此刻宿主还没布局（尺寸为 0），hostObserver 会在尺寸就绪时补上。
    this.syncHostSize()
    this.applyCamera()
    this.render()
  }

  get isReady(): boolean {
    return this.ready && !this.destroyed
  }

  get zoom(): number {
    return this.zoomValue
  }

  /**
   * 视口尺寸（逻辑 / CSS 像素）。
   *
   * 注意：pixi v8 的 `renderer.width` 已经是**逻辑尺寸**（内部 backing store 才是
   * `逻辑尺寸 × resolution`），所以**不能**再除以 resolution——那样在 Retina
   * （DPR=2）屏上会把视口算成一半，导致棋盘格/坐标轴只铺左上角一块、
   * 且拾取坐标整体错位。这里统一用 `renderer.screen`。
   * renderer 在 init 完成前不可用，先退回宿主元素尺寸，避免早期 fit / 拾取抛错。
   */
  get width(): number {
    const screen = this.app.renderer?.screen
    if (!screen) return this.host.clientWidth || 1
    return screen.width
  }

  get height(): number {
    const screen = this.app.renderer?.screen
    if (!screen) return this.host.clientHeight || 1
    return screen.height
  }

  /** 平移（屏幕像素增量） */
  pan(dxScreen: number, dyScreen: number): void {
    this.offsetX += dxScreen
    this.offsetY += dyScreen
    this.applyCamera()
  }

  /** 以屏幕上的某点为锚点缩放 */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const before = this.screenToWorld(screenX, screenY)
    this.zoomValue = clampZoom(this.zoomValue * factor)
    this.applyCamera()
    const after = this.screenToWorld(screenX, screenY)
    this.offsetX += (after.x - before.x) * this.zoomValue
    this.offsetY -= (after.y - before.y) * this.zoomValue
    this.applyCamera()
    this.onZoomChange(this.zoomValue)
  }

  setZoom(zoom: number): void {
    this.zoomValue = clampZoom(zoom)
    this.applyCamera()
    this.onZoomChange(this.zoomValue)
  }

  setOffset(x: number, y: number): void {
    this.offsetX = x
    this.offsetY = y
    this.applyCamera()
  }

  get offset(): { x: number; y: number } {
    return { x: this.offsetX, y: this.offsetY }
  }

  /**
   * 适配视野：把**内容包围盒居中**并缩放到刚好装下（四周留 padding 像素）。
   *
   * 曾经是「世界原点钉在屏幕中心」：角色不在原点附近建模时（导入的 Spine 资源、
   * 被拖到别处的部件），点适配后内容会偏在一角、甚至半个身子在视野外。
   * 现在直接以包围盒中心为屏幕中心，横纵各算一次缩放取较小的那个。
   */
  fit(bounds: ViewportBounds | null, padding = 48): void {
    const usableWidth = this.width - padding * 2
    const usableHeight = this.height - padding * 2
    const degenerate =
      !bounds ||
      bounds.maxX - bounds.minX < 1e-6 ||
      bounds.maxY - bounds.minY < 1e-6 ||
      usableWidth <= 1 ||
      usableHeight <= 1

    if (degenerate) {
      // 空场景 / 退化包围盒：回到原点居中 + 默认尺度。
      // 默认尺度取 PPU（1 单位 = 100px，与附件尺寸折算一致）：这个比例下屏幕像素
      // 与原图像素一一对应，拖图落点数值也符合直觉（zoom=1 时屏幕 1px 的误差会
      // 1:1 写进 position，看起来像「坐标错了」）
      this.offsetX = 0
      this.offsetY = 0
      this.zoomValue = EMPTY_SCENE_ZOOM
      this.applyCamera()
      this.onZoomChange(this.zoomValue)
      return
    }

    const contentWidth = bounds.maxX - bounds.minX
    const contentHeight = bounds.maxY - bounds.minY
    this.zoomValue = clampZoom(Math.min(usableWidth / contentWidth, usableHeight / contentHeight))
    // 包围盒中心 → 屏幕中心。由 worldToScreen 反解：
    //   screenX = cx * zoom + width/2 + offsetX = width/2  ⇒ offsetX = -cx * zoom
    //   screenY = -cy * zoom + height/2 + offsetY = height/2 ⇒ offsetY = cy * zoom
    const centerX = (bounds.minX + bounds.maxX) * 0.5
    const centerY = (bounds.minY + bounds.maxY) * 0.5
    this.offsetX = -centerX * this.zoomValue
    this.offsetY = centerY * this.zoomValue
    this.applyCamera()
    this.onZoomChange(this.zoomValue)
  }

  /**
   * 把世界点居中并缩放（层级树里双击节点聚焦）。
   *
   * 与 `fit` 的差别：fit 是「全部内容铺满视口」（只留固定的 padding 像素），
   * 这里只把**一个目标点**摆到屏幕中心、内容只占 `fill` 比例 ——
   * 双击一个偏在角落的节点时，希望看到它和周围的上下文，而不是把整个角色塞满屏幕。
   * `fill` 默认 0.5（与 camera.ts 的 FRAME_FILL 一致）。
   */
  frame(worldX: number, worldY: number, contentWidth: number, contentHeight: number, fill = 0.5): void {
    const camera = framingCamera({
      width: this.width,
      height: this.height,
      worldX,
      worldY,
      contentWidth,
      contentHeight,
      fill
    })
    this.zoomValue = camera.zoom
    this.offsetX = camera.offsetX
    this.offsetY = camera.offsetY
    this.applyCamera()
    this.onZoomChange(this.zoomValue)
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.width * 0.5 - this.offsetX) / this.zoomValue,
      y: -(screenY - this.height * 0.5 - this.offsetY) / this.zoomValue
    }
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX * this.zoomValue + this.width * 0.5 + this.offsetX,
      y: -worldY * this.zoomValue + this.height * 0.5 + this.offsetY
    }
  }

  /** 屏幕像素 → 世界长度（画线宽度用） */
  pixelsToWorld(pixels: number): number {
    return pixels / this.zoomValue
  }

  resize(width: number, height: number): void {
    if (!this.isReady) return
    if (width <= 0 || height <= 0) return
    this.app.renderer.resize(width, height)
    this.applyCamera()
    this.render()
  }

  render(): void {
    if (!this.isReady) return
    this.app.render()
  }

  destroy(): void {
    this.destroyed = true
    this.hostObserver?.disconnect()
    if (this.ready) {
      // 先自己释放棋盘格（含纹理），再从 stage 摘掉，避免 app.destroy 二次销毁
      this.checker.destroy()
      // 同样不传 true：见 init() 里对 releaseGlobalResources 的说明
      this.app.destroy({ removeView: false }, { children: true })
      this.ready = false
    }
    if (this.canvas.parentElement === this.host) this.host.removeChild(this.canvas)
  }

  private applyCamera(): void {
    if (!this.isReady) return
    const originX = this.width * 0.5 + this.offsetX
    const originY = this.height * 0.5 + this.offsetY
    this.world.scale.set(this.zoomValue, -this.zoomValue)
    this.world.position.set(originX, originY)
    // 棋盘格：铺满整块画布、格点对齐世界原点、格子屏幕边长锁在可选区间
    this.syncBackground()
  }

  /**
   * 每帧由场景调用：先兜底尺寸，再兜底背景（都是幂等的）。
   * @returns 是否发生了变化（变化时调用方需要重绘，否则会留下空白/残影）
   */
  syncFrame(): boolean {
    const sizeChanged = this.syncHostSize()
    const backgroundChanged = this.syncBackground()
    return sizeChanged || backgroundChanged
  }
}
