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
 * 由 `scripts/build-hao2d-runtime.mjs` 用 esbuild 把它和 `pixi.js` 一起打包成
 * 自包含 IIFE（`hao2dRuntime.generated.js`），再由预览服务以 `?raw` 内联发给浏览器，
 * 整页不依赖任何外网资源（与 spine 预览架构一致）。
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
    offsetX += dx
    offsetY += dy
    applyCamera()
    dirty = true
  }

  function zoomAt(factor: number, sx: number, sy: number): void {
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
    offsetX = 0
    offsetY = 0
    const bounds = view.result?.bounds
    const degenerate = !bounds || bounds.maxX - bounds.minX < 1e-6 || bounds.maxY - bounds.minY < 1e-6
    if (degenerate) {
      zoom = EMPTY_ZOOM
    } else {
      // 与 spine 预览一致：以角色包围盒中心取景、四周留 1.12 倍边距
      const pad = 1.12
      const width = Math.max(1, bounds.maxX - bounds.minX)
      const height = Math.max(1, bounds.maxY - bounds.minY)
      const cx = (bounds.minX + bounds.maxX) / 2
      const cy = (bounds.minY + bounds.maxY) / 2
      zoom = clampZoom(Math.min(viewWidth() / (width * pad), viewHeight() / (height * pad)))
      offsetX = -cx * zoom
      offsetY = cy * zoom
    }
    applyCamera()
    dirty = true
  }

  function resize(width: number, height: number): void {
    if (destroyed || width <= 0 || height <= 0) return
    app.renderer.resize(width, height)
    applyCamera()
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
    const rebuilt = view.update(skeleton)
    if (autoFit && rebuilt && view.result && view.result.bounds.maxX - view.result.bounds.minX > 1e-6) {
      fit()
      autoFit = false
    }
    if (playing || dirty || rebuilt) {
      app.render()
      dirty = false
    }
    requestAnimationFrame(frame)
  }

  applyCamera()
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
