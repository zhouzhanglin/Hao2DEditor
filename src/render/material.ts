import { ImageSource, Texture } from 'pixi.js'
import type { BLEND_MODES } from 'pixi.js'
import { BlendMode } from '@core/model/types'
import type { RGBA } from '@core/model/types'
import { loadImageElement } from '@render/imageLoader'
import { t } from '@i18n'

export interface BlendModeResolution {
  /** pixi 混合模式名 */
  mode: BLEND_MODES
  /** 不支持时给出的提示（null = 原生支持） */
  warning: string | null
}

/**
 * BlendMode → pixi 混合模式。
 * Erase / Below / None 需要多 pass 或绘制顺序语义，首版降级为 normal 并给出提示。
 * 遮罩不走混合模式，而是 `AttachmentType.Clipping` 的多边形裁剪。
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
      return {
        mode: 'normal',
        warning: t('混合模式 Erase 需要额外遮罩流程，视口中降级为 Normal')
      }
    case BlendMode.Below:
      return {
        mode: 'normal',
        warning: t('混合模式 Below 依赖绘制顺序语义，视口中降级为 Normal')
      }
    case BlendMode.None:
      return {
        mode: 'normal',
        warning: t('混合模式 None 的“不绘制”语义在视口中降级为 Normal')
      }
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

/** 用 <img> 加载图片并转成纹理（为什么要绕开 Assets.load，见 imageLoader 的说明） */
async function loadTextureFromUrl(url: string): Promise<Texture> {
  const image = await loadImageElement(url)
  const source = new ImageSource({ resource: image, alphaMode: 'premultiply-alpha-on-upload' })
  return new Texture({ source })
}

/**
 * 图集页纹理仓库。名称 = asset.textureNames 里的 png 名。
 * 未加载到纹理时返回 Texture.WHITE，保证几何仍然可见（便于排查 UV/网格问题）。
 */
export class TextureStore {
  private readonly textures = new Map<string, Texture>()
  private readonly loading = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /**
   * 「这个名字的贴图被清过几次」。
   *
   * 解码是异步的：清掉某张图（换项目、图集页换了源路径）之后，**之前那次**解码可能迟到落地。
   * 靠它把迟到的结果丢掉 —— 否则上一份图集页会重新占住这个名字，而新资源的同名图集页又会因为
   * `textures.has(name)` 被跳过，画面里贴的依旧是旧图。
   */
  private readonly revisions = new Map<string, number>()

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
    const revision = this.revision(name)
    this.loading.add(name)
    const texture = await loadTextureFromUrl(url).catch((error: unknown) => {
      console.error(`[hao2d] 纹理加载失败：${name}`, error)
      return null
    })
    // 期间被清过：这次加载作废。`loading` 标记也不动 —— 新的那次加载已经接管这个名字了
    if (this.revision(name) !== revision) return this.get(name)
    this.loading.delete(name)
    if (texture) this.set(name, texture)
    return this.get(name)
  }

  /**
   * 释放一张纹理。
   *
   * 换资源时必须用：不同角色的图集页常常**同名**（DragonBones 示例里 4 个角色都叫 `texture.png`），
   * 只按名字判断「已加载」会继续用上一份贴图 —— 表现就是新导入的零件张冠李戴。
   */
  delete(name: string): void {
    this.invalidate(name)
    const texture = this.textures.get(name)
    if (!texture) return
    this.textures.delete(name)
    texture.destroy(true)
    this.notify()
  }

  clear(): void {
    // 正在加载的也要作废：它们的 URL 都属于「上一份资源」
    for (const name of [...this.textures.keys(), ...this.loading]) this.invalidate(name)
    for (const texture of this.textures.values()) texture.destroy(true)
    this.textures.clear()
    this.notify()
  }

  /** 作废这个名字上「正在进行 / 已排队的加载」，并允许立刻重新加载 */
  private invalidate(name: string): void {
    this.revisions.set(name, this.revision(name) + 1)
    this.loading.delete(name)
  }

  private revision(name: string): number {
    return this.revisions.get(name) ?? 0
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
