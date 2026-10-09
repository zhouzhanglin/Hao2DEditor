import { Graphics } from 'pixi.js'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { AttachmentData } from '@core/model/types'
import type { Skeleton } from '@core/model/skeleton'
import { DOT_SEGMENTS, circlePolygon, piePolygon } from './shapes'

export interface MeshOverlayOptions {
  unitsPerPixel: number
  showWireframe: boolean
  showVertices: boolean
  /**
   * 只画这个插槽的线框与顶点（-1 = 全部）。
   *
   * 「选择 / Pose 工具里只显示选中的那一个网格」靠它：所有 displayObject 都铺线框没法看，
   * 但也**不能**用网格隔离（隔离会把角色其余部分一起藏掉，而这里其余部分照常显示）。
   */
  onlySlot: number
  /**
   * 普通顶点圆点的半径，**世界单位**（不是屏幕像素）。
   *
   * 由场景按工具决定：
   * - 顶点工具（隔离中）：固定 5 屏幕像素对应的世界长度 —— 那是可拖的手柄，缩多远都要好抓；
   * - 选择 / Pose 工具：按网格自身尺寸取固定值，**不为视口缩放做补偿** —— 放大时点跟着
   *   网格一起变大，缩小时一起变小（这两类工具下顶点只是"标出位置"）。
   */
  vertexRadius: number
  /**
   * 权重着色模式：每个顶点画成饼图（见 drawWeightPies）。
   * 关掉时顶点是统一的灰点。
   */
  showWeights: boolean
  /**
   * 绑定骨骼的显示色：骨骼索引 → 颜色。由场景按骨骼在「权重骨骼列表」里的**位置**
   * 从 weightPalette 取，与检查器里的色块同源。不在映射里的骨骼（老工程 / 手动刷过权重）
   * 用兜底灰，避免那片顶点凭空消失。
   */
  weightBoneColors: ReadonlyMap<number, number>
  /** 选中的顶点下标集合（全局顶点缓冲下标） */
  selectedVertices: ReadonlySet<number>
  hoveredVertex: number
}

/**
 * 网格线框与普通顶点：**青色**（`#00FFFF`，见下面的取值说明）。
 *
 * 取值是照着参考实现的网格视图截屏**采样**出来的 —— 画面里出现最多的那一档正是纯青
 * （其余都是它的抗锯齿过渡色）。线框与顶点共用同一个色，两者才像"同一张网"。
 */
const COLOR_WIRE = 0x00ffff
const COLOR_VERTEX = 0x00ffff
const COLOR_VERTEX_SELECTED = 0x0a84ff
const COLOR_VERTEX_HOVERED = 0xffd60a
const COLOR_FFD = 0xbf5af2
const COLOR_FFD_BASE = 0x8e8e93

/**
 * 网格线框 + 顶点手柄 + 权重热力图 + FFD 偏移可视化。
 * 同样把描边与填充拆到两个 Graphics（见 boneOverlay 的说明）。
 */
export function drawMeshOverlay(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  result: MeshBuildResult | null,
  attachmentOf: (slotIndex: number, displayIndex: number) => AttachmentData | null,
  options: MeshOverlayOptions
): void {
  strokes.clear()
  fills.clear()
  if (!result || result.vertexCount === 0) return
  const g = strokes
  const w = options.unitsPerPixel

  if (options.showWireframe) {
    for (const group of result.groups) {
      const indices = group.indices
      const count = group.indexCount
      for (let i = 0; i + 2 < count; i += 3) {
        // 一个三角面的三个顶点同属一个插槽（见 meshBuilder 的分组建法），按首顶点判定即可
        if (options.onlySlot >= 0 && result.sourceSlot[indices[i]] !== options.onlySlot) continue
        const a = indices[i] * 2
        const b = indices[i + 1] * 2
        const c = indices[i + 2] * 2
        g.moveTo(result.positions[a], result.positions[a + 1]).lineTo(result.positions[b], result.positions[b + 1])
        g.moveTo(result.positions[b], result.positions[b + 1]).lineTo(result.positions[c], result.positions[c + 1])
        g.moveTo(result.positions[c], result.positions[c + 1]).lineTo(result.positions[a], result.positions[a + 1])
      }
    }
    /*
     * 线条与顶点共用同一股青色（参考实现里就是一个色，同一张网）。
     * 透明度按需要调：太低会显得比顶点"淡一层"，两者就不像同一张网了。
     */
    g.stroke({ width: w, color: COLOR_WIRE, alpha: 0.2 })
  }

  if (options.showVertices) {
    if (options.showWeights) {
      // 权重着色：每个顶点画成饼图，一瓣一根骨骼（角宽 = 权重）
      drawWeightPies(fills, result, skeleton, attachmentOf, options.weightBoneColors, options.onlySlot, w)
      // 说明：配色由场景按「权重骨骼列表」的位置统一给出，与骨骼覆盖层同源
      // 选中 / 悬停改画圆环：实心大点会把饼整个盖住，权重分配就看不见了
      drawVertexRings(strokes, result, options.selectedVertices, options.hoveredVertex, options.onlySlot, w)
    } else {
      const normal: number[] = []
      for (let i = 0; i < result.vertexCount; i++) {
        if (options.onlySlot >= 0 && result.sourceSlot[i] !== options.onlySlot) continue
        normal.push(result.positions[i * 2], result.positions[i * 2 + 1])
      }
      // 半径由场景给（**世界单位**）：顶点工具是固定屏幕尺寸的手柄，选择 / Pose 则跟着网格走
      const radius = options.vertexRadius
      fillPoints(fills, normal, radius, COLOR_VERTEX, 0.9)

      // 选中 / 悬停再大一半，一眼能从满屏点里挑出来
      const selected: number[] = []
      const hovered: number[] = []
      for (let i = 0; i < result.vertexCount; i++) {
        if (options.onlySlot >= 0 && result.sourceSlot[i] !== options.onlySlot) continue
        if (i === options.hoveredVertex) hovered.push(result.positions[i * 2], result.positions[i * 2 + 1])
        else if (options.selectedVertices.has(i)) selected.push(result.positions[i * 2], result.positions[i * 2 + 1])
      }
      fillPoints(fills, selected, radius * 1.5, COLOR_VERTEX_SELECTED, 1)
      fillPoints(fills, hovered, radius * 1.5, COLOR_VERTEX_HOVERED, 1)
    }
  }

  drawFfdOffsets(strokes, fills, skeleton, result, w)
}

/** 一组权重（最多 4 根骨骼）的取值形状 —— 运行期附件的 weights 就是它 */
interface WeightEntry {
  b0: number
  b1: number
  b2: number
  b3: number
  w0: number
  w1: number
  w2: number
  w3: number
}

/** 权重色点半径（屏幕像素）：比普通顶点大一圈，它是这个模式下唯一的信息载体 */
const WEIGHT_DOT_RADIUS = 5.5

/**
 * 权重着色：每个顶点画成**饼图** —— 每一瓣的角宽 = 那根骨骼的权重，颜色取自调色板。
 *
 * 与"混合成单色"的区别：混合色只能告诉你"这块顶点整体偏哪根骨骼"，而饼图能直读出
 * 「51% 这根 + 48% 那根」这种分配（Spine 的权重视图就是饼图）。调色板与检查器色块同源。
 */
function drawWeightPies(
  g: Graphics,
  result: MeshBuildResult,
  skeleton: Skeleton,
  attachmentOf: (slotIndex: number, displayIndex: number) => AttachmentData | null,
  boneColors: ReadonlyMap<number, number>,
  onlySlot: number,
  w: number
): void {
  const radius = WEIGHT_DOT_RADIUS * w
  for (let i = 0; i < result.vertexCount; i++) {
    if (onlySlot >= 0 && result.sourceSlot[i] !== onlySlot) continue
    const slotIndex = result.sourceSlot[i]
    const attachment = attachmentOf(slotIndex, skeleton.slotDisplayIndex[slotIndex])
    if (!attachment) continue
    const vertexIndex = result.sourceVertex[i]
    if (attachment.weights.length <= vertexIndex) continue
    const slices = weightSlices(attachment.weights[vertexIndex], boneColors)
    if (slices.length === 0) continue
    const x = result.positions[i * 2]
    const y = result.positions[i * 2 + 1]
    // 绝大多数顶点是「单骨骼 100%」：直接画整圆，省掉一整圈扇形顶点
    if (slices.length === 1) {
      g.poly(circlePolygon(x, y, radius, DOT_SEGMENTS))
      g.fill({ color: slices[0].color, alpha: 0.95 })
      continue
    }
    /*
     * 从正上方顺时针分瓣，顺序 = 骨骼在权重列表里的顺序：起点与顺序都固定，
     * 同一顶点每帧画出来一模一样 —— 缩放平移时饼不会"转圈"。
     */
    let angle = -Math.PI / 2
    for (const slice of slices) {
      const sweep = slice.weight * Math.PI * 2
      const polygon = piePolygon(x, y, radius, angle, angle + sweep, DOT_SEGMENTS)
      if (polygon.length > 0) {
        g.poly(polygon)
        g.fill({ color: slice.color, alpha: 0.95 })
      }
      angle += sweep
    }
  }
}

/**
 * 一组权重 → 饼图各瓣（权重归一化，和恒为 1）；没有任何有效权重时返回空数组（不画这个点）。
 *
 * 未列在权重骨骼列表里的骨骼（老工程 / 手动刷过权重）用兜底灰，避免那片顶点凭空消失。
 */
function weightSlices(entry: WeightEntry, boneColors: ReadonlyMap<number, number>): Array<{ color: number; weight: number }> {
  const raw: Array<{ color: number; weight: number }> = []
  const add = (bone: number, weight: number): void => {
    if (weight <= 0.0001) return
    raw.push({ color: boneColors.get(bone) ?? 0x8e8e93, weight })
  }
  add(entry.b0, entry.w0)
  add(entry.b1, entry.w1)
  add(entry.b2, entry.w2)
  add(entry.b3, entry.w3)
  const total = raw.reduce((sum, slice) => sum + slice.weight, 0)
  if (total <= 0.0001) return []
  return raw.map((slice) => ({ color: slice.color, weight: slice.weight / total }))
}

/**
 * 饼图模式下的选中 / 悬停标记：画成**圆环**而不是实心点。
 *
 * 实心大点会把 11px 的饼整个盖住 —— 那样"选中了哪个顶点"和"它的权重怎么分"就对立了；
 * 圆环（半径比饼大 2px）两者兼顾。画在描边层，即使压在饼下面也不影响判读。
 */
function drawVertexRings(
  g: Graphics,
  result: MeshBuildResult,
  selectedVertices: ReadonlySet<number>,
  hoveredVertex: number,
  onlySlot: number,
  w: number
): void {
  const radius = (WEIGHT_DOT_RADIUS + 2) * w
  const ring = (hit: (index: number) => boolean, color: number): void => {
    let any = false
    for (let i = 0; i < result.vertexCount; i++) {
      if (onlySlot >= 0 && result.sourceSlot[i] !== onlySlot) continue
      if (!hit(i)) continue
      g.poly(circlePolygon(result.positions[i * 2], result.positions[i * 2 + 1], radius, DOT_SEGMENTS))
      any = true
    }
    if (any) g.stroke({ width: 2 * w, color, alpha: 1 })
  }
  ring((index) => selectedVertices.has(index), COLOR_VERTEX_SELECTED)
  ring((index) => index === hoveredVertex, COLOR_VERTEX_HOVERED)
}

/** FFD 偏移：从基准顶点画虚线到偏移后的位置，并画一个菱形手柄 */
function drawFfdOffsets(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  result: MeshBuildResult,
  w: number
): void {
  const handles: number[] = []
  for (let slotIndex = 0; slotIndex < skeleton.slotCount; slotIndex++) {
    const deform = skeleton.deformOffsets[slotIndex]
    const base = skeleton.deformOffsetBase[slotIndex]
    if (!deform || base < 0) continue

    for (let i = 0; i < result.vertexCount; i++) {
      if (result.sourceSlot[i] !== slotIndex) continue
      const vertexIndex = result.sourceVertex[i]
      const li = vertexIndex - base
      const idx = li * 2
      if (li < 0 || idx + 1 >= deform.length) continue
      const dx = deform[idx]
      const dy = deform[idx + 1]
      if (dx === 0 && dy === 0) continue
      const x = result.positions[i * 2]
      const y = result.positions[i * 2 + 1]
      strokes.moveTo(x - dx, y - dy).lineTo(x, y)
      handles.push(x, y)
    }
  }

  if (handles.length > 0) {
    strokes.stroke({ width: w, color: COLOR_FFD_BASE, alpha: 0.6 })
    const s = 4 * w
    for (let i = 0; i < handles.length; i += 2) {
      const x = handles[i]
      const y = handles[i + 1]
      fills.moveTo(x - s, y).lineTo(x, y + s).lineTo(x + s, y).lineTo(x, y - s).lineTo(x - s, y)
      fills.fill({ color: COLOR_FFD, alpha: 0.9 })
    }
  }
}

function fillPoints(
  g: Graphics,
  points: number[],
  radius: number,
  color: number,
  alpha: number
): void {
  if (points.length === 0) return
  for (let i = 0; i < points.length; i += 2) {
    // 自己画多边形：Pixi 的 circle 在缩放的容器里会变成明显的多边形
    g.poly(circlePolygon(points[i], points[i + 1], radius, DOT_SEGMENTS))
  }
  g.fill({ color, alpha })
}
