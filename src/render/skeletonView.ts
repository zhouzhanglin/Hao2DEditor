import { Buffer, BufferUsage, Container, Geometry, Mesh, Texture } from 'pixi.js'
import { MeshBuilder } from '@core/skin/meshBuilder'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { RuntimeAsset } from '@core/model/asset'
import type { Skeleton } from '@core/model/skeleton'
import { resolveBlendMode, rgbaToHexNumber, TextureStore } from './material'

const POSITION_BYTES_PER_VERTEX = 8
const UV_BYTES_PER_VERTEX = 8
const INDEX_BYTES = 4

/** 要插进本视图里的嵌套骨架子视图（`layer` = 插在第几个绘制分组之前） */
export interface NestedLayerView {
  layer: number
  /** 同一层内的绘制顺序（drawOrder 动画交换相邻嵌套时不画反）；缺省 0 */
  order?: number
  container: Container
}

/**
 * 角色渲染视图：把 MeshBuilder 的输出搬进 pixi。
 *
 * 每个 (图集页, 混合模式, 颜色) 分组一个 `Mesh`，几何体**共享同一份
 * 顶点 / UV 缓冲**（跨 Geometry 复用同一 Buffer 对象），每帧只上传一次顶点；
 * 索引缓冲按组独立，仅在拓扑或数量变化时重建。
 */
export class SkeletonView {
  readonly container = new Container()

  private readonly asset: RuntimeAsset
  private readonly textures: TextureStore
  private readonly builder: MeshBuilder

  private meshes: Array<Mesh<Geometry>> = []
  private geometries: Geometry[] = []
  private indexBuffers: Buffer[] = []
  private indexArrays: Uint32Array[] = []

  private positionBuffer: Buffer | null = null
  private uvBuffer: Buffer | null = null
  private colorBuffer: Buffer | null = null

  private dirty = true
  private lastResult: MeshBuildResult | null = null
  private triangleCount = 0
  /** 嵌套骨架的子视图（由 Scene 创建 / 销毁，本视图只负责摆放与重排） */
  private nestedViews: NestedLayerView[] = []
  /** 纹理加载完成后的取消订阅句柄（见构造里的说明） */
  private unsubscribeTextures: (() => void) | null = null

  constructor(asset: RuntimeAsset, textures: TextureStore, skinName = '') {
    this.asset = asset
    this.textures = textures
    this.builder = new MeshBuilder(asset, skinName)
    this.container.label = 'hao2d-skeleton'
    // 纹理是**异步**加载完的：到位后必须重同步一次，否则网格会一直停在 Texture.WHITE
    //（白块，见 TextureStore.get 的兜底），直到某次编辑触发重建才恢复 ——
    // 用户看到的就是「工程刚打开时 display 是白的，点一下显示 / 隐藏才正常」
    this.unsubscribeTextures = textures.onChange(() => this.markDirty())
  }

  get meshBuilder(): MeshBuilder {
    return this.builder
  }

  get currentSkin(): string {
    return this.builder.currentSkin
  }

  /** 本视图对应的编译产物（Scene 用它判断子视图是否需要换 asset 重建） */
  get runtimeAsset(): RuntimeAsset {
    return this.asset
  }

  /**
   * 设置嵌套骨架的子视图。
   *
   * `layer` = 「本视图已生成的第几个分组之前」：0 表示压在所有分组下面，
   * `groups.length` 表示压在最上面。无嵌套时传空数组即可（行为与原先一致）。
   */
  setNestedViews(views: readonly NestedLayerView[]): void {
    for (const old of this.nestedViews) {
      if (!views.some((view) => view.container === old.container)) old.container.removeFromParent()
    }
    this.nestedViews = views.map((view) => ({
      layer: view.layer,
      order: view.order ?? 0,
      container: view.container
    }))
    this.orderChildren()
  }

  /** 子骨架视图由 Scene 拥有：这里只摘除、不销毁 */
  detachNestedViews(): void {
    for (const view of this.nestedViews) view.container.removeFromParent()
    this.nestedViews = []
  }

  get result(): MeshBuildResult | null {
    return this.lastResult
  }

  get stats(): { vertices: number; triangles: number; groups: number } {
    return {
      vertices: this.lastResult?.vertexCount ?? 0,
      triangles: this.triangleCount,
      groups: this.lastResult?.groups.length ?? 0
    }
  }

  setTint(color: { r: number; g: number; b: number; a: number }): void {
    this.builder.tint = color
    this.markDirty()
  }

  setSkin(skinName: string): void {
    this.builder.setSkin(skinName)
    this.markDirty()
  }

  /**
   * 只显示某个插槽的附件（-1 = 显示全部）。
   * 网格工具用它隔离当前编辑的网格：复杂角色上十几层网格互相遮挡，
   * 顶点、线框和纹理叠在一起，根本看不清在编哪一个。
   */
  setIsolation(slotIndex: number, displayIndex = -1): void {
    if (this.builder.isolateSlot === slotIndex && this.builder.isolateDisplay === displayIndex) return
    this.builder.isolateSlot = slotIndex
    this.builder.isolateDisplay = displayIndex
    this.markDirty()
  }

  markDirty(): void {
    this.dirty = true
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /** 脏标记驱动：只有标记为脏时才重算蒙皮并上传 */
  update(skeleton: Skeleton): MeshBuildResult | null {
    if (!this.dirty || !skeleton) return this.lastResult
    this.dirty = false

    const result = this.builder.build(skeleton)
    this.lastResult = result
    this.triangleCount = 0

    this.syncVertexBuffers(result)
    this.syncGroups(result)
    this.orderChildren()

    return result
  }

  destroy(): void {
    // 先摘子容器：子视图归 Scene 管，不能跟着父视图一起 removeChildren 后变成孤儿
    this.detachNestedViews()
    this.unsubscribeTextures?.()
    this.unsubscribeTextures = null
    for (const mesh of this.meshes) mesh.destroy()
    for (const geometry of this.geometries) geometry.destroy()
    this.positionBuffer?.destroy()
    this.uvBuffer?.destroy()
    this.colorBuffer?.destroy()
    for (const buffer of this.indexBuffers) buffer?.destroy()
    this.meshes = []
    this.geometries = []
    this.indexBuffers = []
    this.indexArrays = []
    this.container.removeChildren()
  }

  // ---------------- 内部 ----------------

  /**
   * 顶点缓冲：**只创建一次，之后原地换数据**。
   *
   * 不要 destroy + 重建 + 重新绑定：绘制顺序变化会让顶点数量变化，进而走到重建分支，
   * 而上一帧已经提交的渲染指令仍引用着那个被销毁的 buffer，pixi 渲染时读到 null，
   * 抛 `Cannot read properties of null (reading 'usage')` —— 异常冒到渲染循环外层，
   * 整个视口就此定格（画面不动、拖拽缩放全无反应，但面板照常可用）。
   */
  private syncVertexBuffers(result: MeshBuildResult): void {
    this.ensureVertexBuffers(result.positions, result.uvs)
    // 数组换了（容量增长时重建过）就原地替换，buffer 对象本身保持同一个
    if (this.positionBuffer && this.positionBuffer.data !== result.positions) {
      this.positionBuffer.data = result.positions
    }
    if (this.uvBuffer && this.uvBuffer.data !== result.uvs) this.uvBuffer.data = result.uvs
    this.positionBuffer?.update(result.vertexCount * POSITION_BYTES_PER_VERTEX)
    this.uvBuffer?.update(result.vertexCount * UV_BYTES_PER_VERTEX)
  }

  /**
   * 顶点缓冲只创建一次。
   *
   * 空数组兜底是为了让 `ensureMesh` 在任何时机调用都安全：它构造 Geometry 时会
   * 直接把 buffer 绑进 attributes，若此时缓冲还是空的（null），pixi 渲染会读到 null
   * 抛 `Cannot read properties of null (reading 'usage')`。
   */
  private ensureVertexBuffers(positions?: Float32Array, uvs?: Float32Array): void {
    if (this.positionBuffer && this.uvBuffer) return
    this.positionBuffer = new Buffer({
      data: positions ?? new Float32Array(0),
      usage: BufferUsage.VERTEX,
      label: 'hao2d-positions'
    })
    this.uvBuffer = new Buffer({
      data: uvs ?? new Float32Array(0),
      usage: BufferUsage.VERTEX,
      label: 'hao2d-uvs'
    })
    for (let i = 0; i < this.geometries.length; i++) {
      if (!this.geometries[i]) continue
      this.geometries[i].addAttribute('aPosition', {
        buffer: this.positionBuffer,
        format: 'float32x2'
      })
      this.geometries[i].addAttribute('aUV', { buffer: this.uvBuffer, format: 'float32x2' })
    }
  }

  private syncGroups(result: MeshBuildResult): void {
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i]
      const mesh = this.ensureMesh(i)
      const geometry = this.geometries[i]

      // 索引缓冲：pixi 用索引数组的长度推导绘制数量，
      // 因此数组长度必须**精确等于**该组的索引数，否则会画出多出来的垃圾三角形。
      //
      // 长度变化时**原地换 data**，不 destroy 重建 —— 绘制顺序变化会让分组索引数变化，
      // 而上一帧已提交的渲染指令仍引用旧 buffer，销毁后 pixi 会读到 null 直接抛错。
      let array = this.indexArrays[i]
      let indexBuffer = this.indexBuffers[i]
      if (!array || array.length !== group.indexCount) {
        array = new Uint32Array(group.indexCount)
        this.indexArrays[i] = array
        if (indexBuffer) {
          indexBuffer.data = array
        } else {
          indexBuffer = new Buffer({
            data: array,
            usage: BufferUsage.INDEX,
            label: `hao2d-indices-${i}`
          })
          this.indexBuffers[i] = indexBuffer
          geometry.addIndex(indexBuffer)
        }
      }
      array.set(group.indices.subarray(0, group.indexCount), 0)
      indexBuffer?.update(group.indexCount * INDEX_BYTES)

      const textureName = this.asset.textureNames[group.materialIndex] ?? ''
      const texture: Texture = this.textures.get(textureName)
      if (mesh.texture !== texture) mesh.texture = texture

      mesh.tint = rgbaToHexNumber(group.color)
      mesh.alpha = group.color.a
      const blend = resolveBlendMode(group.blendMode)
      if (mesh.blendMode !== blend.mode) mesh.blendMode = blend.mode
      mesh.visible = true

      this.triangleCount += Math.floor(group.indexCount / 3)
    }

    for (let i = result.groups.length; i < this.meshes.length; i++) {
      this.meshes[i].visible = false
    }
  }

  /**
   * 按「分组 → 紧跟其后的子视图」重排子节点，保证嵌套骨架穿在正确的层。
   *
   * 只在顺序真的变了才 `addChildAt`：顺序没变时每帧重排会让 pixi 反复改显示列表，
   * 白白制造脏标记。
   */
  private orderChildren(): void {
    const groups = this.meshes.length
    const byLayer = new Map<number, NestedLayerView[]>()
    let maxLayer = 0
    for (const view of this.nestedViews) {
      const list = byLayer.get(view.layer) ?? []
      list.push(view)
      byLayer.set(view.layer, list)
      if (view.layer > maxLayer) maxLayer = view.layer
    }
    // 同一层的多个子骨架按绘制顺序排（Map 的插入顺序是实例创建顺序，drawOrder 变了也不会跟）
    for (const list of byLayer.values()) {
      if (list.length > 1) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }

    const desired: Container[] = []
    for (let layer = 0; layer < groups; layer++) {
      const nested = byLayer.get(layer)
      if (nested) for (const view of nested) desired.push(view.container)
      const mesh = this.meshes[layer]
      if (mesh) desired.push(mesh)
    }
    for (let layer = Math.max(groups, 0); layer <= maxLayer; layer++) {
      const nested = byLayer.get(layer)
      if (nested) for (const view of nested) desired.push(view.container)
    }

    const current = this.container.children
    if (current.length === desired.length) {
      let same = true
      for (let i = 0; i < desired.length; i++) {
        if (current[i] !== desired[i]) {
          same = false
          break
        }
      }
      if (same) return
    }
    for (let i = 0; i < desired.length; i++) this.container.addChildAt(desired[i], i)
  }

  private ensureMesh(index: number): Mesh<Geometry> {
    const existing = this.meshes[index]
    if (existing) return existing

    // 绑进 attributes 的 buffer 绝不能是 null（pixi 渲染读到 null 会直接抛 usage 报错），
    // 正常流程里 syncVertexBuffers 已经建好，这里只是兜底
    this.ensureVertexBuffers()

    const geometry = new Geometry({
      label: `hao2d-geometry-${index}`,
      attributes: {
        aPosition: { buffer: this.positionBuffer as Buffer, format: 'float32x2' },
        aUV: { buffer: this.uvBuffer as Buffer, format: 'float32x2' }
      }
    })
    const mesh = new Mesh({ geometry, texture: Texture.WHITE })
    mesh.label = `hao2d-group-${index}`
    this.geometries[index] = geometry
    this.meshes[index] = mesh
    this.container.addChild(mesh)
    return mesh
  }
}
