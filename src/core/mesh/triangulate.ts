import type { Vec2 } from '../math/matrix'

export interface MeshGeometry {
  /** 顶点（附件显示空间） */
  vertices: Vec2[]
  /** 归一化 UV（0..1，v 已翻转，与 Runtime 约定一致） */
  uvs: number[]
  triangles: number[]
  /** 外轮廓在 vertices 中的下标顺序（用于边界显示与后续编辑） */
  edges: number[]
}

/**
 * 栅格建网格：把 Region 矩形切成 divisions × divisions 个格子。
 * uv 的 v 轴翻转（Runtime / 参考库统一约定：uv 原点在图片左下角）。
 */
export function createGridMesh(size: Vec2, divisions: number): MeshGeometry {
  const div = Math.max(1, Math.min(64, Math.round(divisions)))
  const width = size.x
  const height = size.y
  const originX = -width * 0.5
  const originY = -height * 0.5

  const vertices: Vec2[] = []
  const uvs: number[] = []
  const triangles: number[] = []
  const edges: number[] = []

  // 行 0 在底部（y = -h/2），对应 uv v = 0（v 已翻转：0 = 图片底部，1 = 图片顶部）
  for (let row = 0; row <= div; row++) {
    const t = row / div
    for (let col = 0; col <= div; col++) {
      const s = col / div
      vertices.push({ x: originX + s * width, y: originY + t * height })
      uvs.push(s, t)
    }
  }

  const stride = div + 1
  for (let row = 0; row < div; row++) {
    for (let col = 0; col < div; col++) {
      const i0 = row * stride + col
      const i1 = i0 + 1
      const i2 = i0 + stride
      const i3 = i2 + 1
      triangles.push(i0, i1, i3, i0, i3, i2)
    }
  }

  // 外轮廓（顺时针一圈，仅用于边界显示）
  for (let col = 0; col <= div; col++) edges.push(col)
  for (let row = 1; row <= div; row++) edges.push(row * stride + div)
  for (let col = div - 1; col >= 0; col--) edges.push(div * stride + col)
  for (let row = div - 1; row >= 1; row--) edges.push(row * stride)

  return { vertices, uvs, triangles, edges }
}

/**
 * 耳切三角化：把一个简单多边形（按顺序给出，可凹）切成三角形。
 * 返回三角形顶点下标（针对传入数组的顺序；若输入是顺时针会内部规范化输出顺序）。
 */
export function triangulatePolygon(points: readonly Vec2[]): number[] {
  const count = points.length
  if (count < 3) return []

  const indices = points.map((_, i) => i)
  if (signedArea(points) < 0) indices.reverse()

  const triangles: number[] = []
  let guard = 0
  const maxGuard = count * count + 16

  while (indices.length > 3 && guard++ < maxGuard) {
    let clipped = false
    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i - 1 + indices.length) % indices.length]
      const current = indices[i]
      const next = indices[(i + 1) % indices.length]
      if (!isEar(points, indices, prev, current, next)) continue
      triangles.push(prev, current, next)
      indices.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }

  if (indices.length === 3) {
    triangles.push(indices[0], indices[1], indices[2])
  } else if (indices.length > 3) {
    // 退化输入（自交 / 共线）：退化为扇形，保证至少有可用三角形
    for (let i = 1; i + 1 < indices.length; i++) {
      triangles.push(indices[0], indices[i], indices[i + 1])
    }
  }

  return triangles
}

/**
 * 多边形顶点 → UV：按包围盒线性映射到 0..1（v 翻转）。
 * 适用于「自由建网格」时用户框出的任意多边形，取图集页上的对应区域。
 */
export function polygonUvs(points: readonly Vec2[], size: Vec2): number[] {
  const uvs: number[] = []
  const width = size.x === 0 ? 1 : size.x
  const height = size.y === 0 ? 1 : size.y
  for (const point of points) {
    // 与 Region 一致：y 向下为负，uv v 以底部为 0
    uvs.push(point.x / width + 0.5, point.y / height + 0.5)
  }
  return uvs
}

/** 逆时针为正的有向面积（用于判断绕向） */
export function signedArea(points: readonly Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum * 0.5
}

/** Andrew monotone chain 凸包，返回顶点下标（用于从散点生成 hull） */
export function convexHull(points: readonly Vec2[]): number[] {
  if (points.length < 3) return points.map((_, i) => i)
  const sorted = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y)

  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  const lower: typeof sorted = []
  for (const item of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2].point, lower[lower.length - 1].point, item.point) <= 0) {
      lower.pop()
    }
    lower.push(item)
  }
  const upper: typeof sorted = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const item = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2].point, upper[upper.length - 1].point, item.point) <= 0) {
      upper.pop()
    }
    upper.push(item)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper).map((item) => item.index)
}

function isEar(points: readonly Vec2[], indices: readonly number[], prev: number, current: number, next: number): boolean {
  const a = points[prev]
  const b = points[current]
  const c = points[next]
  // 凹顶点（叉积 <= 0）不能作为耳朵
  if (cross(a, b, c) <= 1e-12) return false
  for (const index of indices) {
    if (index === prev || index === current || index === next) continue
    if (pointInTriangle(points[index], a, b, c)) return false
  }
  return true
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}
