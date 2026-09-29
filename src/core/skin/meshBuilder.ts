import { mulInto, trsInto } from '../math/matrix'
import type { Skeleton } from '../model/skeleton'
import { AttachmentType } from '../model/types'
import type { AttachmentData, RGBA } from '../model/types'
import type { RuntimeAsset, RuntimeMaps } from '../model/asset'
import { buildRuntimeMaps } from '../model/asset'

/**
 * 一个绘制分组。
 * 分组键 = (图集页, blendMode, 颜色)，**只与紧邻的上一组合并**，保证画家算法顺序。
 * 颜色进入分组键的原因：pixi 的内置 mesh 着色器不支持逐顶点色，
 * 整组共用一个 tint；颜色不同即拆组（渲染层 Mesh 数量 = 分组数）。
 */
export interface MeshGroup {
  /** 指向 asset.textureNames 的下标（图集页） */
  materialIndex: number
  blendMode: number
  /** 该组统一颜色（RGBA，0..1） */
  color: RGBA
  indices: Uint32Array
  indexCount: number
}

export interface MeshBuildResult {
  /** 复用缓冲，长度 = 容量 * 2；有效范围 [0, vertexCount * 2) */
  positions: Float32Array
  uvs: Float32Array
  /** 复用缓冲，长度 = 容量 * 4（RGBA，0..1） */
  colors: Float32Array
  /** 顶点来源：所属插槽下标（拾取与权重显示用） */
  sourceSlot: Int32Array
  /** 顶点来源：在该附件顶点数组中的下标 */
  sourceVertex: Int32Array
  vertexCount: number
  /** 按绘制顺序排列的分组，索引指向共享顶点缓冲 */
  groups: MeshGroup[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const LOCAL_M = new Float32Array(16)
const WORLD_M = new Float32Array(16)

/** 颜色量化到 8 位后打包成 32 位整数，用于判断是否与上一组同色 */
export function packColorKey(color: RGBA): number {
  const r = Math.round(Math.max(0, Math.min(1, color.r)) * 255)
  const g = Math.round(Math.max(0, Math.min(1, color.g)) * 255)
  const b = Math.round(Math.max(0, Math.min(1, color.b)) * 255)
  const a = Math.round(Math.max(0, Math.min(1, color.a)) * 255)
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
}

/**
 * 把 Skeleton 的可见附件合并为顶点缓冲，按 (图集页, blendMode, 颜色) 分组。
 *
 * 与参考库 `MeshBuilder.BuildBuffers` 一致：
 * - 蒙皮：vertex = Σ worldMatrices[bk] · (lxk, lyk) · wk
 * - FFD **先于**蒙皮叠加（!ffdInBoneSpace 时先经 bindpose 做方向变换，不含平移）
 * - 分组只与**紧邻的上一组**合并，保证画家算法顺序
 * - 顶点色 = 插槽色 × 附件色 × 整体染色
 * - Mesh 附件总会写出顶点，但没有 triangles 时不产生三角形（与参考库一致）
 * - 缓冲复用，稳态下每帧零分配
 */
export class MeshBuilder {
  readonly result: MeshBuildResult = {
    positions: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    sourceSlot: new Int32Array(0),
    sourceVertex: new Int32Array(0),
    vertexCount: 0,
    groups: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }

  /** 上一次构建是否包含加权（蒙皮）网格 */
  lastBuildHadWeightedMesh = false
  /** 整体染色（默认白 = 不变色） */
  tint: RGBA = { r: 1, g: 1, b: 1, a: 1 }

  private readonly asset: RuntimeAsset
  private maps: RuntimeMaps | null = null
  private skinName = ''
  /** [皮肤插槽下标][显示下标] → 图集页下标 */
  private attMaterial: number[][] = []
  private capacity = 0
  private vertexCount = 0
  private usedGroups = 0
  private readonly groupMaterial: number[] = []
  private readonly groupBlend: number[] = []
  private readonly groupColorKeys: number[] = []
  private readonly groupColors: RGBA[] = []
  private readonly groupIndices: Uint32Array[] = []
  private readonly groupIndexCount: number[] = []
  private minX = 0
  private minY = 0
  private maxX = 0
  private maxY = 0

  constructor(asset: RuntimeAsset, skinName = '') {
    this.asset = asset
    this.setSkin(skinName)
    this.grow(256)
  }

  /** 换肤并重建运行期映射（默认皮肤 + 指定皮肤叠加） */
  setSkin(skinName = ''): void {
    this.skinName = skinName
    this.maps = buildRuntimeMaps(this.asset, skinName)
    this.attMaterial = this.maps.skinArr.map((slot) =>
      slot.attachments.map((attachment) => this.materialIndex(attachment.textureName))
    )
  }

  get currentSkin(): string {
    return this.skinName
  }

  /** 供渲染层 / 拾取查询某插槽当前显示的附件（含 linkedmesh 合并结果） */
  attachmentAt(slotIndex: number, displayIndex: number): AttachmentData | null {
    const maps = this.maps
    if (!maps) return null
    if (slotIndex < 0 || slotIndex >= maps.skinOfSlot.length) return null
    const k = maps.skinOfSlot[slotIndex]
    if (k < 0) return null
    const attachments = maps.skinArr[k].attachments
    if (displayIndex < 0 || displayIndex >= attachments.length) return null
    const override = maps.resolved[slotIndex]
    if (override && override[displayIndex]) return override[displayIndex]
    return attachments[displayIndex]
  }

  /** 附件名 → 显示下标（当前合并皮肤） */
  attachmentIndexOf(slotIndex: number, name: string): number {
    const maps = this.maps
    if (!maps) return -1
    const map = maps.slotAttIndex[slotIndex]
    if (!map) return -1
    const found = map.get(name)
    return found === undefined ? -1 : found
  }

  build(skeleton: Skeleton): MeshBuildResult {
    const maps = this.maps
    if (!maps) return this.finish()

    this.vertexCount = 0
    this.usedGroups = 0
    this.lastBuildHadWeightedMesh = false
    this.minX = Number.POSITIVE_INFINITY
    this.minY = Number.POSITIVE_INFINITY
    this.maxX = Number.NEGATIVE_INFINITY
    this.maxY = Number.NEGATIVE_INFINITY

    const slots = this.asset.slots
    const order = skeleton.drawOrder
    for (let oi = 0; oi < order.length; oi++) {
      const si = order[oi]
      if (si < 0 || si >= slots.length) continue
      if (!skeleton.slotVisible[si]) continue
      const k = maps.skinOfSlot[si]
      if (k < 0) continue
      const attachments = maps.skinArr[k].attachments
      if (attachments.length === 0) continue
      const di = skeleton.slotDisplayIndex[si]
      if (di < 0 || di >= attachments.length) continue

      let attachment = attachments[di]
      const override = maps.resolved[si]
      if (override && override[di]) attachment = override[di] as AttachmentData

      const slotColor = skeleton.slotColors[si]
      const attColor = attachment.color
      const color: RGBA = {
        r: slotColor.r * attColor.r * this.tint.r,
        g: slotColor.g * attColor.g * this.tint.g,
        b: slotColor.b * attColor.b * this.tint.b,
        a: slotColor.a * attColor.a * this.tint.a
      }

      const materialIndex = this.attMaterial[k]?.[di] ?? this.materialIndex(attachment.textureName)
      const group = this.groupFor(materialIndex, slots[si].blendMode, color)

      if (attachment.type === AttachmentType.Mesh && attachment.vertices.length > 0) {
        const count = Math.floor(attachment.vertices.length / 2)
        this.ensure(count)
        const base = this.vertexCount
        this.emitMesh(skeleton, si, attachment, color)
        for (const index of attachment.triangles) this.pushIndex(group, base + index)
      } else if (attachment.type === AttachmentType.Region || attachment.type === AttachmentType.Mesh) {
        this.ensure(4)
        const base = this.vertexCount
        this.emitRegion(skeleton, si, attachment, color)
        this.pushIndex(group, base)
        this.pushIndex(group, base + 1)
        this.pushIndex(group, base + 2)
        this.pushIndex(group, base)
        this.pushIndex(group, base + 2)
        this.pushIndex(group, base + 3)
      }
    }

    return this.finish()
  }

  private finish(): MeshBuildResult {
    const result = this.result
    result.vertexCount = this.vertexCount
    result.groups.length = this.usedGroups
    for (let i = 0; i < this.usedGroups; i++) {
      result.groups[i] = {
        materialIndex: this.groupMaterial[i],
        blendMode: this.groupBlend[i],
        color: this.groupColors[i],
        indices: this.groupIndices[i],
        indexCount: this.groupIndexCount[i]
      }
    }
    const empty = this.vertexCount === 0
    result.bounds.minX = empty ? 0 : this.minX
    result.bounds.minY = empty ? 0 : this.minY
    result.bounds.maxX = empty ? 0 : this.maxX
    result.bounds.maxY = empty ? 0 : this.maxY
    return result
  }

  // ---------------- 缓冲管理 ----------------

  private materialIndex(textureName: string): number {
    if (!textureName) return 0
    const index = this.asset.textureNames.indexOf(textureName)
    return index < 0 ? 0 : index
  }

  private grow(capacity: number): void {
    if (capacity <= this.capacity) return
    const positions = new Float32Array(capacity * 2)
    const uvs = new Float32Array(capacity * 2)
    const colors = new Float32Array(capacity * 4)
    const sourceSlot = new Int32Array(capacity)
    const sourceVertex = new Int32Array(capacity)
    positions.set(this.result.positions.subarray(0, this.vertexCount * 2))
    uvs.set(this.result.uvs.subarray(0, this.vertexCount * 2))
    colors.set(this.result.colors.subarray(0, this.vertexCount * 4))
    sourceSlot.set(this.result.sourceSlot.subarray(0, this.vertexCount))
    sourceVertex.set(this.result.sourceVertex.subarray(0, this.vertexCount))
    this.result.positions = positions
    this.result.uvs = uvs
    this.result.colors = colors
    this.result.sourceSlot = sourceSlot
    this.result.sourceVertex = sourceVertex
    this.capacity = capacity
  }

  private ensure(extra: number): void {
    const need = this.vertexCount + extra
    if (need <= this.capacity) return
    let next = this.capacity > 0 ? this.capacity : 256
    while (next < need) next *= 2
    this.grow(next)
  }

  private trackBounds(x: number, y: number): void {
    if (x < this.minX) this.minX = x
    if (x > this.maxX) this.maxX = x
    if (y < this.minY) this.minY = y
    if (y > this.maxY) this.maxY = y
  }

  /**
   * 取（或新建）分组，只与**紧邻的上一组**合并。
   * (图集页, blendMode, 颜色) 任一不同就开新组：保证画家算法顺序，同时让每组有唯一 tint。
   */
  private groupFor(materialIndex: number, blendMode: number, color: RGBA): number {
    const colorKey = packColorKey(color)
    const last = this.usedGroups - 1
    if (
      last >= 0 &&
      this.groupMaterial[last] === materialIndex &&
      this.groupBlend[last] === blendMode &&
      this.groupColorKeys[last] === colorKey
    ) {
      return last
    }

    if (this.usedGroups < this.groupIndices.length) {
      this.groupMaterial[this.usedGroups] = materialIndex
      this.groupBlend[this.usedGroups] = blendMode
      this.groupColorKeys[this.usedGroups] = colorKey
      this.groupColors[this.usedGroups] = color
      this.groupIndexCount[this.usedGroups] = 0
    } else {
      this.groupMaterial.push(materialIndex)
      this.groupBlend.push(blendMode)
      this.groupColorKeys.push(colorKey)
      this.groupColors.push(color)
      this.groupIndices.push(new Uint32Array(96))
      this.groupIndexCount.push(0)
    }
    return this.usedGroups++
  }

  private pushIndex(group: number, index: number): void {
    let buffer = this.groupIndices[group]
    const count = this.groupIndexCount[group]
    if (count >= buffer.length) {
      const grown = new Uint32Array(buffer.length * 2)
      grown.set(buffer)
      this.groupIndices[group] = grown
      buffer = grown
    }
    buffer[count] = index
    this.groupIndexCount[group] = count + 1
  }

  private writeVertex(
    x: number,
    y: number,
    u: number,
    v: number,
    color: RGBA,
    slotIndex: number,
    sourceVertex: number
  ): void {
    const i = this.vertexCount++
    const positions = this.result.positions
    const uvs = this.result.uvs
    const colors = this.result.colors
    this.result.sourceSlot[i] = slotIndex
    this.result.sourceVertex[i] = sourceVertex
    positions[i * 2] = x
    positions[i * 2 + 1] = y
    uvs[i * 2] = u
    // 数据约定 v=0 是图像**底部**（左下原点，与 Spine / DragonBones 导入一致），
    // 而 Pixi 纹理上传不翻转（v=0 是图像顶部），采样前翻回来
    uvs[i * 2 + 1] = 1 - v
    colors[i * 4] = color.r
    colors[i * 4 + 1] = color.g
    colors[i * 4 + 2] = color.b
    colors[i * 4 + 3] = color.a
    this.trackBounds(x, y)
  }

  // ---------------- 顶点产出 ----------------

  /** 附件局部矩阵 × 骨骼世界矩阵 */
  private attachmentWorld(skeleton: Skeleton, slotIndex: number, attachment: AttachmentData): Float32Array {
    trsInto(
      LOCAL_M,
      attachment.position.x,
      attachment.position.y,
      attachment.rotation,
      attachment.scale.x,
      attachment.scale.y
    )
    const boneIndex = this.asset.slots[slotIndex].boneIndex
    if (boneIndex < 0) {
      WORLD_M.set(LOCAL_M)
      return WORLD_M
    }
    mulInto(WORLD_M, skeleton.world.subarray(boneIndex * 16, boneIndex * 16 + 16), LOCAL_M)
    return WORLD_M
  }

  private emitRegion(
    skeleton: Skeleton,
    slotIndex: number,
    attachment: AttachmentData,
    color: RGBA
  ): void {
    const m = this.attachmentWorld(skeleton, slotIndex, attachment)
    const m0 = m[0]
    const m1 = m[1]
    const m4 = m[4]
    const m5 = m[5]
    const m12 = m[12]
    const m13 = m[13]
    const hw = attachment.size.x * 0.5
    const hh = attachment.size.y * 0.5
    const uvs = attachment.uvs

    for (let i = 0; i < 4; i++) {
      const sx = i === 1 || i === 2 ? hw : -hw
      const sy = i >= 2 ? hh : -hh
      const u = uvs.length > i * 2 ? uvs[i * 2] : 0
      const v = uvs.length > i * 2 + 1 ? uvs[i * 2 + 1] : 0
      this.writeVertex(m0 * sx + m4 * sy + m12, m1 * sx + m5 * sy + m13, u, v, color, slotIndex, i)
    }
  }

  private emitMesh(
    skeleton: Skeleton,
    slotIndex: number,
    attachment: AttachmentData,
    color: RGBA
  ): void {
    const vertices = attachment.vertices
    const count = Math.floor(vertices.length / 2)
    const uvs = attachment.uvs
    const weights = attachment.weights
    const weighted = weights.length === count && count > 0
    if (weighted) this.lastBuildHadWeightedMesh = true

    const bindposes = this.asset.bindposes
    const hasBind = bindposes.length > 0
    const deform = skeleton.deformOffsets[slotIndex]
    const deformBase = skeleton.deformOffsetBase[slotIndex]
    const rigid = weighted ? null : this.attachmentWorld(skeleton, slotIndex, attachment)

    for (let i = 0; i < count; i++) {
      const vx = vertices[i * 2]
      const vy = vertices[i * 2 + 1]

      let ffdX = 0
      let ffdY = 0
      if (deform && deformBase >= 0) {
        const li = i - deformBase
        const idx = li * 2
        if (li >= 0 && idx + 1 < deform.length) {
          ffdX = deform[idx]
          ffdY = deform[idx + 1]
        }
      }

      let x: number
      let y: number
      if (weighted) {
        const w = weights[i]
        ACC_X = 0
        ACC_Y = 0
        accumulateWeighted(skeleton, bindposes, hasBind, attachment.ffdInBoneSpace, ffdX, ffdY, w.w0, w.b0, w.lx0, w.ly0)
        accumulateWeighted(skeleton, bindposes, hasBind, attachment.ffdInBoneSpace, ffdX, ffdY, w.w1, w.b1, w.lx1, w.ly1)
        accumulateWeighted(skeleton, bindposes, hasBind, attachment.ffdInBoneSpace, ffdX, ffdY, w.w2, w.b2, w.lx2, w.ly2)
        accumulateWeighted(skeleton, bindposes, hasBind, attachment.ffdInBoneSpace, ffdX, ffdY, w.w3, w.b3, w.lx3, w.ly3)
        x = ACC_X
        y = ACC_Y
      } else if (rigid) {
        const px = vx + ffdX
        const py = vy + ffdY
        x = rigid[0] * px + rigid[4] * py + rigid[12]
        y = rigid[1] * px + rigid[5] * py + rigid[13]
      } else {
        x = vx + ffdX
        y = vy + ffdY
      }

      const u = uvs.length > i * 2 ? uvs[i * 2] : 0
      const v = uvs.length > i * 2 + 1 ? uvs[i * 2 + 1] : 0
      this.writeVertex(x, y, u, v, color, slotIndex, i)
    }
  }
}

/** 累加缓冲（避免每顶点分配对象） */
let ACC_X = 0
let ACC_Y = 0

function accumulateWeighted(
  skeleton: Skeleton,
  bindposes: Float32Array,
  hasBind: boolean,
  ffdInBoneSpace: boolean,
  ffdX: number,
  ffdY: number,
  weight: number,
  bone: number,
  lx: number,
  ly: number
): void {
  if (weight === 0) return
  const max = skeleton.boneCount - 1
  const b = bone < 0 ? 0 : bone > max ? max : bone
  let localX = lx
  let localY = ly
  if (ffdX !== 0 || ffdY !== 0) {
    if (ffdInBoneSpace) {
      // 偏移已是骨内坐标，直接叠加（参考库在加权路径上会跳过这一支，编辑器补全）
      localX += ffdX
      localY += ffdY
    } else if (hasBind) {
      // 偏移在显示空间，需按该骨骼的 bindpose 做方向变换（不含平移）
      const o = b * 16
      localX += bindposes[o] * ffdX + bindposes[o + 4] * ffdY
      localY += bindposes[o + 1] * ffdX + bindposes[o + 5] * ffdY
    }
  }
  const o = b * 16
  const world = skeleton.world
  ACC_X += weight * (world[o] * localX + world[o + 4] * localY + world[o + 12])
  ACC_Y += weight * (world[o + 1] * localX + world[o + 5] * localY + world[o + 13])
}
