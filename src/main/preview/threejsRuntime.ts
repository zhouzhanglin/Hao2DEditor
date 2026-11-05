import * as Three from 'three'
import { loadRuntime } from '@core/runtime/loader'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset, RuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import { ThreeSkeletonView, loadThreeTextures } from './threejsView'
import type { NestedLayerView, PageInput, ThreeTextureStore } from './threejsView'
import { Hao2dViewCore } from './hao2dViewCore'
import type { Hao2dRenderAdapter, NestedChildLayer } from './hao2dViewCore'

/**
 * three.js 版 Hao2D 运行库（由 `scripts/build-threejs-runtime.mjs` 打成 IIFE，
 * 浏览器里全局名 `Hao2dThreeRuntime`；导出的 `hao2d-three.js` 也就是这个文件）。
 *
 * 计算层完全复用编辑器 / pixi 运行库的那一套：`loadRuntime` 解码、`Skeleton` 姿态、
 * `AnimationPlayer` 采样、`MeshBuilder` 蒙皮与分组、`NestRuntime` 子骨架时钟，
 * 只有渲染后端换成 three（`threejsView.ts`）。
 *
 * 除了 `Hao2dStage` 那套播放 / 相机接口，本运行库还按 Unity 端
 * `Assets/Hao2D/Runtime/IHao2DView.cs` 的语义提供换装 / 显隐 / 显示下标 / 嵌套子骨架：
 *
 * ```js
 * const view = await Hao2dThreeRuntime.createView({ pages, skeText, atlasText })
 * view.setSkin('goblin')
 * view.setSlotAttachment('weaponL', 'sword_02')
 * view.setSlotVisible('eyes', false)
 * view.setSlotDisplayIndex('weaponL', 1, true)
 * view.getNested('handL')?.setSlotAttachment('weapon', 'axe')
 * ```
 *
 * 与 C# 的对应关系（JS 没有重载 / 扩展方法，参数用联合类型，扩展方法做成实例方法）：
 * - `SetSkin` / `SetSlotAttachment` / `SetSlotVisible` / `SetSlotDisplayIndex` → 同名小驼峰；
 * - `GetNested` / `HasNested` / `nestedCount` / `skeleton` / `FindSlotIndex` /
 *   `FindAttachmentIndex` / `GetSlotDisplayIndex` → 同名小驼峰 / getter；
 * - `Hao2DViewExtensions` 的 `SetNestedSlot*` / `SetNestedSkin` → `setNestedSlot*` / `setNestedSkin`；
 * - 另补 `clearSlot*Override` 与 `slotNames` / `attachmentNames` / `nestedSlotNames`（查询用）。
 */

/**
 * three 本体也挂到全局对象上：宿主工程可以直接用同一份 THREE 建场景 / 相机。
 *
 * - 自包含构建（预览页 / 编辑器内部）里 `Three` 就是打包进来的命名空间；
 * - 瘦版构建（resources/runtimes/hao2d-three.js）里 three 不打进来，优先用宿主已有的全局 `THREE`，
 *   避免同一个页面里出现两份 three。
 */
export const THREE = (globalThis as unknown as { THREE?: typeof Three }).THREE ?? Three

export interface ViewInput {
  /** 图集页 PNG 字节（名字与 atlas.json 的 pages[].image 一致） */
  pages: PageInput[]
  /** `*_ske.json` 文本 */
  skeText: string
  /** `*_atlas.json` 文本 */
  atlasText: string
  /** 导出时的默认皮肤（= 编辑器当前皮肤）；缺省用第一个皮肤 */
  defaultSkin?: string
  /** 被嵌套引用的子骨架文本（骨架名 → ske 文本）；共用父骨架的图集 */
  nested?: Array<{ armatureName: string; skeText: string }>
  /** 挂到已有的 three 场景；不传时 `view.group` 可自行 add 到任意 Object3D */
  parent?: Three.Object3D
  /** 1 单位 = ppu 像素；缺省读 ske 里的 ppu */
  ppu?: number
}

export interface StageInput extends ViewInput {
  canvas: HTMLCanvasElement
  /** 背景色（CSS 颜色串）；不传 = 透明底，由页面下层画棋盘格 */
  background?: string
}

export interface Hao2dView {
  /** 底层骨架（只读；高级用法 / 调试），与 IHao2DView.skeleton 对应 */
  readonly skeleton: Skeleton
  readonly asset: RuntimeAsset
  /** 可直接 add 到宿主 three 场景的根节点（已按 ppu 缩放） */
  readonly group: Three.Group
  readonly animations: string[]
  readonly skins: string[]
  readonly defaultAnimation: string
  readonly defaultSkin: string
  /** 当前生效的皮肤名（叠加皮肤；空串 = 只用基底皮肤） */
  readonly activeSkin: string
  readonly slotNames: string[]
  /** 含 Armature 类型附件的插槽（嵌套子骨架可能挂在上面） */
  readonly nestedSlotNames: string[]
  /** 当前激活的嵌套子骨架数量（不含停用复用的实例） */
  readonly nestedCount: number
  /** 某插槽在当前合并皮肤里的附件名（换装 / 显示下标用） */
  attachmentNames(slot: string | number): string[]

  /** 切换皮肤（与基底皮肤叠加）；名字不存在返回 false 并保持当前皮肤 */
  setSkin(skinName: string): boolean
  /** 换装：附件可传名字或下标；插槽可传名字或下标 */
  setSlotAttachment(slot: string | number, attachment: string | number): boolean
  setSlotVisible(slot: string | number, visible: boolean): boolean
  /** displayIndex = -1 表示不显示；force = true 时压过动画的 attachment 轨道 */
  setSlotDisplayIndex(slot: string | number, displayIndex: number, force?: boolean): boolean
  getSlotDisplayIndex(slot: string | number): number
  findSlotIndex(slotName: string): number
  findAttachmentIndex(slotIndex: number, attachmentName: string): number

  getNested(slot: string | number): Hao2dView | null
  hasNested(slotName: string): boolean
  /** Hao2DViewExtensions 的对等实现：直接操作子骨架内部 */
  setNestedSlotAttachment(parentSlotName: string, slot: string | number, attachment: string | number): boolean
  setNestedSlotVisible(parentSlotName: string, slot: string | number, visible: boolean): boolean
  setNestedSlotDisplayIndex(parentSlotName: string, slot: string | number, displayIndex: number, force?: boolean): boolean
  setNestedSkin(parentSlotName: string, skinName: string): boolean

  clearSlotAttachmentOverride(slot: string | number): boolean
  clearSlotVisibleOverride(slot: string | number): boolean
  clearSlotDisplayOverride(slot: string | number): boolean

  play(name?: string, loop?: boolean): boolean
  crossFade(name: string, duration?: number, loop?: boolean): boolean
  stop(): void
  pause(): void
  resume(): void
  seek(seconds: number): void
  setProgress(normalized: number): void
  setLoop(loop: boolean): void
  setSpeed(scale: number): void
  readonly duration: number
  readonly time: number
  readonly playing: boolean
  /** 当前几何包围盒（像素尺度，视口取景用） */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 每帧推进（root 自己驱动时间；嵌套子骨架由父级驱动，不要手动调） */
  update(dt: number): void
  destroy(): void
}

/** 预览页用的舞台：与 pixi 版 `Hao2dStage` 同一套契约，加一个 `view`（IHao2DView 能力） */
export interface Hao2dThreeStage {
  readonly view: Hao2dView
  readonly scene: Three.Scene
  readonly camera: Three.OrthographicCamera
  readonly renderer: Three.WebGLRenderer
  readonly world: Three.Group
  readonly animations: string[]
  readonly skins: string[]
  readonly defaultAnimation: string
  readonly defaultSkin: string
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
  readonly zoom: number
  readonly centerX: number
  readonly centerY: number
  pan(dx: number, dy: number): void
  zoomAt(factor: number, sx: number, sy: number): void
  fit(): void
  resize(width: number, height: number): void
  screenToWorld(sx: number, sy: number): { x: number; y: number }
  destroy(): void
}

/** 与 spine / pixi 预览页一致：两边的滚轮、双指缩放手感必须一模一样 */
const MIN_ZOOM = 0.02
const MAX_ZOOM = 40

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
}

function readPpu(skeText: string): number {
  try {
    const value = (JSON.parse(skeText) as { ppu?: unknown }).ppu
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RUNTIME_PPU
  } catch {
    return RUNTIME_PPU
  }
}

interface ThreeViewOptions {
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  maps: RuntimeMaps
  textures: ThreeTextureStore
  nestedAssets: Map<string, RuntimeAsset>
  ppu: number
  skinName: string
  isRoot: boolean
  parent?: Three.Object3D
}

/** three 的渲染适配器：视图核心只认「节点 + 局部变换 + 嵌套层」，其余由这里接 */
class ThreeRenderAdapter implements Hao2dRenderAdapter<ThreeSkeletonView> {
  constructor(private readonly textures: ThreeTextureStore) {}

  create(asset: RuntimeAsset, skinName: string): ThreeSkeletonView {
    return new ThreeSkeletonView(asset, this.textures, skinName)
  }

  node(view: ThreeSkeletonView): Three.Group {
    return view.group
  }

  setRootScale(node: unknown, ppu: number): void {
    ;(node as Three.Group).scale.set(ppu, ppu, 1)
  }

  setLocalTransform(
    node: unknown,
    x: number,
    y: number,
    rotationDeg: number,
    scaleX: number,
    scaleY: number
  ): void {
    const group = node as Three.Group
    group.position.set(x, y, 0)
    group.rotation.set(0, 0, (rotationDeg * Math.PI) / 180)
    group.scale.set(scaleX, scaleY, 1)
  }

  setVisible(node: unknown, visible: boolean): void {
    ;(node as Three.Object3D).visible = visible
  }

  isVisible(node: unknown): boolean {
    return (node as Three.Object3D).visible
  }

  removeFromParent(node: unknown): void {
    ;(node as Three.Object3D).removeFromParent()
  }

  setNestedViews(view: ThreeSkeletonView, layers: readonly NestedChildLayer<ThreeSkeletonView>[]): void {
    view.setNestedViews(
      layers.map((layer): NestedLayerView => ({ layer: layer.layer, order: layer.order, view: layer.view }))
    )
  }

  assignRenderOrder(view: ThreeSkeletonView, start: number): void {
    view.assignRenderOrder(start)
  }

  /** root 销毁时释放纹理（子骨架共用同一份纹理，不能重复释放） */
  dispose(_view: ThreeSkeletonView): void {
    this.textures.dispose()
  }
}

/** three 版视图：核心逻辑在 Hao2dViewCore，这里只补 three 的根节点与渲染适配器 */
class ThreeHao2dView extends Hao2dViewCore<ThreeSkeletonView> {
  constructor(options: ThreeViewOptions) {
    super({
      asset: options.asset,
      skeleton: options.skeleton,
      player: options.player,
      maps: options.maps,
      skinName: options.skinName,
      isRoot: options.isRoot,
      ppu: options.ppu,
      nestedAssets: options.nestedAssets,
      adapter: new ThreeRenderAdapter(options.textures),
      createChild: (init) =>
        new ThreeHao2dView({
          ...init,
          textures: options.textures,
          nestedAssets: options.nestedAssets,
          ppu: options.ppu,
          isRoot: false
        })
    })
    if (options.parent) options.parent.add(this.group)
  }

  get group(): Three.Group {
    return this.mountNode as Three.Group
  }
}

/** 创建内部实现（预览舞台与对外 createView 共用） */
async function createViewImpl(input: ViewInput): Promise<ThreeHao2dView> {
  const loaded = loadRuntime(input.skeText, input.atlasText)
  const asset = loaded.asset
  // 子骨架与父骨架共用同一套图集页，这里按骨架名登记（含传递依赖）
  const nestedAssets = new Map<string, RuntimeAsset>()
  for (const item of input.nested ?? []) {
    try {
      const nested = loadRuntime(item.skeText, input.atlasText)
      nestedAssets.set(nested.asset.armatureName || item.armatureName, nested.asset)
    } catch {
      // 子骨架数据损坏：父骨架上那个 display 不渲染（与「引用缺失」表现一致）
    }
  }

  const textures = await loadThreeTextures(input.pages)
  const ppu = input.ppu ?? readPpu(input.skeText)
  const skins = asset.skins.map((skin) => skin.name)
  // 优先用调用方指定的皮肤，其次用 ske 文件里记的「导出时编辑器当前皮肤」，最后回落第一个
  const embeddedSkin = asset.defaultSkin ?? ''
  const defaultSkin =
    input.defaultSkin && skins.includes(input.defaultSkin)
      ? input.defaultSkin
      : embeddedSkin && skins.includes(embeddedSkin)
        ? embeddedSkin
        : (skins[0] ?? '')
  const maps = buildRuntimeMaps(asset, defaultSkin)
  const skeleton = new Skeleton(asset)
  skeleton.applyRuntimeMaps(maps)
  const player = new AnimationPlayer(asset, skeleton)
  const view = new ThreeHao2dView({
    asset,
    skeleton,
    player,
    maps,
    textures,
    nestedAssets,
    ppu,
    skinName: defaultSkin,
    isRoot: true,
    parent: input.parent
  })
  // 先按 setup pose 出几何（取景用），再启动默认动画 —— 顺序与 spine / pixi 预览页一致
  view.buildSetupPose()
  if (view.defaultAnimation) view.play(view.defaultAnimation, true)
  return view
}

/** 把角色接进已有的 three 场景：宿主自己调 `view.update(dt)` 并在渲染循环里画 */
export async function createView(input: ViewInput): Promise<Hao2dView> {
  return createViewImpl(input)
}

/** 预览页舞台：自带 WebGLRenderer / 正交相机 / 自动帧循环 */
export async function createStage(input: StageInput): Promise<Hao2dThreeStage> {
  const view = await createViewImpl(input)
  const renderer = new Three.WebGLRenderer({
    canvas: input.canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false
  })
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
  if (input.background) {
    try {
      renderer.setClearColor(new Three.Color(input.background), 1)
    } catch {
      renderer.setClearColor(new Three.Color('#000000'), 0)
    }
  } else {
    renderer.setClearColor(new Three.Color('#000000'), 0)
  }
  const scene = new Three.Scene()
  const camera = new Three.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
  camera.position.set(0, 0, 10)
  const world = new Three.Group()
  world.name = 'hao2d-three-world'
  scene.add(world)
  world.add(view.group)

  let width = Math.max(1, input.canvas.clientWidth || globalThis.innerWidth || 1)
  let height = Math.max(1, input.canvas.clientHeight || globalThis.innerHeight || 1)
  let zoom = 1
  let offsetX = 0
  let offsetY = 0
  let touched = false
  let autoFit = true
  let last = 0
  let destroyed = false

  function applyCamera(): void {
    camera.position.set(-offsetX / zoom, offsetY / zoom, 10)
    camera.left = -width / (2 * zoom)
    camera.right = width / (2 * zoom)
    camera.top = height / (2 * zoom)
    camera.bottom = -height / (2 * zoom)
    camera.updateProjectionMatrix()
  }

  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - width * 0.5 - offsetX) / zoom,
      y: -(sy - height * 0.5 - offsetY) / zoom
    }
  }

  function fit(): void {
    touched = false
    const b = view.bounds
    if (b.maxX - b.minX < 1e-6 || b.maxY - b.minY < 1e-6) return
    autoFit = false
    const pad = 1.12
    const w = Math.max(1, b.maxX - b.minX)
    const h = Math.max(1, b.maxY - b.minY)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    zoom = Math.min(width / (w * pad), height / (h * pad))
    offsetX = -cx * zoom
    offsetY = cy * zoom
    applyCamera()
  }

  function resize(w: number, h: number): void {
    if (destroyed || w <= 0 || h <= 0) return
    width = w
    height = h
    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    renderer.setSize(width, height, false)
    if (touched) applyCamera()
    else fit()
  }

  function frame(now: number): void {
    if (destroyed) return
    const delta = last ? Math.min((now - last) / 1000, 0.1) : 0
    last = now
    view.update(delta)
    // 首帧包围盒退化（空骨架 / 几何未就绪）时，等有效几何再取景一次
    if (autoFit && !touched) {
      const b = view.bounds
      if (b.maxX - b.minX > 1e-6 && b.maxY - b.minY > 1e-6) fit()
    }
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }

  resize(width, height)
  applyCamera()
  requestAnimationFrame(frame)

  return {
    view,
    scene,
    camera,
    renderer,
    world,
    animations: view.animations,
    skins: view.skins,
    defaultAnimation: view.defaultAnimation,
    defaultSkin: view.defaultSkin,
    play(name?: string, loop = true) {
      view.play(name, loop)
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
    pan(dx: number, dy: number) {
      touched = true
      offsetX += dx
      offsetY += dy
      applyCamera()
    },
    zoomAt(factor: number, sx: number, sy: number) {
      touched = true
      const before = screenToWorld(sx, sy)
      zoom = clampZoom(zoom * factor)
      applyCamera()
      const after = screenToWorld(sx, sy)
      offsetX += (after.x - before.x) * zoom
      offsetY -= (after.y - before.y) * zoom
      applyCamera()
    },
    fit,
    resize,
    screenToWorld,
    destroy() {
      destroyed = true
      view.destroy()
      world.remove(view.group)
      renderer.dispose()
    }
  }
}
