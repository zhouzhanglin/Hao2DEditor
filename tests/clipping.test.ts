import { describe, expect, it } from 'vitest'
import { buildClipPolygon, TriangleClipper } from '@core/skin/clipping'
import type { ClipPolygon } from '@core/skin/clipping'

/** 三角形面积（绝对值） */
function triangleArea(a: [number, number], b: [number, number], c: [number, number]): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
}

/** 把裁剪回调吐出的多边形按扇形面积累加（凸多边形，足够本测试用） */
function clipArea(clip: ClipPolygon, a: [number, number], b: [number, number], c: [number, number]): number {
  let area = 0
  const clipper = new TriangleClipper()
  clipper.clipTriangle(a[0], a[1], b[0], b[1], c[0], c[1], clip, (points, count) => {
    const first: [number, number] = [points[0], points[1]]
    for (let i = 3; i + 1 < count; i += 2) {
      area += triangleArea(first, [points[i - 1], points[i]], [points[i + 1], points[i + 2]])
    }
  })
  return area
}

function polygon(...points: Array<[number, number]>): Float32Array {
  return Float32Array.from(points.flat())
}

describe('Polygon clipping', () => {
  const square = buildClipPolygon(polygon([0, 0], [10, 0], [10, 10], [0, 10]), -1, false, true)!

  it('构建凸遮罩', () => {
    expect(square).not.toBeNull()
    expect(square.pieces).toHaveLength(1)
    expect(square.points.length).toBe(8)
  })

  it('完全在多边形内的三角形原样保留', () => {
    const area = clipArea(square, [2, 2], [8, 2], [2, 8])
    expect(area).toBeCloseTo(18, 5)
  })

  it('完全在多边形外的三角形被丢弃', () => {
    const area = clipArea(square, [20, 20], [30, 20], [20, 30])
    expect(area).toBe(0)
  })

  it('跨边界的三角形只保留交集', () => {
    // 三角形 (-5,5)-(15,5)-(5,20) 与正方形 (0..10) 的交集是 10×5 的矩形 → 50
    const area = clipArea(square, [-5, 5], [15, 5], [5, 20])
    expect(area).toBeCloseTo(50, 5)
  })

  it('凹多边形（L 形）拆成凸块后面积正确', () => {
    const lShape = buildClipPolygon(
      polygon([0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]),
      -1,
      false,
      false
    )!
    expect(lShape.pieces.length).toBeGreaterThan(1)
    // 覆盖整个 L 形的三角形：面积 = 10*4 + 4*6 = 64
    const area = clipArea(lShape, [-10, -10], [30, -10], [-10, 30])
    expect(area).toBeCloseTo(64, 4)
  })

  it('反向遮罩保留多边形外部', () => {
    const inverse = buildClipPolygon(polygon([0, 0], [10, 0], [10, 10], [0, 10]), -1, true, true)!
    // 大三角形 (-20,-20)-(60,-20)-(-20,60)：面积 3200，完全包含正方形（内部 100）→ 3100
    const area = clipArea(inverse, [-20, -20], [60, -20], [-20, 60])
    expect(area).toBeCloseTo(3100, 4)
  })

  it('退化多边形返回 null', () => {
    expect(buildClipPolygon(polygon([0, 0], [1, 1]), -1, false, true)).toBeNull()
    expect(buildClipPolygon(polygon([0, 0], [1, 1], [2, 2]), -1, false, true)).toBeNull()
  })
})
