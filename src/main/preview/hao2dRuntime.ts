import { Application, Container } from 'pixi.js'
import { loadRuntime } from '@core/runtime/loader'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import { decomposeTrs } from '@core/math/matrix'
import { NestRuntime } from '@core/nesting/nestRuntime'
import { TextureStore } from '@render/material'
import { SkeletonView } from '@render/skeletonView'

/**
 * hao2d 的 pixi 运行库（预览页用）。
 *
 * 把项目里「hao2d 的 pixi 计算方式」（解码 / 加载 / 播放 / 渲染）原样搬到浏览器：
 * 由 `scripts/build-hao2d-runtime.mjs` 用 esbuild 打包成 IIFE（`hao2dRuntime.generated.js`）。
 * **pixi 不打包进本库**——`import ... from 'pixi.js'` 被 alias 重定向到 `pixiShim.ts`，
 * 运行时从全局 `PIXI` 取，pixi 由预览页用独立的 `<script src="pixi.js">` 单独加载
 * （与 spine 预览把 spine-core 单独加载同思路）。
 *
 * 相机变换完全复刻编辑器 `render/viewport.ts`：世界容器 `scale.set(zoom, -zoom)`（y 轴向上），
 * 世界原点落在视口中心 + 偏移。
 *
 * **世界尺度与 spine 预览页（app.js）严格一致**：spine 预览吃的是导出的 spine JSON，
 * 那边的坐标全部乘过 `RUNTIME_PPU`（见 spineExport.ts 的 `x * RUNTIME_PPU`），即世界单位 = 像素；
 * 而这里用的 MeshBuilder 输出的是**内部单位**（1 单位 = ppu 像素）。所以网格容器要额外乘 ppu，
 * 否则取景 zoom 会小 ppu 倍（表现为角色比 spine 预览小一大截、滚轮放大到顶也涨不上去、
 * 棋盘格疏密对不上）——见 createStage 里 `view.container.scale.set(ppu, ppu)`。
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
  setSkin(name: string): void
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

  const maps = buildRuntimeMaps(asset, '')
  const skeleton = new Skeleton(asset)
  skeleton.applyRuntimeMaps(maps)

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
  const view = new SkeletonView(asset, textures, '')
  // 内部单位 → 像素：补上这层缩放后，世界坐标的数值才和导出的 spine JSON 一致
  // （spine 预览的取景 zoom、棋盘格、缩放限位都是按「世界单位 = 像素」算的）
  view.container.scale.set(ppu, ppu)
  world.addChild(view.container)
  app.stage.addChild(world)

  const player = new AnimationPlayer(asset, skeleton)

  /*
   * 嵌套骨架的视图树：每层一个 `NestRuntime` + 若干子 `SkeletonView`。
   * 用递归结构而不是单层，是因为子骨架自己也可能是别人的父骨架（A 挂 B、B 挂 C）。
   */
  interface NestLayer {
    nest: NestRuntime | null
    views: Map<string, { view: SkeletonView; time: number; child: NestLayer }>
  }
  function createNestLayer(skin: string): NestLayer {
    return {
      nest:
        nestedAssets.size > 0
          ? new NestRuntime((name) => {
              const target = nestedAssets.get(name)
              return target ? { asset: target, skinName: skin } : null
            }, skin)
          : null,
      views: new Map()
    }
  }
  function destroyLayer(layer: NestLayer): void {
    for (const entry of layer.views.values()) {
      entry.view.container.removeFromParent()
      entry.view.destroy()
      destroyLayer(entry.child)
    }
    layer.views.clear()
  }
  function syncLayer(
    layer: NestLayer,
    source: RuntimeAsset,
    sk: Skeleton,
    pl: AnimationPlayer,
    host: SkeletonView
  ): void {
    if (!layer.nest) return
    const instances = layer.nest.update(source, sk, pl, host.result?.nestAnchors)
    const live = new Set<string>()
    const layers: Array<{ layer: number; container: Container }> = []
    for (const instance of instances) {
      live.add(instance.key)
      let entry = layer.views.get(instance.key)
      if (!entry || entry.view.runtimeAsset !== instance.asset) {
        if (entry) {
          entry.view.container.removeFromParent()
          entry.view.destroy()
          destroyLayer(entry.child)
        }
        entry = {
          view: new SkeletonView(instance.asset, textures, activeSkin),
          time: Number.NaN,
          child: createNestLayer(activeSkin)
        }
        layer.views.set(instance.key, entry)
      }
      const parts = decomposeTrs(instance.matrix)
      entry.view.container.position.set(parts.x, parts.y)
      entry.view.container.rotation = (parts.rotation * Math.PI) / 180
      entry.view.container.scale.set(parts.scaleX, parts.scaleY)
      entry.view.container.visible = instance.visible
      const tint = entry.view.meshBuilder.tint
      const next = instance.tint
      if (tint.r !== next.r || tint.g !== next.g || tint.b !== next.b || tint.a !== next.a) {
        entry.view.setTint({ r: next.r, g: next.g, b: next.b, a: next.a })
      }
      if (!(Math.abs(entry.time - instance.childTime) <= 1e-9)) {
        entry.view.markDirty()
        entry.time = instance.childTime
      }
      entry.view.update(instance.skeleton)
      syncLayer(entry.child, instance.asset, instance.skeleton, instance.player, entry.view)
      layers.push({ layer: instance.layer, container: entry.view.container })
    }
    for (const [key, entry] of [...layer.views]) {
      if (live.has(key)) continue
      entry.view.container.removeFromParent()
      entry.view.destroy()
      destroyLayer(entry.child)
      layer.views.delete(key)
    }
    host.setNestedViews(layers)
  }
  const animations = asset.animations.map((animation) => animation.name)
  const skins = asset.skins.map((skin) => skin.name)
  const defaultAnimation = animations[0] ?? ''
  // 导出包里带的是「导出时的默认皮肤」（可能不是 skins[0]，例如当前在 goblin 皮肤上编辑）
  const defaultSkin =
    input.defaultSkin && skins.includes(input.defaultSkin) ? input.defaultSkin : skins[0] ?? ''
  /** 当前生效的叠加皮肤：子骨架视图与它们自己的皮肤合并都要跟着它走 */
  let activeSkin = defaultSkin
  let rootLayer = createNestLayer(activeSkin)

  let zoom = 1
  let offsetX = 0
  let offsetY = 0
  let speed = 1
  let playing = true
  let dirty = true
  /** 用户自己拖过 / 缩过：之后视口尺寸变化不再自动取景（与 spine 预览的 touched 同语义） */
  let touched = false
  /** 还欠一次「按内容取景」：挂载时包围盒若退化，等首帧几何变有效再补上 */
  let autoFit = true
  let last = 0
  let destroyed = false

  if (defaultSkin) {
    view.setSkin(defaultSkin)
    // 皮肤不只影响 mesh 分组：`slotDisplayIndex` / `slotAttIndex` 也要按合并后的皮肤重建，
    // 否则只在当前皮肤里存在的 display（例如 goblin 皮肤里的嵌套骨架）会保持 -1 而不渲染
    skeleton.applyRuntimeMaps(buildRuntimeMaps(asset, defaultSkin))
  }

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
    dirty = true
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
    dirty = true
  }

  /** 当前几何的包围盒，换算成像素单位的世界坐标（与 spine 预览同一把尺子） */
  function worldBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    // 直接用 MeshBuilder 算出来的真实顶点包围盒（skeleton 世界坐标系，y 轴向上，单位是内部单位），
    // 这是编辑器视口取景用的同一份数据，比 pixi 的 getLocalBounds 对自定义 Mesh 更可靠。
    const b = view.result?.bounds
    if (!b) return null
    return { minX: b.minX * ppu, minY: b.minY * ppu, maxX: b.maxX * ppu, maxY: b.maxY * ppu }
  }

  function fit(): void {
    // 适配 = 把相机交还给自动取景：之后视口尺寸变化会重新按内容取景（与 spine 预览一致）
    touched = false
    const b = worldBounds()
    // 包围盒无效时**什么都不改**（spine 预览的 fitView 也是直接 return），留着让首帧兜底再取景一次
    if (!b || b.maxX - b.minX < 1e-6 || b.maxY - b.minY < 1e-6) return
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
    dirty = true
  }

  function resize(width: number, height: number): void {
    if (destroyed || width <= 0 || height <= 0) return
    // 与 spine 预览一样按**当前** devicePixelRatio 出图：跨屏拖动 / 系统缩放变了也不会发虚
    app.renderer.resize(width, height, Math.min(2, globalThis.devicePixelRatio || 1))
    // 视口尺寸变了（含手机横竖屏切换）：用户没手动调过相机就重新取景，
    // 免得按旧视口算出来的缩放让角色跑出视野
    if (touched) applyCamera()
    else fit()
    dirty = true
  }

  function frame(now: number): void {
    if (destroyed) return
    const delta = last ? Math.min((now - last) / 1000, 0.1) : 0
    last = now
    if (playing) {
      player.update(delta * speed)
      view.markDirty()
    }
    view.update(skeleton)
    syncLayer(rootLayer, asset, skeleton, player, view)
    // 首帧兜底：挂载时包围盒退化（空骨架 / 几何未就绪）就等有效几何再取景一次。
    // 用户碰过相机（touched）后不再兜底，避免把调好的视角冲掉
    if (autoFit && !touched) {
      const b = worldBounds()
      if (b && b.maxX - b.minX > 1e-6 && b.maxY - b.minY > 1e-6) fit()
    }
    if (playing || dirty) {
      app.render()
      dirty = false
    }
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
  skeleton.updateFk()
  view.update(skeleton)
  if (defaultAnimation) player.play(defaultAnimation, true)
  requestAnimationFrame(frame)

  return {
    app,
    world,
    animations,
    skins,
    defaultAnimation,
    defaultSkin,
    play(name?: string, loop = true) {
      player.play(name ?? defaultAnimation, loop)
      playing = true
      dirty = true
    },
    crossFade(name: string, duration = 0.2, loop = true) {
      player.crossFade(name, duration, loop)
      playing = true
      dirty = true
    },
    stop() {
      player.stop()
      playing = false
      dirty = true
    },
    pause() {
      playing = false
      dirty = true
    },
    resume() {
      playing = true
      dirty = true
    },
    seek(seconds: number) {
      player.seek(seconds)
      dirty = true
    },
    setProgress(normalized: number) {
      player.seek(player.duration * Math.max(0, Math.min(1, normalized)))
      dirty = true
    },
    setSkin(name: string) {
      view.setSkin(name)
      // 与编辑器同一套：换肤后重建运行期映射（基底皮肤 + 叠加皮肤），再按当前时间重采样显示通道
      skeleton.applyRuntimeMaps(buildRuntimeMaps(asset, name))
      player.seek(player.time)
      view.markDirty()
      /*
       * 子骨架视图按「当前皮肤」建自己的运行期映射（基底皮肤 + 叠加皮肤）：
       * 换皮肤后必须重建，否则子骨架仍停在上一套皮肤的附件上（部件错位 / 消失）。
       */
      activeSkin = name || defaultSkin
      destroyLayer(rootLayer)
      view.setNestedViews([])
      rootLayer = createNestLayer(activeSkin)
      dirty = true
    },
    setLoop(loop: boolean) {
      player.loop = loop
    },
    setSpeed(scale: number) {
      speed = scale
    },
    get duration() {
      return player.duration
    },
    get time() {
      return player.time
    },
    get playing() {
      return playing
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
      destroyLayer(rootLayer)
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
