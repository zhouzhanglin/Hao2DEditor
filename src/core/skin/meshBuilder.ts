import { mulInto, trsInto } from '../math/matrix'
import type { Skeleton } from '../model/skeleton'
import { AttachmentType } from '../model/types'
import type { AttachmentData, RGBA } from '../model/types'
import type { RuntimeAsset, RuntimeMaps } from '../model/asset'
import { buildRuntimeMaps } from '../model/asset'
import { barycentric, buildClipPolygon, TriangleClipper } from './clipping'
import type { ClipPolygon } from './clipping'

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

/**
 * 嵌套骨架锚点：子骨架不产生顶点，只把「应插在第几层」告诉渲染层。
 *
 * `layer` = 在此之前的**分组数**：子视图要插在 `groups[layer]` 之前
 * （= 该插槽在绘制顺序里的位置）。为了让后续附件另起一组，
 * 命中锚点时会强制断开当前分组（见 `build`）。
 */
export interface NestAnchor {
  slotIndex: number
  attachmentName: string
  armatureName: string
  /** 组下标：子视图插在第几层（同层时按 `order` 排） */
  layer: number
  /**
   * 在绘制顺序里的序号（0 = 最先画）。
   *
   * 两个嵌套 display 中间没有几何时 `layer` 会相同：只按层排会退回「实例创建顺序」
   * （= 插槽下标顺序），drawOrder 动画交换它们时就会画反。用 order 兜底成绘制顺序。
   */
  order: number
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
  /** 本帧生效的嵌套骨架锚点（无嵌套时为空数组） */
  nestAnchors: NestAnchor[]
  /** 本帧激活过的遮罩（世界坐标），给视口叠加层 / 调试用 */
  clipPolygons: ClipPolygon[]
  /** 每个顶点属于哪个遮罩（-1 = 未被遮罩；裁剪产生的新顶点也是 -1） */
  vertexClip: Int32Array
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
    nestAnchors: [],
    clipPolygons: [],
    vertexClip: new Int32Array(0),
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }

  /** 上一次构建是否包含加权（蒙皮）网格 */
  lastBuildHadWeightedMesh = false
  /** 整体染色（默认白 = 不变色） */
  tint: RGBA = { r: 1, g: 1, b: 1, a: 1 }

  /**
   * 插槽隔离：>= 0 时**只渲染该插槽的附件**，其余一概跳过（-1 = 显示全部）。
   * 网格工具用它隔离当前编辑的网格 —— 复杂角色上十几层网格互相遮挡，
   * 顶点、线框和贴图叠成一片，看不清在编哪一个。
   */
  isolateSlot = -1

  /** 隔离插槽上要渲染的附件下标（-1 = 用当前显示项）。「选中某附件」不等于「它在显示」 */
  isolateDisplay = -1

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
  /** 插槽名 → 运行期下标（遮罩 endSlot 用名字存，查找不依赖每帧遍历） */
  private readonly slotIndexByName = new Map<string, number>()
  private readonly clipper = new TriangleClipper()
  /** 本帧激活的遮罩（世界坐标） */
  private clipPolygons: ClipPolygon[] = []
  /** 当前激活遮罩在 clipPolygons 里的下标；-1 = 无 */
  private activeClip = -1
  /** 本帧的嵌套骨架锚点（与 `result.nestAnchors` 共用同一个数组） */
  private nestAnchors: NestAnchor[] = []
  /**
   * 下一次 `groupFor` 必须开新组（嵌套骨架是一层「页」，
   * 它后面的附件不能并回它前面的分组，否则会被画到子骨架下面）
   */
  private breakGroup = false

  constructor(asset: RuntimeAsset, skinName = '') {
    this.asset = asset
    for (let i = 0; i < asset.slots.length; i++) this.slotIndexByName.set(asset.slots[i].name, i)
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
    this.clipPolygons = []
    this.activeClip = -1
    if (!maps) return this.finish()

    this.vertexCount = 0
    this.usedGroups = 0
    this.lastBuildHadWeightedMesh = false
    this.nestAnchors = []
    this.breakGroup = false

    const slots = this.asset.slots
    const order = skeleton.drawOrder
    /*
     * 网格隔离（网格工具只显示当前编辑的附件）时不做遮罩：隔离的目的就是看清整块网格，
     * 被裁掉一半反而没法编辑。isolateSlot >= 0 时所有 clipId 都是 -1。
     */
    const clippingEnabled = this.isolateSlot < 0
    for (let oi = 0; oi < order.length; oi++) {
      const si = order[oi]
      if (si < 0 || si >= slots.length) continue

      // 结束插槽判断必须在可见性之前：结束插槽即使被隐藏，也要结束当前裁剪
      if (clippingEnabled && this.activeClip >= 0) {
        const active = this.clipPolygons[this.activeClip]
        if (active.endSlotIndex === si) this.activeClip = -1
      }

      if (!skeleton.slotVisible[si]) continue
      // 插槽隔离：网格工具下只渲染当前编辑的那个网格，其余附件一概跳过
      if (this.isolateSlot >= 0 && si !== this.isolateSlot) continue
      const k = maps.skinOfSlot[si]
      if (k < 0) continue
      const attachments = maps.skinArr[k].attachments
      if (attachments.length === 0) continue
      const di =
        si === this.isolateSlot && this.isolateDisplay >= 0
          ? this.isolateDisplay
          : skeleton.slotDisplayIndex[si]
      if (di < 0 || di >= attachments.length) continue

      // linkedmesh 的合并结果优先（按显示下标取，与参考库一致）
      const attachment = maps.resolved[si]?.[di] ?? attachments[di]

      /*
       * 嵌套骨架：不产生任何几何，只登记一个「层锚点」并**强制断开当前分组**。
       *
       * 必须在 `groupFor` 之前分流：否则会先建出一个空分组，后续附件又并回它，
       * 子视图插进来时就会盖住本该在它下面的附件（画家算法被打乱）。
       */
      if (attachment.type === AttachmentType.Armature) {
        this.nestAnchors.push({
          slotIndex: si,
          attachmentName: attachment.name,
          armatureName: attachment.subArmature,
          layer: this.usedGroups,
          order: this.nestAnchors.length
        })
        this.breakGroup = true
        continue
      }

      // 遮罩附件自身不渲染，但它的控制点要进顶点缓冲：
      // 顶点工具（D）在 Animate 态靠这些点写 FFD 轨道，选择 / 叠加层也要能显示它们。
      if (attachment.type === AttachmentType.Clipping) {
        this.emitClipPoints(skeleton, si, attachment)
        if (clippingEnabled && this.activeClip < 0) {
          const clip = this.makeClipPolygon(skeleton, si, attachment)
          if (clip) {
            this.clipPolygons.push(clip)
            this.activeClip = this.clipPolygons.length - 1
          }
        }
        continue
      }

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
      const clipId = this.activeClip

      if (attachment.type === AttachmentType.Mesh && attachment.vertices.length > 0) {
        const count = Math.floor(attachment.vertices.length / 2)
        this.ensure(count)
        const base = this.vertexCount
        this.emitMesh(skeleton, si, attachment, color, clipId)
        for (const index of attachment.triangles) this.pushIndex(group, base + index)
      } else if (attachment.type === AttachmentType.Region || attachment.type === AttachmentType.Mesh) {
        this.ensure(4)
        const base = this.vertexCount
        this.emitRegion(skeleton, si, attachment, color, clipId)
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
    result.clipPolygons = this.clipPolygons
    result.nestAnchors = this.nestAnchors
    // 先裁三角形（会追加顶点 / 改写组索引），再固化顶点数与分组
    this.applyClipping()
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
    /*
     * 包围盒只统计**真正被索引引用（= 会画出来）**的顶点。
     *
     * 只按写入顺序统计是错的：遮罩裁剪时，原始三角形顶点仍留在顶点缓冲里当裁剪源，
     * 但它们不会被任何索引引用（`applyClipping` 只把裁剪后的三角形写进索引）。
     * 把这些「看不见的顶点」算进包围盒，取景就会按未裁剪的大范围去缩放 ——
     * 表现为角色比实际画面小一圈、缩放也涨不上去（spine 预览按裁剪后的几何取景，
     * 两边因此对不上）。遮罩控制点同理：它们也没有索引，自然被排除。
     */
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (let g = 0; g < this.usedGroups; g++) {
      const indices = this.groupIndices[g]
      const count = this.groupIndexCount[g]
      for (let i = 0; i < count; i++) {
        const v = indices[i]
        const x = result.positions[v * 2]
        const y = result.positions[v * 2 + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const empty = minX > maxX
    result.bounds.minX = empty ? 0 : minX
    result.bounds.minY = empty ? 0 : minY
    result.bounds.maxX = empty ? 0 : maxX
    result.bounds.maxY = empty ? 0 : maxY
    return result
  }

  // ---------------- 遮罩 ----------------

  /** 供叠加层 / 拾取使用：遮罩附件当前姿态下的世界顶点 */
  clippingWorldPoints(skeleton: Skeleton, slotIndex: number, attachment: AttachmentData): Float32Array | null {
    return this.clipWorldPoints(skeleton, slotIndex, attachment)
  }

  /**
   * 把遮罩控制点写进顶点缓冲（不产生三角形）。
   *
   * 这些点不是渲染几何，但 FFD 工具 / 顶点拾取 / 叠加层都从 `MeshBuildResult` 取顶点：
   * 写进去之后，Animate 态拖遮罩点就能直接复用现有的 deform 关键帧流程。
   * `sourceVertex` 存附件内的点下标，`vertexClip = -1`（不再参与裁剪后处理）。
   */
  private emitClipPoints(skeleton: Skeleton, slotIndex: number, attachment: AttachmentData): void {
    const count = Math.floor(attachment.vertices.length / 2)
    if (count < 3) return
    const points = this.clipWorldPoints(skeleton, slotIndex, attachment)
    if (!points) return
    this.ensure(count)
    const white: RGBA = { r: 1, g: 1, b: 1, a: 1 }
    for (let i = 0; i < count; i++) {
      // 遮罩只是编辑手柄：它没有索引、不会画出三角形，因此天然不参与包围盒（见 finish）
      this.writeVertex(points[i * 2], points[i * 2 + 1], 0, 0, white, slotIndex, i, -1)
    }
  }

  /** 把 Clipping 附件解析成世界坐标多边形；无效（少于 3 点 / 退化）返回 null */
  private makeClipPolygon(skeleton: Skeleton, slotIndex: number, attachment: AttachmentData): ClipPolygon | null {
    const points = this.clipWorldPoints(skeleton, slotIndex, attachment)
    if (!points) return null
    const endSlotIndex = attachment.clipEndSlot ? (this.slotIndexByName.get(attachment.clipEndSlot) ?? -1) : -1
    return buildClipPolygon(points, endSlotIndex, attachment.clipInverse, attachment.clipConvex)
  }

  /**
   * 遮罩多边形的世界顶点。
   *
   * 与 `emitMesh` 的顶点路径同构：加权用 bindpose 累加、刚体乘附件世界矩阵、
   * FFD 偏移在蒙皮之前叠加。遮罩不写 UV / 颜色，所以这里只算位置。
   */
  private clipWorldPoints(
    skeleton: Skeleton,
    slotIndex: number,
    attachment: AttachmentData
  ): Float32Array | null {
    const vertices = attachment.vertices
    const count = Math.floor(vertices.length / 2)
    if (count < 3) return null
    const weights = attachment.weights
    const weighted = weights.length === count && count > 0

    const bindposes = this.asset.bindposes
    const hasBind = bindposes.length > 0
    const deform = skeleton.deformOffsets[slotIndex]
    const deformBase = skeleton.deformOffsetBase[slotIndex]
    const rigid = this.attachmentWorld(skeleton, slotIndex, attachment)
    const out = new Float32Array(count * 2)

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
        const total = w.w0 + w.w1 + w.w2 + w.w3
        if (total <= 1e-6) {
          const px = vx + ffdX
          const py = vy + ffdY
          x = rigid[0] * px + rigid[4] * py + rigid[12]
          y = rigid[1] * px + rigid[5] * py + rigid[13]
        } else if (Math.abs(total - 1) > 1e-6) {
          x = ACC_X / total
          y = ACC_Y / total
        } else {
          x = ACC_X
          y = ACC_Y
        }
      } else {
        const px = vx + ffdX
        const py = vy + ffdY
        x = rigid[0] * px + rigid[4] * py + rigid[12]
        y = rigid[1] * px + rigid[5] * py + rigid[13]
      }
      out[i * 2] = x
      out[i * 2 + 1] = y
    }
    return out
  }

  /**
   * 对每个分组的三角形做一次裁剪后处理。
   *
   * 没有遮罩 / 没有顶点落在遮罩里时直接返回（保持原来的零开销路径）。
   * 被裁的三角形会追加新顶点（`sourceVertex = -1`，不参与顶点编辑），
   * 未与遮罩相交的三角形原样保留。
   */
  private applyClipping(): void {
    if (this.clipPolygons.length === 0 || this.vertexCount === 0) return
    const result = this.result
    let hasClipped = false
    for (let i = 0; i < this.vertexCount; i++) {
      if (result.vertexClip[i] >= 0) {
        hasClipped = true
        break
      }
    }
    if (!hasClipped) return

    const scratch: number[] = []
    for (let g = 0; g < this.usedGroups; g++) {
      const count = this.groupIndexCount[g]
      if (count < 3) continue
      const indices = this.groupIndices[g]
      scratch.length = 0
      for (let i = 0; i < count; i++) scratch.push(indices[i])
      this.groupIndexCount[g] = 0

      for (let i = 0; i + 2 < scratch.length; i += 3) {
        const ia = scratch[i]
        const ib = scratch[i + 1]
        const ic = scratch[i + 2]
        const clipId = result.vertexClip[ia]
        if (clipId < 0) {
          this.pushIndex(g, ia)
          this.pushIndex(g, ib)
          this.pushIndex(g, ic)
          continue
        }
        this.clipTriangle(g, ia, ib, ic, this.clipPolygons[clipId])
      }
    }
  }

  private clipTriangle(group: number, ia: number, ib: number, ic: number, clip: ClipPolygon): void {
    const result = this.result
    const positions = result.positions
    const uvs = result.uvs
    const colors = result.colors
    const ax = positions[ia * 2]
    const ay = positions[ia * 2 + 1]
    const bx = positions[ib * 2]
    const by = positions[ib * 2 + 1]
    const cx = positions[ic * 2]
    const cy = positions[ic * 2 + 1]
    const ua = uvs[ia * 2]
    const va = uvs[ia * 2 + 1]
    const ub = uvs[ib * 2]
    const vb = uvs[ib * 2 + 1]
    const uc = uvs[ic * 2]
    const vc = uvs[ic * 2 + 1]
    const ca = { r: colors[ia * 4], g: colors[ia * 4 + 1], b: colors[ia * 4 + 2], a: colors[ia * 4 + 3] }
    const cb = { r: colors[ib * 4], g: colors[ib * 4 + 1], b: colors[ib * 4 + 2], a: colors[ib * 4 + 3] }
    const cc = { r: colors[ic * 4], g: colors[ic * 4 + 1], b: colors[ic * 4 + 2], a: colors[ic * 4 + 3] }
    const slotIndex = result.sourceSlot[ia]
    const appended: number[] = []

    this.clipper.clipTriangle(ax, ay, bx, by, cx, cy, clip, (points, count) => {
      appended.length = 0
      for (let i = 0; i < count; i += 2) {
        const x = points[i]
        const y = points[i + 1]
        const [wa, wb, wc] = barycentric(x, y, ax, ay, bx, by, cx, cy)
        const u = ua * wa + ub * wb + uc * wc
        const v = va * wa + vb * wb + vc * wc
        const color: RGBA = {
          r: ca.r * wa + cb.r * wb + cc.r * wc,
          g: ca.g * wa + cb.g * wb + cc.g * wc,
          b: ca.b * wa + cb.b * wb + cc.b * wc,
          a: ca.a * wa + cb.a * wb + cc.a * wc
        }
        appended.push(this.appendVertex(x, y, u, v, color, slotIndex))
      }
      for (let i = 1; i + 1 < appended.length; i++) {
        this.pushIndex(group, appended[0])
        this.pushIndex(group, appended[i])
        this.pushIndex(group, appended[i + 1])
      }
    })
  }

  /** 追加一个裁剪产生的顶点（clipId = -1，sourceVertex = -1 表示不可编辑） */
  private appendVertex(x: number, y: number, u: number, v: number, color: RGBA, slotIndex: number): number {
    this.ensure(1)
    const i = this.vertexCount++
    const result = this.result
    result.positions[i * 2] = x
    result.positions[i * 2 + 1] = y
    result.uvs[i * 2] = u
    result.uvs[i * 2 + 1] = v
    result.colors[i * 4] = color.r
    result.colors[i * 4 + 1] = color.g
    result.colors[i * 4 + 2] = color.b
    result.colors[i * 4 + 3] = color.a
    result.sourceSlot[i] = slotIndex
    result.sourceVertex[i] = -1
    result.vertexClip[i] = -1
    return i
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
    // 新容量默认 -1（未遮罩）；0 会被误当成「第 0 个遮罩」
    const vertexClip = new Int32Array(capacity).fill(-1)
    positions.set(this.result.positions.subarray(0, this.vertexCount * 2))
    uvs.set(this.result.uvs.subarray(0, this.vertexCount * 2))
    colors.set(this.result.colors.subarray(0, this.vertexCount * 4))
    sourceSlot.set(this.result.sourceSlot.subarray(0, this.vertexCount))
    sourceVertex.set(this.result.sourceVertex.subarray(0, this.vertexCount))
    vertexClip.set(this.result.vertexClip.subarray(0, this.vertexCount))
    this.result.positions = positions
    this.result.uvs = uvs
    this.result.colors = colors
    this.result.sourceSlot = sourceSlot
    this.result.sourceVertex = sourceVertex
    this.result.vertexClip = vertexClip
    this.capacity = capacity
  }

  private ensure(extra: number): void {
    const need = this.vertexCount + extra
    if (need <= this.capacity) return
    let next = this.capacity > 0 ? this.capacity : 256
    while (next < need) next *= 2
    this.grow(next)
  }

  /**
   * 取（或新建）分组，只与**紧邻的上一组**合并。
   * (图集页, blendMode, 颜色) 任一不同就开新组：保证画家算法顺序，同时让每组有唯一 tint。
   */
  private groupFor(materialIndex: number, blendMode: number, color: RGBA): number {
    const colorKey = packColorKey(color)
    const last = this.usedGroups - 1
    // 嵌套骨架把绘制切成两段：禁用与上一组的合并，保证它后面的附件排到子骨架之后
    const allowMerge = !this.breakGroup
    this.breakGroup = false
    if (
      allowMerge &&
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
    sourceVertex: number,
    clipId: number
  ): void {
    const i = this.vertexCount++
    const positions = this.result.positions
    const uvs = this.result.uvs
    const colors = this.result.colors
    this.result.sourceSlot[i] = slotIndex
    this.result.sourceVertex[i] = sourceVertex
    this.result.vertexClip[i] = clipId
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
    color: RGBA,
    clipId: number
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
    /*
     * 裁剪偏移在**附件自身坐标轴**里叠加：内容中心相对原图中心（= 附件原点）的位移。
     * 放在这里而不是加进 `position`，是因为 position 会被骨骼的旋转带着转 ——
     * 那个位移是图片坐标轴里的量，只能随附件的旋转走（Rooster 的下嘴就栽在这上面）。
     */
    const ox = attachment.contentOffset.x
    const oy = attachment.contentOffset.y

    for (let i = 0; i < 4; i++) {
      const sx = (i === 1 || i === 2 ? hw : -hw) + ox
      const sy = (i >= 2 ? hh : -hh) + oy
      const u = uvs.length > i * 2 ? uvs[i * 2] : 0
      const v = uvs.length > i * 2 + 1 ? uvs[i * 2 + 1] : 0
      this.writeVertex(m0 * sx + m4 * sy + m12, m1 * sx + m5 * sy + m13, u, v, color, slotIndex, i, clipId)
    }
  }

  private emitMesh(
    skeleton: Skeleton,
    slotIndex: number,
    attachment: AttachmentData,
    color: RGBA,
    clipId: number
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
    /*
     * 刚性变换：**未加权网格**整块用它；加权网格里「四根骨骼权重全为 0」的个别顶点也要用它
     * —— 那是把影响的骨骼都刷到 0 之后的合法状态（见 applyVertexWeight），
     * 该顶点不受任何骨骼影响，应当留在原地而不是塌到附件原点。
     */
    const rigid = this.attachmentWorld(skeleton, slotIndex, attachment)

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
        const total = w.w0 + w.w1 + w.w2 + w.w3
        if (total <= 1e-6) {
          // 零权重顶点：不受任何骨骼影响 → 留在绑定位置（不能塌到原点）
          const px = vx + ffdX
          const py = vy + ffdY
          x = rigid ? rigid[0] * px + rigid[4] * py + rigid[12] : px
          y = rigid ? rigid[1] * px + rigid[5] * py + rigid[13] : py
        } else if (Math.abs(total - 1) > 1e-6) {
          /*
           * 权重和不是 1（编辑期的中间状态，例如某根骨骼被刷到 0.4 而其它骨骼全是 0）：
           * 按**相对比例**归一化，而不是原样累加 —— 原样累加会把顶点朝原点拽过去
           *（权重和 0.4 时只剩四成距离），看起来就像"网格被吸进去了"。
           */
          x = ACC_X / total
          y = ACC_Y / total
        } else {
          x = ACC_X
          y = ACC_Y
        }
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
      this.writeVertex(x, y, u, v, color, slotIndex, i, clipId)
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
