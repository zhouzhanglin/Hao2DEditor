import type { Vec2 } from '../math/matrix'
import { signedArea, triangulatePolygon } from './triangulate'

/**
 * 按图片像素自动生成网格（轮廓贴合）。
 *
 * 用途：把一张碎图转成网格附件时，只用**不透明像素的轮廓**做网格，
 * 透明区域不占三角形 —— 比规则栅格省一大截顶点，也让网格边界贴合图形本身。
 *
 * 流程：**按 uvRect 裁出本附件的像素** → 二值化（带降采样）→ 取面积最大的 4-连通区域
 *       （忽略碎块与内部孔洞）→ 收集边界边并连成闭合轮廓 → Douglas-Peucker 简化到目标顶点数
 *       → 耳切三角化（复用 triangulatePolygon）。
 *
 * 纯函数、不依赖 DOM：像素遮罩由调用方（渲染层）从图片解码结果里取 —— 注意它给的是
 * **整张图片**（图集页）的遮罩，本附件只占其中一块，所以第一步必须先裁剪（见 cropToUvRect）。
 */

/** 像素遮罩：行优先，`y = 0` 是图片**顶部**（与 canvas / ImageData 一致） */
export interface AlphaMask {
  width: number
  height: number
  /** 逐像素 alpha（0..255） */
  alpha: Uint8Array
}

/** region 在图片里的 UV 矩形（归一化 0..1，v 以图片底部为 0） */
export interface UvRect {
  u0: number
  v0: number
  u1: number
  v1: number
}

export interface AutoMeshParams {
  /** 附件的显示尺寸（世界单位），顶点坐标以附件中心为原点 */
  size: Vec2
  /** 原 region 在图集页里的 UV 矩形：新网格的 UV 会按比例映射进去 */
  uvRect: UvRect
  /** 细分数（取工具里的 gridDivisions）：决定采样精度与目标顶点数量级 */
  divisions: number
  /** 不透明阈值（0..255），默认 128 */
  threshold?: number
  /** 顶点数硬上限，默认 256 */
  maxVertices?: number
  /** 遮罩工作分辨率上限（最长边），默认 512：大图先降采样，网格不需要像素级精度 */
  maskLimit?: number
}

export interface AutoMeshResult {
  /** 轮廓顶点（附件显示空间：中心为原点，y 向上） */
  vertices: Vec2[]
  /** 归一化 UV（0..1，v 已翻转：0 = 图片底部），已映射进传入的 uvRect */
  uvs: number[]
  triangles: number[]
  /** 外轮廓顶点下标顺序（这里就是 0..n-1） */
  edges: number[]
  /** 外环顶点数（本算法无内点，等于 vertices.length） */
  hull: number
  /** 诊断信息 */
  mask: { width: number; height: number; coverage: number }
}

const DEFAULT_THRESHOLD = 128
const DEFAULT_MAX_VERTICES = 256
const DEFAULT_MASK_LIMIT = 512
/** 细分数 → 目标顶点数：线性映射，保证「顶点数量级」随参数单调变化 */
const VERTICES_PER_DIVISION = 6

/**
 * 从像素遮罩生成轮廓网格。图片完全没有不透明像素时返回 null（调用方给出提示）。
 */
export function buildAutoMesh(mask: AlphaMask, params: AutoMeshParams): AutoMeshResult | null {
  const threshold = params.threshold ?? DEFAULT_THRESHOLD
  const limit = Math.max(32, Math.round(params.maskLimit ?? DEFAULT_MASK_LIMIT))
  /*
   * 先裁到本附件的 UV 矩形 —— 遮罩是**整张图片/图集页**的，不裁会错两处：
   * ① 顶点按「整图占比」缩到一角（实测：只占页面 14% 的盾牌，网格只有应有尺寸的 13%）；
   * ② 「面积最大的连通块」可能选到页面上别的更大的部件，整块网格都跑偏。
   */
  const cropped = cropToUvRect(mask, params.uvRect)
  if (!cropped) return null
  const work = buildBinaryMask(cropped, threshold, limit)
  if (!work) return null

  const component = largestComponent(work)
  if (!component) return null

  const outline = traceOutline(component, work.width, work.height)
  if (outline.length < 3) return null

  // 细分数 → 目标顶点数（上限保护，避免超大图生成过多顶点）
  const divisions = Math.max(1, Math.min(64, Math.round(params.divisions)))
  const maxVertices = Math.max(4, Math.round(params.maxVertices ?? DEFAULT_MAX_VERTICES))
  const target = Math.max(4, Math.min(maxVertices, divisions * VERTICES_PER_DIVISION))
  const simplified = simplifyToTarget(outline, target)
  // 兜底：简化没达标（点数仍超上限）或退化时，用内容包围盒的四个角
  const contour =
    simplified.length >= 3 && simplified.length <= maxVertices ? simplified : boundsOf(outline)
  if (contour.length < 3) return null

  const triangles = triangulatePolygon(contour)
  if (triangles.length < 3) return null

  const vertices: Vec2[] = []
  const uvs: number[] = []
  const { size, uvRect } = params
  const spanU = uvRect.u1 - uvRect.u0
  const spanV = uvRect.v1 - uvRect.v0
  for (const point of contour) {
    // 格点坐标 [0..W]×[0..H] → **矩形内**归一化（x 向右、y 向下；遮罩已裁到 UV 矩形）
    const rx = point.x / work.width
    const ry = point.y / work.height
    // 显示空间：中心为原点、y 向上
    vertices.push({ x: (rx - 0.5) * size.x, y: (0.5 - ry) * size.y })
    // 附件 UV：矩形内归一化 → 图集页坐标（v 以图片底部为 0，与 alpha 的行方向相反）
    uvs.push(uvRect.u0 + rx * spanU, uvRect.v0 + (1 - ry) * spanV)
  }

  return {
    vertices,
    uvs,
    triangles,
    edges: contour.map((_, index) => index),
    hull: vertices.length,
    mask: {
      width: work.width,
      height: work.height,
      coverage: componentCoverage(component, work.width * work.height)
    }
  }
}

export interface BinaryMask {
  width: number
  height: number
  /** 1 = 不透明，0 = 透明；行优先，y = 0 在顶部 */
  data: Uint8Array
}

/**
 * 把**整张图片**的遮罩裁到本附件的 UV 矩形上（像素级，向外取整，越界夹回来）。
 *
 * 为什么必须裁：调用方给的是整张图集页的遮罩，而一个附件只占其中一小块 ——
 * - 顶点坐标若按整图归一化，生成出来的网格会按「占图比例」缩到一角
 *   （实测：只占页面 14% 的盾牌，网格只有应有尺寸的 13%，且整体偏移）；
 * - 「面积最大的连通块」也可能选到页面上别的更大的部件，网格彻底跑偏。
 *
 * 注意 v 与行方向相反：`v = 0` 在图片底部，而遮罩第 0 行是图片顶部，
 * 所以矩形上边对应 `1 - v1`、下边对应 `1 - v0`。
 */
export function cropToUvRect(mask: AlphaMask, rect: UvRect): AlphaMask | null {
  const width = Math.max(1, Math.floor(mask.width))
  const height = Math.max(1, Math.floor(mask.height))
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(rect.u0 * width)))
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(rect.u1 * width)))
  const y0 = Math.max(0, Math.min(height - 1, Math.floor((1 - rect.v1) * height)))
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((1 - rect.v0) * height)))
  const outWidth = x1 - x0
  const outHeight = y1 - y0
  if (outWidth < 1 || outHeight < 1) return null
  const alpha = new Uint8Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y++) {
    const from = (y0 + y) * width + x0
    alpha.set(mask.alpha.subarray(from, from + outWidth), y * outWidth)
  }
  return { width: outWidth, height: outHeight, alpha }
}

/**
 * 二值化 + 降采样：把长边压到 `limit` 以内。
 * 降采样时「块内只要有一个不透明像素就算不透明」（保守），保证细线不会被抹掉。
 * 全透明返回 null。
 */
export function buildBinaryMask(mask: AlphaMask, threshold = DEFAULT_THRESHOLD, limit = DEFAULT_MASK_LIMIT): BinaryMask | null {
  const sourceWidth = Math.max(1, Math.floor(mask.width))
  const sourceHeight = Math.max(1, Math.floor(mask.height))
  const scale = Math.max(1, Math.ceil(Math.max(sourceWidth, sourceHeight) / Math.max(1, limit)))
  const width = Math.ceil(sourceWidth / scale)
  const height = Math.ceil(sourceHeight / scale)
  const data = new Uint8Array(width * height)

  let any = false
  for (let y = 0; y < height; y++) {
    const y0 = y * scale
    const y1 = Math.min(sourceHeight, y0 + scale)
    for (let x = 0; x < width; x++) {
      const x0 = x * scale
      const x1 = Math.min(sourceWidth, x0 + scale)
      let opaque = 0
      for (let py = y0; py < y1 && !opaque; py++) {
        const row = py * sourceWidth
        for (let px = x0; px < x1; px++) {
          if (mask.alpha[row + px] >= threshold) {
            opaque = 1
            break
          }
        }
      }
      if (opaque) {
        data[y * width + x] = 1
        any = true
      }
    }
  }
  return any ? { width, height, data } : null
}

/**
 * 面积最大的 4-连通区域（忽略其余碎块与内部孔洞 —— 孔洞不是「连通区域的边缘」，
 * 本函数只返回主体本身，孔洞位置仍会被判为「不属于主体」，但后续轮廓跟踪只取外环）。
 */
export function largestComponent(mask: BinaryMask): Uint8Array | null {
  const { width, height, data } = mask
  const seen = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  let best: { size: number; cells: Int32Array } | null = null

  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || seen[start] === 1) continue
    let top = 0
    let count = 0
    stack[top++] = start
    seen[start] = 1
    const cells = new Int32Array(width * height)
    while (top > 0) {
      const index = stack[--top]
      cells[count++] = index
      const x = index % width
      const y = (index - x) / width
      // 4-连通：上下左右（不含对角，避免「只在角上相连」造成轮廓自交）
      if (x > 0 && data[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1
        stack[top++] = index - 1
      }
      if (x + 1 < width && data[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1
        stack[top++] = index + 1
      }
      if (y > 0 && data[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1
        stack[top++] = index - width
      }
      if (y + 1 < height && data[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1
        stack[top++] = index + width
      }
    }
    if (!best || count > best.size) best = { size: count, cells: cells.subarray(0, count) }
  }

  if (!best) return null
  const out = new Uint8Array(width * height)
  for (let i = 0; i < best.size; i++) out[best.cells[i]] = 1
  return out
}

/**
 * 提取连通区域的**外轮廓**（格点坐标，取值 0..width / 0..height）。
 *
 * 做法：对每个不透明格，把与「透明侧 / 图像外」相邻的那条边收进集合，
 * 再按「起点 → 终点」串成闭合环。4-连通保证每个格点恰好一进一出，
 * 因此得到的一条简单闭合折线（阶梯状，之后由简化算法抹平）。
 */
export function traceOutline(component: Uint8Array, width: number, height: number): Vec2[] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && component[y * width + x] === 1

  // 边表：起点 key（`x,y`）→ 终点
  const next = new Map<number, number>()
  const key = (x: number, y: number): number => y * (width + 2) + x
  const addEdge = (x0: number, y0: number, x1: number, y1: number): void => {
    const from = key(x0, y0)
    if (!next.has(from)) next.set(from, key(x1, y1))
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue
      // 屏幕坐标（y 向下）：上边向右、右边向下、下边向左、左边向上 —— 连成顺时针
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y)
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1)
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1)
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y)
    }
  }
  if (next.size === 0) return []

  // 从任一有出边的格点出发走一圈（可能有多段：取最长的那段）
  const decode = (value: number): Vec2 => ({ x: value % (width + 2), y: Math.floor(value / (width + 2)) })
  let bestLoop: Vec2[] = []
  const visited = new Set<number>()
  for (const start of next.keys()) {
    if (visited.has(start)) continue
    const loop: Vec2[] = []
    let cursor: number | undefined = start
    let guard = next.size + 4
    while (cursor !== undefined && guard-- > 0) {
      if (visited.has(cursor)) break
      visited.add(cursor)
      loop.push(decode(cursor))
      cursor = next.get(cursor)
      if (cursor === start) break
    }
    if (loop.length > bestLoop.length) bestLoop = loop
  }
  return bestLoop
}

/** 内容包围盒的四个角（兜底用） */
export function boundsOf(points: readonly Vec2[]): Vec2[] {
  if (points.length === 0) return []
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ]
}

/**
 * 把闭合多边形简化到不超过 `target` 个顶点：
 * 二分容差跑 Douglas-Peucker，取「点数在 [3, target] 内且容差最小」的那次结果 ——
 * 容差越小细节越多，所以要找的是**满足上限的最小容差**。
 *
 * 找不到可行解（形状本身就少于 3 点等）时返回原始点集，由调用方决定如何兜底。
 */
export function simplifyToTarget(points: readonly Vec2[], target: number): Vec2[] {
  if (points.length <= target) return [...points]
  let maxAbs = 1
  for (const point of points) maxAbs = Math.max(maxAbs, Math.abs(point.x), Math.abs(point.y))

  let low = 0
  let high = maxAbs * 2
  let best: Vec2[] | null = null
  for (let i = 0; i < 28; i++) {
    const mid = (low + high) / 2
    const candidate = simplifyClosed(points, mid)
    if (candidate.length > target) {
      // 还是太多：需要更大的容差
      low = mid
    } else if (candidate.length < 3) {
      // 简化过头（连三角形都不够）：容差收小
      high = mid
    } else {
      // 可行解：记下来，继续找更小的容差（保留更多细节）
      best = candidate
      high = mid
    }
    if (high - low < 1e-3) break
  }
  return best ?? [...points]
}

/**
 * Douglas-Peucker（闭合版）：先找出离起点最远的顶点，把环拆成两条开链分别简化。
 *
 * 容差过大时可能只剩 2 个点（甚至更少）—— 这里如实返回，
 * 由 `simplifyToTarget` 判断这个解是否可用。
 */
export function simplifyClosed(points: readonly Vec2[], tolerance: number): Vec2[] {
  const count = points.length
  if (count <= 4) return [...points]

  let farIndex = 0
  let farDistance = -1
  for (let i = 1; i < count; i++) {
    const dx = points[i].x - points[0].x
    const dy = points[i].y - points[0].y
    const distance = dx * dx + dy * dy
    if (distance > farDistance) {
      farDistance = distance
      farIndex = i
    }
  }

  const first: Vec2[] = []
  for (let i = 0; i <= farIndex; i++) first.push(points[i])
  const second: Vec2[] = []
  for (let i = farIndex; i < count; i++) second.push(points[i])
  second.push(points[0])

  const simplifiedFirst = douglasPeucker(first, tolerance)
  const simplifiedSecond = douglasPeucker(second, tolerance)
  // 两条链共享首尾两点，拼接时各去掉一个重复点
  return [...simplifiedFirst.slice(0, -1), ...simplifiedSecond.slice(0, -1)]
}

function douglasPeucker(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points]
  const toleranceSq = tolerance * tolerance
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number]
    let maxDistance = -1
    let index = -1
    for (let i = start + 1; i < end; i++) {
      const distance = pointSegmentDistanceSq(points[i], points[start], points[end])
      if (distance > maxDistance) {
        maxDistance = distance
        index = i
      }
    }
    if (index > 0 && maxDistance > toleranceSq) {
      keep[index] = 1
      stack.push([start, index], [index, end])
    }
  }

  const out: Vec2[] = []
  for (let i = 0; i < points.length; i++) if (keep[i] === 1) out.push(points[i])
  return out
}

function pointSegmentDistanceSq(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 1e-12) {
    const px = point.x - a.x
    const py = point.y - a.y
    return px * px + py * py
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  const px = point.x - cx
  const py = point.y - cy
  return px * px + py * py
}

function componentCoverage(component: Uint8Array, total: number): number {
  let count = 0
  for (let i = 0; i < component.length; i++) if (component[i] === 1) count++
  return total > 0 ? count / total : 0
}

/** 轮廓的绕向（诊断 / 测试用）：>0 为逆时针（数学坐标） */
export function contourArea(points: readonly Vec2[]): number {
  return signedArea(points)
}
