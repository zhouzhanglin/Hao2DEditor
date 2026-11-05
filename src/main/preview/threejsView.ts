import * as Three from 'three'
import { MeshBuilder } from '@core/skin/meshBuilder'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import { BlendMode } from '@core/model/types'
import type { RGBA } from '@core/model/types'
import type { RuntimeAsset } from '@core/model/asset'
import type { Skeleton } from '@core/model/skeleton'

/**
 * three.js 版 Hao2D 骨架视图：把 `MeshBuilder` 的输出搬进 three 场景。
 *
 * 与 pixi 版 `render/skeletonView.ts` 同一套计算（解码 / 姿态 / 蒙皮 / 分组），
 * 只替换渲染后端：
 * - 所有绘制分组共享一份 position / uv 顶点缓冲（three 的 `BufferAttribute` 可以跨
 *   `BufferGeometry` 复用），每组各自一份 index；
 * - 每组一个 `Mesh` + `MeshBasicMaterial`，颜色取分组的统一 tint；
 * - `renderOrder` 按「分组 → 嵌套子视图」递归编号，保持画家算法顺序（three 默认按深度
 *   排透明物体，这里必须显式指定）；
 * - 纹理 `flipY = false`：`MeshBuilder` 写出的 v 已经是 pixi 口径（v=0 = 图像顶部），
 *   three 默认会翻转图片上传，关掉后两者 UV 完全一致。
 */
export interface PageInput {
  name: string
  bytes: Uint8Array
}

export interface ThreeTextureStore {
  /** 未加载到的页返回 1×1 白图（几何仍然可见，便于排查 UV 问题） */
  get(name: string): Three.Texture
  dispose(): void
}

/** 插进本视图里的嵌套骨架子视图（layer = 插在第几个绘制分组之前） */
export interface NestedLayerView {
  layer: number
  /** 同层内的绘制顺序 */
  order?: number
  view: ThreeSkeletonView
}

interface MeshEntry {
  mesh: Three.Mesh<Three.BufferGeometry, Three.MeshBasicMaterial>
  geometry: Three.BufferGeometry
  material: Three.MeshBasicMaterial
  indices: Uint16Array | Uint32Array
  indexAttr: Three.BufferAttribute
}

function whiteTexture(): Three.DataTexture {
  const data = new Uint8Array([255, 255, 255, 255])
  const texture = new Three.DataTexture(data, 1, 1, Three.RGBAFormat)
  texture.colorSpace = Three.SRGBColorSpace
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

/** 图集页 PNG 字节 → three 纹理（不依赖外网 / 模块系统，浏览器里用 blob: 解码） */
export async function loadThreeTextures(pages: readonly PageInput[]): Promise<ThreeTextureStore> {
  const textures = new Map<string, Three.Texture>()
  const fallback = whiteTexture()
  const urls: string[] = []
  const hasImage = typeof Image !== 'undefined'

  for (const page of pages) {
    if (!page?.bytes || page.bytes.length === 0) continue
    let image: HTMLImageElement | null = null
    if (hasImage) {
      const url = URL.createObjectURL(new Blob([page.bytes as BlobPart], { type: 'image/png' }))
      urls.push(url)
      image = new Image()
      image.src = url
      try {
        if (typeof image.decode === 'function') await image.decode()
        else await new Promise<void>((resolve, reject) => {
          image!.onload = () => resolve()
          image!.onerror = () => reject(new Error(`decode failed: ${page.name}`))
        })
      } catch {
        image = null
      }
    }
    if (!image) continue
    const texture = new Three.Texture(image)
    texture.colorSpace = Three.SRGBColorSpace
    // MeshBuilder 的 v 已经是 pixi 口径，three 不能再翻一次
    texture.flipY = false
    texture.minFilter = Three.LinearFilter
    texture.magFilter = Three.LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    textures.set(page.name, texture)
  }
  for (const url of urls) URL.revokeObjectURL(url)

  return {
    get(name: string): Three.Texture {
      return textures.get(name) ?? fallback
    },
    dispose(): void {
      for (const texture of textures.values()) texture.dispose()
      textures.clear()
      fallback.dispose()
    }
  }
}

function applyBlend(material: Three.MeshBasicMaterial, mode: number): void {
  material.blending = Three.NormalBlending
  material.blendEquation = Three.AddEquation
  material.blendSrc = Three.SrcAlphaFactor
  material.blendDst = Three.OneMinusSrcAlphaFactor
  switch (mode) {
    case BlendMode.Additive:
      material.blending = Three.AdditiveBlending
      break
    case BlendMode.Multiply:
      material.blending = Three.MultiplyBlending
      break
    case BlendMode.Screen:
      // src + (1 - src) * dst：three 没有内置 ScreenBlending，用自定义因子
      material.blending = Three.CustomBlending
      material.blendEquation = Three.AddEquation
      material.blendSrc = Three.OneFactor
      material.blendDst = Three.OneMinusSrcColorFactor
      break
    default:
      // Erase / Below / None 依赖额外 pass 或绘制顺序语义，与编辑器视口一样降级为 Normal
      break
  }
}

export class ThreeSkeletonView {
  readonly group = new Three.Group()

  private readonly asset: RuntimeAsset
  private readonly store: ThreeTextureStore
  private readonly builder: MeshBuilder
  private readonly meshes: MeshEntry[] = []
  private readonly nested: NestedLayerView[] = []

  private positionArray = new Float32Array(0)
  private positionAttr: Three.BufferAttribute | null = null
  private uvArray: Float32Array | null = null
  private uvAttr: Three.BufferAttribute | null = null
  private lastResult: MeshBuildResult | null = null
  private dirty = true

  constructor(asset: RuntimeAsset, store: ThreeTextureStore, skinName = '') {
    this.asset = asset
    this.store = store
    this.builder = new MeshBuilder(asset, skinName)
    this.group.name = 'hao2d-three-skeleton'
  }

  get meshBuilder(): MeshBuilder {
    return this.builder
  }

  get result(): MeshBuildResult | null {
    return this.lastResult
  }

  get runtimeAsset(): RuntimeAsset {
    return this.asset
  }

  setSkin(skinName: string): void {
    this.builder.setSkin(skinName)
    this.markDirty()
  }

  setTint(color: RGBA): void {
    this.builder.tint = color
    this.markDirty()
  }

  markDirty(): void {
    this.dirty = true
  }

  /** 子视图由所属的运行库创建 / 销毁，这里只负责挂到显示树并按层排序 */
  setNestedViews(views: readonly NestedLayerView[]): void {
    for (const old of this.nested) {
      if (!views.some((view) => view.view === old.view)) old.view.group.removeFromParent()
    }
    this.nested.length = 0
    for (const view of views) {
      this.nested.push({ layer: view.layer, order: view.order ?? 0, view: view.view })
      if (view.view.group.parent !== this.group) this.group.add(view.view.group)
    }
  }

  detachNestedViews(): void {
    for (const view of this.nested) view.view.group.removeFromParent()
    this.nested.length = 0
  }

  /** 按当前姿态重算几何并同步到 three 缓冲（脏标记驱动） */
  update(skeleton: Skeleton): MeshBuildResult | null {
    if (this.dirty && skeleton) {
      this.dirty = false
      const result = this.builder.build(skeleton)
      this.lastResult = result
      this.syncAttributes(result)
      this.syncGroups(result)
    }
    return this.lastResult
  }

  /**
   * 递归编号 `renderOrder`：先画本层之前的嵌套子骨架，再画本层分组。
   * 返回下一个可用序号，父视图据此接着排自己的分组。
   */
  assignRenderOrder(start: number): number {
    const groups = this.lastResult?.groups.length ?? 0
    const byLayer = new Map<number, NestedLayerView[]>()
    let maxLayer = groups - 1
    for (const view of this.nested) {
      const list = byLayer.get(view.layer) ?? []
      list.push(view)
      byLayer.set(view.layer, list)
      if (view.layer > maxLayer) maxLayer = view.layer
    }
    for (const list of byLayer.values()) {
      if (list.length > 1) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }
    let order = start
    for (let layer = 0; layer <= maxLayer; layer++) {
      for (const child of byLayer.get(layer) ?? []) order = child.view.assignRenderOrder(order)
      const mesh = this.meshes[layer]?.mesh
      if (mesh && mesh.visible) mesh.renderOrder = order++
    }
    return order
  }

  destroy(): void {
    // 子视图归运行库管：这里只摘除，不跟着一起销毁
    this.detachNestedViews()
    for (const entry of this.meshes) {
      entry.mesh.removeFromParent()
      entry.geometry.dispose()
      entry.material.dispose()
    }
    this.meshes.length = 0
    this.positionAttr = null
    this.uvAttr = null
    this.uvArray = null
    this.lastResult = null
    this.group.removeFromParent()
  }

  // ---------------- 内部 ----------------

  /** 顶点缓冲只创建一次；MeshBuilder 扩容（换数组）时重建 attribute 并重新绑给所有 geometry */
  private syncAttributes(result: MeshBuildResult): void {
    const capacity = Math.floor(result.positions.length / 2)
    const need = capacity * 3
    if (!this.positionAttr || !this.uvAttr || this.uvArray !== result.uvs || this.positionArray.length !== need) {
      this.positionArray = new Float32Array(need)
      this.positionAttr = new Three.BufferAttribute(this.positionArray, 3)
      this.uvArray = result.uvs
      this.uvAttr = new Three.BufferAttribute(this.uvArray, 2)
      for (const entry of this.meshes) {
        entry.geometry.setAttribute('position', this.positionAttr)
        entry.geometry.setAttribute('uv', this.uvAttr)
      }
    }
    for (let i = 0; i < result.vertexCount; i++) {
      this.positionArray[i * 3] = result.positions[i * 2]
      this.positionArray[i * 3 + 1] = result.positions[i * 2 + 1]
      this.positionArray[i * 3 + 2] = 0
    }
    this.positionAttr.needsUpdate = true
    this.uvAttr.needsUpdate = true
  }

  private syncGroups(result: MeshBuildResult): void {
    const useUint32 = result.vertexCount > 65535
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i]
      const entry = this.ensureMesh(i)
      const wanted = useUint32 ? Uint32Array : Uint16Array
      if (!(entry.indices instanceof wanted) || entry.indices.length !== group.indexCount) {
        entry.indices = new wanted(group.indexCount)
        entry.indexAttr = new Three.BufferAttribute(entry.indices, 1)
        entry.geometry.setIndex(entry.indexAttr)
      }
      entry.indices.set(group.indices.subarray(0, group.indexCount), 0)
      entry.indexAttr.needsUpdate = true
      entry.geometry.setDrawRange(0, group.indexCount)

      const texture = this.store.get(this.asset.textureNames[group.materialIndex] ?? '')
      if (entry.material.map !== texture) {
        entry.material.map = texture
        entry.material.needsUpdate = true
      }
      // 分组颜色是 sRGB 数值：交给 three 的色彩管理转换，输出回到与 pixi 相同的观感
      entry.material.color.setRGB(group.color.r, group.color.g, group.color.b, Three.SRGBColorSpace)
      entry.material.opacity = group.color.a
      applyBlend(entry.material, group.blendMode)
      entry.mesh.visible = true
    }
    for (let i = result.groups.length; i < this.meshes.length; i++) this.meshes[i].mesh.visible = false
  }

  private ensureMesh(index: number): MeshEntry {
    const existing = this.meshes[index]
    if (existing) return existing

    // syncAttributes 正常流程已建好这两个 attribute；这里只是兜底
    if (!this.positionAttr || !this.uvAttr) {
      this.positionArray = new Float32Array(3)
      this.positionAttr = new Three.BufferAttribute(this.positionArray, 3)
      this.uvArray = new Float32Array(2)
      this.uvAttr = new Three.BufferAttribute(this.uvArray, 2)
    }
    const geometry = new Three.BufferGeometry()
    geometry.setAttribute('position', this.positionAttr)
    geometry.setAttribute('uv', this.uvAttr)
    const indices = new Uint16Array(0)
    const indexAttr = new Three.BufferAttribute(indices, 1)
    geometry.setIndex(indexAttr)
    const material = new Three.MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: Three.DoubleSide,
      toneMapped: false,
      premultipliedAlpha: false
    })
    const mesh = new Three.Mesh(geometry, material)
    mesh.name = `hao2d-three-group-${index}`
    // three 默认按深度排透明物体：这里完全靠 renderOrder 维持绘制顺序
    mesh.frustumCulled = false
    this.group.add(mesh)
    const entry: MeshEntry = { mesh, geometry, material, indices, indexAttr }
    this.meshes[index] = entry
    return entry
  }
}
