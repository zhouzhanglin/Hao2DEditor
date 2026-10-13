import { Application, Container } from 'pixi.js'
import { loadRuntime } from '@core/runtime/loader'
import { buildRuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
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

const EMPTY_ZOOM = 100

function clampZoom(zoom: number): number {
  return Math.max(0.01, Math.min(64, zoom))
}

export async function createStage(input: StageInput): Promise<Hao2dStage> {
  const loaded = loadRuntime(input.skeText, input.atlasText)
  const asset = loaded.asset

  const maps = buildRuntimeMaps(asset, '')
  const skeleton = new Skeleton(asset)
  skeleton.applyRuntimeMaps(maps)

  const textures = new TextureStore()
  const blobUrls: string[] = []
  for (const name of asset.textureNames) {
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

  const world = new Container()
  const view = new SkeletonView(asset, textures, '')
  world.addChild(view.container)
  app.stage.addChild(world)

  const player = new AnimationPlayer(asset, skeleton)
  const animations = asset.animations.map((animation) => animation.name)
  const skins = asset.skins.map((skin) => skin.name)
  const defaultAnimation = animations[0] ?? ''
  const defaultSkin = skins[0] ?? ''

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

  if (defaultSkin) view.setSkin(defaultSkin)

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

  function fit(): void {
    // 适配 = 把相机交还给自动取景：之后视口尺寸变化会重新按内容取景（与 spine 预览一致）
    touched = false
    offsetX = 0
    offsetY = 0
    // 直接用 MeshBuilder 算出来的真实顶点包围盒（skeleton 世界坐标系，y 轴向上），
    // 这是编辑器视口取景用的同一份数据，比 pixi 的 getLocalBounds 对自定义 Mesh 更可靠。
    const b = view.result?.bounds
    if (!b || b.maxX - b.minX < 1e-6 || b.maxY - b.minY < 1e-6) {
      zoom = EMPTY_ZOOM
      applyCamera()
      dirty = true
      // 这次没按内容取景成功：保留 autoFit，等几何变有效后由首帧兜底补一次
      return
    }
    autoFit = false
    // 与 spine 预览一致：以角色包围盒中心取景、四周留 1.12 倍边距
    const pad = 1.12
    const width = Math.max(1, b.maxX - b.minX)
    const height = Math.max(1, b.maxY - b.minY)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    zoom = clampZoom(Math.min(viewWidth() / (width * pad), viewHeight() / (height * pad)))
    offsetX = -cx * zoom
    offsetY = cy * zoom
    applyCamera()
    dirty = true
  }

  function resize(width: number, height: number): void {
    if (destroyed || width <= 0 || height <= 0) return
    app.renderer.resize(width, height)
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
    // 首帧兜底：挂载时包围盒退化（空骨架 / 几何未就绪）就等有效几何再取景一次。
    // 用户碰过相机（touched）后不再兜底，避免把调好的视角冲掉
    if (autoFit && !touched) {
      const b = view.result?.bounds
      if (b && b.maxX - b.minX > 1e-6 && b.maxY - b.minY > 1e-6) fit()
    }
    if (playing || dirty) {
      app.render()
      dirty = false
    }
    requestAnimationFrame(frame)
  }

  applyCamera()
  if (defaultAnimation) player.play(defaultAnimation, true)
  // 先把骨架摆到动画第 0 帧并算出世界矩阵，再构建一次几何 —— 这样 mount() 里同步调用的
  // fit() 就能拿到有效的包围盒、立刻把角色居中，不再等到首帧（首帧若包围盒退化会退化成原点居中）。
  player.refresh()
  skeleton.updateFk()
  view.update(skeleton)
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
      view.markDirty()
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
