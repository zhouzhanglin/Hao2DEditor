import { Assets, Texture } from 'pixi.js'
import type { BLEND_MODES } from 'pixi.js'
import { BlendMode } from '@core/model/types'
import type { RGBA } from '@core/model/types'

export interface BlendModeResolution {
  /** pixi 混合模式名 */
  mode: BLEND_MODES
  /** 不支持时给出的提示（null = 原生支持） */
  warning: string | null
}

/**
 * BlendMode → pixi 混合模式。
 * Erase / Mask / Below / None 需要遮罩或多 pass 流程，首版降级为 normal 并给出提示。
 */
export function resolveBlendMode(mode: BlendMode): BlendModeResolution {
  switch (mode) {
    case BlendMode.Additive:
      return { mode: 'add', warning: null }
    case BlendMode.Multiply:
      return { mode: 'multiply', warning: null }
    case BlendMode.Screen:
      return { mode: 'screen', warning: null }
    case BlendMode.Normal:
      return { mode: 'normal', warning: null }
    case BlendMode.Erase:
      return { mode: 'normal', warning: '混合模式 Erase 需要额外遮罩流程，视口中降级为 Normal' }
    case BlendMode.Mask:
      return { mode: 'normal', warning: '混合模式 Mask 需要额外遮罩流程，视口中降级为 Normal' }
    case BlendMode.Below:
      return { mode: 'normal', warning: '混合模式 Below 依赖绘制顺序语义，视口中降级为 Normal' }
    case BlendMode.None:
      return { mode: 'normal', warning: '混合模式 None 的“不绘制”语义在视口中降级为 Normal' }
    default:
      return { mode: 'normal', warning: null }
  }
}

export function rgbaToHexNumber(color: RGBA): number {
  const r = Math.round(Math.max(0, Math.min(1, color.r)) * 255)
  const g = Math.round(Math.max(0, Math.min(1, color.g)) * 255)
  const b = Math.round(Math.max(0, Math.min(1, color.b)) * 255)
  return (r << 16) | (g << 8) | b
}

/**
 * 图集页纹理仓库。名称 = asset.textureNames 里的 png 名。
 * 未加载到纹理时返回 Texture.WHITE，保证几何仍然可见（便于排查 UV/网格问题）。
 */
export class TextureStore {
  private readonly textures = new Map<string, Texture>()
  private readonly loading = new Set<string>()
  private readonly listeners = new Set<() => void>()

  get(name: string): Texture {
    return this.textures.get(name) ?? Texture.WHITE
  }

  has(name: string): boolean {
    return this.textures.has(name)
  }

  set(name: string, texture: Texture): void {
    this.textures.set(name, texture)
    this.notify()
  }

  /** 已加载完成的纹理数量（状态栏展示） */
  get loadedCount(): number {
    return this.textures.size
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 加载一张图片。url 由平台层提供（Electron 用 hao2d-file://，浏览器用 blob:）。
   * 加载失败时保持 Texture.WHITE，仅记录一次告警。
   */
  async load(name: string, url: string): Promise<Texture> {
    if (this.textures.has(name) || this.loading.has(name) || !url) return this.get(name)
    this.loading.add(name)
    const texture = await Assets.load<Texture>(url).catch((error: unknown) => {
      console.error(`[hao2d] 纹理加载失败：${name}`, error)
      return null
    })
    this.loading.delete(name)
    if (texture) this.set(name, texture)
    return this.get(name)
  }

  clear(): void {
    for (const texture of this.textures.values()) texture.destroy(true)
    this.textures.clear()
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
