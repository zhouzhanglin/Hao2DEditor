import type { Vec2 } from '../math/matrix'
import { convexHull, signedArea, triangulatePolygon } from '../mesh/triangulate'

/**
 * 一个已解析到世界坐标的遮罩多边形。
 *
 * `pieces` 是**互不重叠的凸块**：凸遮罩就是它自己，凹遮罩由耳切拆开，
 * 反向遮罩用凸包（Spine 的 inverse 只支持凸形）。逐三角形裁剪时分别与
 * 每个凸块求交，再把结果扇形三角化。
 */
export interface ClipPolygon {
  /** 原始世界顶点（x,y 交替），给叠加层画轮廓用 */
  points: Float32Array
  /** 结束插槽下标；-1 = 裁到绘制顺序末尾 */
  endSlotIndex: number
  inverse: boolean
  convex: boolean
  /** 凸块（x,y 交替，逆时针） */
  pieces: Float32Array[]
}

const EPSILON = 1e-9

/**
 * 把遮罩顶点整理成可裁剪的 `ClipPolygon`。
 *
 * 返回 null 表示多边形退化（少于 3 点 / 面积近似 0 / 自交到无法三角化），
 * 调用方应当忽略这个遮罩而不是让整帧渲染失败。
 */
export function buildClipPolygon(
  points: Float32Array,
  endSlotIndex: number,
  inverse: boolean,
  convex: boolean
): ClipPolygon | null {
  const world = dedupe(points)
  if (world.length < 6) return null
  const source = toPoints(world)
  if (Math.abs(signedArea(source)) < EPSILON) return null

  let base = source
  if (inverse) {
    // 反向遮罩按 Spine 语义只支持凸形：先取凸包，保证“外部”是一个良定义的区域
    base = hull(source)
    if (base.length < 3) return null
  }

  const pieces: Float32Array[] = []
  if (inverse || convex) {
    pieces.push(toFloat32Array(ensureCcw(base)))
  } else {
    const triangles = triangulatePolygon(base)
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const triangle = [base[triangles[i]], base[triangles[i + 1]], base[triangles[i + 2]]]
      if (Math.abs(signedArea(triangle)) < EPSILON) continue
      pieces.push(toFloat32Array(ensureCcw(triangle)))
    }
  }
  if (pieces.length === 0) return null

  return {
    points: world,
    endSlotIndex,
    inverse,
    convex: inverse ? true : convex,
    pieces
  }
}

/** 三角形裁剪器：所有缓冲复用于一次 build，避免每帧为每个三角形分配数组 */
export class TriangleClipper {
  private readonly a: number[] = []
  private readonly b: number[] = []
  private readonly out: number[] = []

  /**
   * 把三角形 `(ax,ay)-(bx,by)-(cx,cy)` 与遮罩求交，结果通过 `emit` 逐块吐出。
   *
   * `emit(points, count)` 里的 `points` 是 x,y 交替的**世界坐标**，只在回调期间有效；
   * 调用方应当立刻写入自己的顶点缓冲。完全在遮罩外部时不会触发回调。
   */
  clipTriangle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    clip: ClipPolygon,
    emit: (points: readonly number[], count: number) => void
  ): void {
    if (clip.inverse) {
      this.clipOutside(ax, ay, bx, by, cx, cy, clip.pieces[0], emit)
      return
    }
    for (const piece of clip.pieces) {
      const count = this.clipConvex(ax, ay, bx, by, cx, cy, piece)
      if (count >= 6) emit(this.out, count)
    }
  }

  /** 三角形 ∩ 凸块（凸块必须逆时针） */
  private clipConvex(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    piece: Float32Array
  ): number {
    const input = this.a
    input.length = 0
    input.push(ax, ay, bx, by, cx, cy)

    let current = input
    let other = this.b
    let count = 6
    for (let i = 0; i < piece.length; i += 2) {
      const ex = piece[i]
      const ey = piece[i + 1]
      const nx = piece[(i + 2) % piece.length]
      const ny = piece[(i + 3) % piece.length]
      other.length = 0
      count = clipHalfPlane(current, count, ex, ey, nx, ny, true, other)
      if (count < 6) return 0
      const swap = current
      current = other
      other = swap
    }
    this.out.length = 0
    for (let i = 0; i < count; i++) this.out.push(current[i])
    return count
  }

  /**
   * 三角形在凸多边形外的部分。
   *
   * 对第 i 条边，取「在前 i 条边的内侧、且在第 i 条边外侧」的区域 ——
   * 这些区域互不重叠，合起来正好是多边形外部（不会重复绘制同一条边）。
   */
  private clipOutside(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    hull: Float32Array,
    emit: (points: readonly number[], count: number) => void
  ): void {
    const edges = hull.length / 2
    for (let i = 0; i < edges; i++) {
      const input = this.a
      input.length = 0
      input.push(ax, ay, bx, by, cx, cy)
      let current = input
      let other = this.b
      let count = 6
      let empty = false
      for (let j = 0; j < i; j++) {
        const ex = hull[j * 2]
        const ey = hull[j * 2 + 1]
        const nx = hull[((j + 1) % edges) * 2]
        const ny = hull[((j + 1) % edges) * 2 + 1]
        other.length = 0
        count = clipHalfPlane(current, count, ex, ey, nx, ny, true, other)
        if (count < 6) {
          empty = true
          break
        }
        const swap = current
        current = other
        other = swap
      }
      if (empty) continue

      const ex = hull[i * 2]
      const ey = hull[i * 2 + 1]
      const nx = hull[((i + 1) % edges) * 2]
      const ny = hull[((i + 1) % edges) * 2 + 1]
      other.length = 0
      count = clipHalfPlane(current, count, ex, ey, nx, ny, false, other)
      if (count < 6) continue
      emit(other, count)
    }
  }
}

/**
 * Sutherland–Hodgman 单边裁剪。
 *
 * `keepInside = true` 保留边 (ex,ey)→(nx,ny) 的左侧（逆时针多边形的内部）；
 * false 保留右侧（用于反向遮罩）。输出写到 `out`，返回 x,y 分量个数。
 */
function clipHalfPlane(
  input: readonly number[],
  count: number,
  ex: number,
  ey: number,
  nx: number,
  ny: number,
  keepInside: boolean,
  out: number[]
): number {
  const dx = nx - ex
  const dy = ny - ey
  let px = input[count - 2]
  let py = input[count - 1]
  let ps = side(ex, ey, dx, dy, px, py, keepInside)

  for (let i = 0; i < count; i += 2) {
    const qx = input[i]
    const qy = input[i + 1]
    const qs = side(ex, ey, dx, dy, qx, qy, keepInside)
    // 边界上的点按“内侧”处理：否则顶点恰好落在边上时会重复插入交点，
    // 输出多边形虽然面积不变，但会多出零长度边，后续三角化容易产生退化三角形。
    if (ps >= 0) {
      if (qs >= 0) {
        out.push(qx, qy)
      } else {
        pushIntersection(px, py, qx, qy, ps, qs, out)
      }
    } else if (qs >= 0) {
      pushIntersection(px, py, qx, qy, ps, qs, out)
      out.push(qx, qy)
    }
    px = qx
    py = qy
    ps = qs
  }
  return out.length
}

/** 点相对边 (ex,ey)→(ex+dx,ey+dy) 的符号；>0 表示在保留侧 */
function side(ex: number, ey: number, dx: number, dy: number, x: number, y: number, keepInside: boolean): number {
  const value = dx * (y - ey) - dy * (x - ex)
  return keepInside ? value : -value
}

function pushIntersection(
  px: number,
  py: number,
  qx: number,
  qy: number,
  ps: number,
  qs: number,
  out: number[]
): void {
  const denominator = ps - qs
  if (Math.abs(denominator) < EPSILON) {
    out.push(qx, qy)
    return
  }
  const t = ps / denominator
  out.push(px + (qx - px) * t, py + (qy - py) * t)
}

/**
 * 点 `(px,py)` 在三角形 `(ax,ay)-(bx,by)-(cx,cy)` 里的重心坐标。
 * 用于裁剪新顶点的 UV / 颜色插值；退化三角形回退到第一个顶点。
 */
export function barycentric(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): [number, number, number] {
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  if (Math.abs(denominator) < EPSILON) return [1, 0, 0]
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator
  return [a, b, 1 - a - b]
}

function toPoints(flat: Float32Array): Vec2[] {
  const points: Vec2[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] })
  return points
}

function toFloat32Array(points: readonly Vec2[]): Float32Array {
  const flat = new Float32Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    flat[i * 2] = points[i].x
    flat[i * 2 + 1] = points[i].y
  }
  return flat
}

/** 去掉重复点（含首尾重合），否则裁剪时会出现零长度边 */
function dedupe(flat: Float32Array): Float32Array {
  const out: number[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i]
    const y = flat[i + 1]
    const last = out.length
    if (last >= 2 && Math.abs(out[last - 2] - x) < EPSILON && Math.abs(out[last - 1] - y) < EPSILON) continue
    out.push(x, y)
  }
  while (
    out.length >= 4 &&
    Math.abs(out[0] - out[out.length - 2]) < EPSILON &&
    Math.abs(out[1] - out[out.length - 1]) < EPSILON
  ) {
    out.length -= 2
  }
  return Float32Array.from(out)
}

function ensureCcw(points: readonly Vec2[]): Vec2[] {
  return signedArea(points) < 0 ? [...points].reverse() : [...points]
}

function hull(points: readonly Vec2[]): Vec2[] {
  const indices = convexHull(points)
  const result = indices.map((index) => points[index])
  return ensureCcw(result)
}
