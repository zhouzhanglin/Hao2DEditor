import { Application, Container } from 'pixi.js'
import { loadRuntime } from '@core/runtime/loader'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset, RuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import { TextureStore } from '@render/material'
import { SkeletonView } from '@render/skeletonView'
import { Hao2dViewCore } from './hao2dViewCore'
import type { Hao2dRenderAdapter, NestedChildLayer } from './hao2dViewCore'

/**
 * hao2d 的 pixi 运行库（预览页与 `resources/runtimes/hao2d-pixi.js` 共用）。
 *
 * 把项目里「hao2d 的 pixi 计算方式」（解码 / 加载 / 播放 / 渲染）原样搬到浏览器：
 * 由 `scripts/build-hao2d-runtime.mjs` 用 esbuild 打包成 IIFE（`hao2dRuntime.generated.js`）。
 * **pixi 不打包进本库**——`import ... from 'pixi.js'` 被 alias 重定向到 `pixiShim.ts`，
 * 运行时从全局 `PIXI` 取，pixi 由预览页用独立的 `<script src="pixi.js">` 单独加载
 * （与 spine 预览把 spine-core 单独加载同思路）。
 *
 * 插槽换装 / 显隐 / 显示下标 / 嵌套子骨架这些「与渲染无关」的逻辑和 three 版共用
 * `hao2dViewCore.ts`（语义对齐 Unity 的 `IHao2DView.cs`），本文件只提供 pixi 的渲染适配器。
 *
 * 相机变换完全复刻编辑器 `render/viewport.ts`：世界容器 `scale.set(zoom, -zoom)`（y 轴向上），
 * 世界原点落在视口中心 + 偏移。
 *
 * **世界尺度与 spine 预览页（app.js）严格一致**：spine 预览吃的是导出的 spine JSON，
 * 那边的坐标全部乘过 `RUNTIME_PPU`（见 spineExport.ts 的 `x * RUNTIME_PPU`），即世界单位 = 像素；
 * 而这里用的 MeshBuilder 输出的是**内部单位**（1 单位 = ppu 像素）。所以根容器要额外乘 ppu，
 * 否则取景 zoom 会小 ppu 倍（表现为角色比 spine 预览小一大截、滚轮放大到顶也涨不上去、
 * 棋盘格疏密对不上）——由 `PixiViewCore` 构造时按 ppu 缩放根容器。
 */

export interface PageInput {
  name: string
  bytes: Uint8Array
}

export interface StageInput {
  canvas: HTMLCanvasElement
  pages: PageInput[]
  skeText: string
  atlasText: string
  background?: string
  /** 导出时的默认皮肤（= 编辑器当前皮肤）；缺省用第一个皮肤 */
  defaultSkin?: string
  /** 被嵌套引用的子骨架文本（骨架名 → ske 文本）；共用父骨架的图集 */
  nested?: Array<{ armatureName: string; skeText: string }>
}

export interface Hao2dStage {
  /** IHao2DView 能力：换装 / 显隐 / 显示下标 / 嵌套子骨架 */
  readonly view: PixiHao2dView
  readonly skeleton: Skeleton
  app: Application
  world: Container
  animations: string[]
  skins: string[]
  defaultAnimation: string
  defaultSkin: string
  play(name?: string, loop?: boolean): void
  crossFade(name: string, duration?: number, loop?: boolean): void
  stop(): void
  pause(): void
  resume(): void
  seek(seconds: number): void
  setProgress(normalized: number): void
  setSkin(name: string): boolean
  setLoop(loop: boolean): void
  setSpeed(scale: number): void
  readonly duration: number
  readonly time: number
  readonly playing: boolean
  /** 当前缩放（世界单位 → 像素）：下层 #bg 画棋盘格时用它决定格子疏密 */
  readonly zoom: number
  /** 视口中心对应的世界坐标（x 向右、y 向上）：#bg 按它对齐格线原点 */
  readonly centerX: number
  readonly centerY: number
  pan(dx: number, dy: number): void
  zoomAt(factor: number, sx: number, sy: number): void
  fit(): void
  resize(width: number, height: number): void
  screenToWorld(sx: number, sy: number): { x: number; y: number }
  destroy(): void
}

/** 与 spine 预览页 app.js 的 zoomLimits() 完全一致：两边的滚轮 / 双指缩放手感必须一模一样 */
const MIN_ZOOM = 0.02
const MAX_ZOOM = 40

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
}

/** 读 ske 里的 ppu（1 单位 = ppu 像素）；缺省回落到运行时默认值 */
function readPpu(skeText: string): number {
  try {
    const value = (JSON.parse(skeText) as { ppu?: unknown }).ppu
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RUNTIME_PPU
  } catch {
    return RUNTIME_PPU
  }
}

interface PixiViewOptions {
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  maps: RuntimeMaps
  textures: TextureStore
  nestedAssets: Map<string, RuntimeAsset>
  ppu: number
  skinName: string
  isRoot: boolean
}

/** pixi 的渲染适配器：视图核心只认「节点 + 局部变换 + 嵌套层」，其余由这里接 */
class PixiRenderAdapter implements Hao2dRenderAdapter<SkeletonView> {
  constructor(private readonly textures: TextureStore) {}

  create(asset: RuntimeAsset, skinName: string): SkeletonView {
    return new SkeletonView(asset, this.textures, skinName)
  }

  node(view: SkeletonView): Container {
    return view.container
  }

  setRootScale(node: unknown, ppu: number): void {
    ;(node as Container).scale.set(ppu, ppu)
  }

  setLocalTransform(
    node: unknown,
    x: number,
    y: number,
    rotationDeg: number,
    scaleX: number,
    scaleY: number
  ): void {
    const container = node as Container
    container.position.set(x, y)
    container.rotation = (rotationDeg * Math.PI) / 180
    container.scale.set(scaleX, scaleY)
  }

  setVisible(node: unknown, visible: boolean): void {
    ;(node as Container).visible = visible
  }

  isVisible(node: unknown): boolean {
    return (node as Container).visible
  }

  removeFromParent(node: unknown): void {
    ;(node as Container).removeFromParent()
  }

  setNestedViews(view: SkeletonView, layers: readonly NestedChildLayer<SkeletonView>[]): void {
    view.setNestedViews(
      layers.map((layer) => ({ layer: layer.layer, order: layer.order, container: layer.view.container }))
    )
  }
}

/** pixi 版视图：核心逻辑在 Hao2dViewCore，这里只补 pixi 的根容器与渲染适配器 */
export class PixiHao2dView extends Hao2dViewCore<SkeletonView> {
  constructor(options: PixiViewOptions) {
    super({
      asset: options.asset,
      skeleton: options.skeleton,
      player: options.player,
      maps: options.maps,
      skinName: options.skinName,
      isRoot: options.isRoot,
      ppu: options.ppu,
      nestedAssets: options.nestedAssets,
      adapter: new PixiRenderAdapter(options.textures),
      createChild: (init) =>
        new PixiHao2dView({
          ...init,
          textures: options.textures,
          nestedAssets: options.nestedAssets,
          ppu: options.ppu,
          isRoot: false
        })
    })
  }

  get container(): Container {
    return this.mountNode as Container
  }
}

export async function createStage(input: StageInput): Promise<Hao2dStage> {
  const loaded = loadRuntime(input.skeText, input.atlasText)
  const asset = loaded.asset

  /*
   * 嵌套骨架：子骨架与父骨架共用同一套图集页，但各自编译产物里只登记「自己用到的页」。
   * 这里按并集加载，否则子骨架的贴图会是白块。
   */
  const nestedAssets = new Map<string, RuntimeAsset>()
  for (const item of input.nested ?? []) {
    try {
      const nested = loadRuntime(item.skeText, input.atlasText)
      nestedAssets.set(nested.asset.armatureName || item.armatureName, nested.asset)
    } catch {
      // 子骨架数据损坏：父骨架里那个 display 就不渲染（与「引用缺失」表现一致）
    }
  }

  const animations = asset.animations.map((animation) => animation.name)
  const skins = asset.skins.map((skin) => skin.name)
  const defaultAnimation = animations[0] ?? ''
  // 导出包里带的是「导出时的默认皮肤」（可能不是 skins[0]，例如当前在 goblin 皮肤上编辑）
  const defaultSkin =
    input.defaultSkin && skins.includes(input.defaultSkin) ? input.defaultSkin : skins[0] ?? ''

  const maps = buildRuntimeMaps(asset, defaultSkin)
  const skeleton = new Skeleton(asset)
  skeleton.applyRuntimeMaps(maps)
  const player = new AnimationPlayer(asset, skeleton)

  const textures = new TextureStore()
  const blobUrls: string[] = []
  const textureNames = [...asset.textureNames]
  for (const nested of nestedAssets.values()) {
    for (const name of nested.textureNames) if (!textureNames.includes(name)) textureNames.push(name)
  }
  for (const name of textureNames) {
    const page = input.pages.find((page) => page.name === name)
    if (page && page.bytes && page.bytes.length > 0) {
      const url = URL.createObjectURL(new Blob([page.bytes as BlobPart], { type: 'image/png' }))
      blobUrls.push(url)
      await textures.load(name, url)
    }
  }

  const app = new Application()
  await app.init({
    canvas: input.canvas,
    // 透明底：棋盘格 + 轴线由下层 #bg 画布绘制，与 spine 预览一致（角色经混合后透出）
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
    autoStart: false,
    preference: 'webgl'
  })

  const ppu = readPpu(input.skeText)
  const world = new Container()
  const view = new PixiHao2dView({
    asset,
    skeleton,
    player,
    maps,
    textures,
    nestedAssets,
    ppu,
    skinName: defaultSkin,
    isRoot: true
  })
  world.addChild(view.container)
  app.stage.addChild(world)

  let zoom = 1
  let offsetX = 0
  let offsetY = 0
  /** 用户自己拖过 / 缩过：之后视口尺寸变化不再自动取景（与 spine 预览的 touched 同语义） */
  let touched = false
  /** 还欠一次「按内容取景」：挂载时包围盒若退化，等首帧几何变有效再补上 */
  let autoFit = true
  let last = 0
  let destroyed = false

  function viewWidth(): number {
    return app.renderer.screen.width
  }

  function viewHeight(): number {
    return app.renderer.screen.height
  }

  function applyCamera(): void {
    world.scale.set(zoom, -zoom)
    world.position.set(viewWidth() * 0.5 + offsetX, viewHeight() * 0.5 + offsetY)
  }

  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - viewWidth() * 0.5 - offsetX) / zoom,
      y: -(sy - viewHeight() * 0.5 - offsetY) / zoom
    }
  }

  function pan(dx: number, dy: number): void {
    // 手动拖过就交出相机控制权：resize 与首帧兜底都不再自动取景
    touched = true
    offsetX += dx
    offsetY += dy
    applyCamera()
  }

  function zoomAt(factor: number, sx: number, sy: number): void {
    touched = true
    const before = screenToWorld(sx, sy)
    zoom = clampZoom(zoom * factor)
    applyCamera()
    const after = screenToWorld(sx, sy)
    offsetX += (after.x - before.x) * zoom
    offsetY -= (after.y - before.y) * zoom
    applyCamera()
  }

  /** 当前几何的包围盒（像素单位；与 spine 预览同一把尺子） */
  function worldBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    // 直接用 MeshBuilder 算出来的真实顶点包围盒（skeleton 世界坐标系，y 轴向上，单位是内部单位），
    // 这是编辑器视口取景用的同一份数据，比 pixi 的 getLocalBounds 对自定义 Mesh 更可靠。
    const b = view.bounds
    if (b.maxX - b.minX < 1e-6 || b.maxY - b.minY < 1e-6) return null
    return b
  }

  function fit(): void {
    // 适配 = 把相机交还给自动取景：之后视口尺寸变化会重新按内容取景（与 spine 预览一致）
    touched = false
    const b = worldBounds()
    // 包围盒无效时**什么都不改**（spine 预览的 fitView 也是直接 return），留着让首帧兜底再取景一次
    if (!b) return
    autoFit = false
    // 与 spine 预览一致：以角色包围盒中心取景、四周留 1.12 倍边距，且**不做缩放限位**
    //（spine 的 fitView 也不限位，限位只作用于滚轮 / 双指）
    const pad = 1.12
    const width = Math.max(1, b.maxX - b.minX)
    const height = Math.max(1, b.maxY - b.minY)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    zoom = Math.min(viewWidth() / (width * pad), viewHeight() / (height * pad))
    offsetX = -cx * zoom
    offsetY = cy * zoom
    applyCamera()
  }

  function resize(width: number, height: number): void {
    if (destroyed || width <= 0 || height <= 0) return
    // 与 spine 预览一样按**当前** devicePixelRatio 出图：跨屏拖动 / 系统缩放变了也不会发虚
    app.renderer.resize(width, height, Math.min(2, globalThis.devicePixelRatio || 1))
    // 视口尺寸变了（含手机横竖屏切换）：用户没手动调过相机就重新取景，
    // 免得按旧视口算出来的缩放让角色跑出视野
    if (touched) applyCamera()
    else fit()
  }

  function frame(now: number): void {
    if (destroyed) return
    const delta = last ? Math.min((now - last) / 1000, 0.1) : 0
    last = now
    // root 自己推进时间，嵌套子骨架由父级 NestRuntime 驱动（与 three 版同一套核心）
    view.update(delta)
    // 首帧兜底：挂载时包围盒退化（空骨架 / 几何未就绪）就等有效几何再取景一次。
    // 用户碰过相机（touched）后不再兜底，避免把调好的视角冲掉
    if (autoFit && !touched) {
      const b = worldBounds()
      if (b) fit()
    }
    // 每帧渲染：换装 / 显隐 / 换肤都直接作用于几何，暂停时也要能反映出来
    app.render()
    requestAnimationFrame(frame)
  }

  applyCamera()
  /*
   * 首次几何在 **setup pose** 上构建，顺序与 spine 预览页的加载流程一致：
   * 那边是 setupPose() → updateWorldTransform() → fitView() 取景，然后才 play() 动画。
   * 这里同样先算几何再启动动画（player.play 只改姿势，几何要等下一帧才重建），
   * 于是 mount() 里紧接着调用的 fit() 拿到的是 setup pose 的包围盒 ——
   * 初始缩放与角色初始位置因此和 spine 预览完全重合，不会再出现「动画第 0 帧的外扩/位移
   * 把取景带偏」。
   */
  view.buildSetupPose()
  if (defaultAnimation) view.play(defaultAnimation, true)
  requestAnimationFrame(frame)

  return {
    view,
    skeleton: view.skeleton,
    app,
    world,
    animations,
    skins,
    defaultAnimation,
    defaultSkin,
    play(name?: string, loop = true) {
      view.play(name ?? defaultAnimation, loop)
    },
    crossFade(name: string, duration = 0.2, loop = true) {
      view.crossFade(name, duration, loop)
    },
    stop() {
      view.stop()
    },
    pause() {
      view.pause()
    },
    resume() {
      view.resume()
    },
    seek(seconds: number) {
      view.seek(seconds)
    },
    setProgress(normalized: number) {
      view.setProgress(normalized)
    },
    setSkin(name: string) {
      return view.setSkin(name)
    },
    setLoop(loop: boolean) {
      view.setLoop(loop)
    },
    setSpeed(scale: number) {
      view.setSpeed(scale)
    },
    get duration() {
      return view.duration
    },
    get time() {
      return view.time
    },
    get playing() {
      return view.playing
    },
    get zoom() {
      return zoom
    },
    get centerX() {
      return -offsetX / zoom
    },
    get centerY() {
      return offsetY / zoom
    },
    pan,
    zoomAt,
    fit,
    resize,
    screenToWorld,
    destroy() {
      destroyed = true
      view.destroy()
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
      textures.clear()
      try {
        app.destroy({ removeView: false }, { children: true })
      } catch {
        /* 已销毁则忽略 */
      }
    }
  }
}
