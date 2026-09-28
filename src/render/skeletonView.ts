import { Buffer, BufferUsage, Container, Geometry, Mesh, Texture } from 'pixi.js'
import { MeshBuilder } from '@core/skin/meshBuilder'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { RuntimeAsset } from '@core/model/asset'
import type { Skeleton } from '@core/model/skeleton'
import { resolveBlendMode, rgbaToHexNumber, TextureStore } from './material'

const POSITION_BYTES_PER_VERTEX = 8
const UV_BYTES_PER_VERTEX = 8
const INDEX_BYTES = 4

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

  constructor(asset: RuntimeAsset, textures: TextureStore, skinName = '') {
    this.asset = asset
    this.textures = textures
    this.builder = new MeshBuilder(asset, skinName)
    this.container.label = 'hao2d-skeleton'
  }

  get meshBuilder(): MeshBuilder {
    return this.builder
  }

  get currentSkin(): string {
    return this.builder.currentSkin
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

    return result
  }

  destroy(): void {
    for (const mesh of this.meshes) mesh.destroy()
    for (const geometry of this.geometries) geometry.destroy()
    this.positionBuffer?.destroy()
    this.uvBuffer?.destroy()
    this.colorBuffer?.destroy()
    this.meshes = []
    this.geometries = []
    this.indexBuffers = []
    this.indexArrays = []
    this.container.removeChildren()
  }

  // ---------------- 内部 ----------------

  private syncVertexBuffers(result: MeshBuildResult): void {
    const needsRebuild =
      !this.positionBuffer ||
      !this.uvBuffer ||
      this.positionBuffer.data !== result.positions ||
      this.uvBuffer.data !== result.uvs

    if (needsRebuild) {
      this.positionBuffer?.destroy()
      this.uvBuffer?.destroy()
      this.positionBuffer = new Buffer({
        data: result.positions,
        usage: BufferUsage.VERTEX,
        label: 'hao2d-positions'
      })
      this.uvBuffer = new Buffer({
        data: result.uvs,
        usage: BufferUsage.VERTEX,
        label: 'hao2d-uvs'
      })
      // 顶点缓冲换新后，所有几何体需要重新绑定属性
      for (let i = 0; i < this.geometries.length; i++) {
        this.geometries[i].addAttribute('aPosition', {
          buffer: this.positionBuffer,
          format: 'float32x2'
        })
        this.geometries[i].addAttribute('aUV', { buffer: this.uvBuffer, format: 'float32x2' })
      }
    } else {
      const positionBuffer = this.positionBuffer
      const uvBuffer = this.uvBuffer
      positionBuffer?.update(result.vertexCount * POSITION_BYTES_PER_VERTEX)
      uvBuffer?.update(result.vertexCount * UV_BYTES_PER_VERTEX)
    }
  }

  private syncGroups(result: MeshBuildResult): void {
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i]
      const mesh = this.ensureMesh(i)
      const geometry = this.geometries[i]

      // 索引缓冲：pixi 用索引数组的长度推导绘制数量，
      // 因此数组长度必须**精确等于**该组的索引数，否则会画出多出来的垃圾三角形。
      let array = this.indexArrays[i]
      let indexBuffer = this.indexBuffers[i]
      if (!array || array.length !== group.indexCount) {
        array = new Uint32Array(group.indexCount)
        this.indexArrays[i] = array
        const buffer = new Buffer({
          data: array,
          usage: BufferUsage.INDEX,
          label: `hao2d-indices-${i}`
        })
        indexBuffer?.destroy()
        this.indexBuffers[i] = buffer
        geometry.addIndex(buffer)
        indexBuffer = buffer
      }
      array.set(group.indices.subarray(0, group.indexCount), 0)
      indexBuffer.update(group.indexCount * INDEX_BYTES)

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

  private ensureMesh(index: number): Mesh<Geometry> {
    const existing = this.meshes[index]
    if (existing) return existing

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
