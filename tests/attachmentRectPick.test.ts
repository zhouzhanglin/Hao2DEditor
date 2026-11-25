import { describe, expect, it } from 'vitest'
import { pickAttachmentSlotsInRect } from '@render/picking'
import type { MeshBuildResult, MeshGroup } from '@core/skin/meshBuilder'

/**
 * 框选附件必须是**像素级**：包围盒盖住一块空地，不等于框到了那块美术。
 * 这里用合成网格把判定逻辑钉住（真实数据来自 meshBuilder，形状与这里同构）。
 */

interface QuadSpec {
  slot: number
  /** 左下角（世界坐标，y 向上为正在本测试里不重要，只做几何一致性） */
  x: number
  y: number
  size: number
}

/** 若干张 size×size 的四边形拼成一份 MeshBuildResult；UV 覆盖整张图 */
function meshOf(quads: readonly QuadSpec[]): MeshBuildResult {
  const positions = new Float32Array(quads.length * 8)
  const uvs = new Float32Array(quads.length * 8)
  const sourceSlot = new Int32Array(quads.length * 4)
  const sourceVertex = new Int32Array(quads.length * 4)
  const indices = new Uint32Array(quads.length * 6)
  quads.forEach((quad, q) => {
    const base = q * 4
    const x1 = quad.x + quad.size
    const y1 = quad.y + quad.size
    positions.set([quad.x, quad.y, x1, quad.y, x1, y1, quad.x, y1], base * 2)
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], base * 2)
    sourceSlot.fill(quad.slot, base, base + 4)
    sourceVertex.set([0, 1, 2, 3], base)
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], q * 6)
  })
  const group: MeshGroup = {
    materialIndex: 0,
    blendMode: 0,
    color: { r: 1, g: 1, b: 1, a: 1 },
    indices,
    indexCount: indices.length
  }
  return {
    positions,
    uvs,
    colors: new Float32Array(quads.length * 16),
    sourceSlot,
    sourceVertex,
    vertexCount: quads.length * 4,
    groups: [group],
    nestAnchors: [],
    clipPolygons: [],
    vertexClip: new Int32Array(quads.length * 4),
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  }
}

/** 只把 uv 的右半边当作不透明：用来模拟「包围盒很大、实际图形只占一半」的美术 */
const opaqueRightHalf = (_image: string, u: number): number => (u >= 0.5 ? 1 : 0)

function pick(
  mesh: MeshBuildResult,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  alphaAt: (image: string, u: number, v: number) => number = opaqueRightHalf,
  imageOfSlot: (slotIndex: number) => string = () => 'art.png'
): number[] {
  return pickAttachmentSlotsInRect(mesh, rect, { step: 0.5, imageOfSlot, alphaAt })
}

describe('框选 display：像素级判定', () => {
  it('框在透明留白里不选中（包围盒会误判的那种）', () => {
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    // 左半边全透明：矩形完全落在里面
    expect(pick(mesh, { minX: 5, minY: 20, maxX: 40, maxY: 80 })).toEqual([])
  })

  it('框到不透明像素才选中', () => {
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    expect(pick(mesh, { minX: 60, minY: 20, maxX: 90, maxY: 80 })).toEqual([0])
  })

  it('跨过透明 / 不透明分界也算命中', () => {
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    expect(pick(mesh, { minX: 30, minY: 10, maxX: 70, maxY: 90 })).toEqual([0])
  })

  it('矩形完全在图外不命中', () => {
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    expect(pick(mesh, { minX: 200, minY: 200, maxX: 260, maxY: 260 })).toEqual([])
  })

  it('两张图只有一张框到不透明像素时只返回那张', () => {
    // 0 号是中间挖空的相框（洞在 uv 0.25..0.75），1 号是实心小图，正好摆在洞里
    const mesh = meshOf([
      { slot: 0, x: 0, y: 0, size: 100 },
      { slot: 1, x: 40, y: 40, size: 20 }
    ])
    const alphaAt = (_image: string, u: number, v: number): number =>
      u > 0.25 && u < 0.75 && v > 0.25 && v < 0.75 ? 0 : 1
    // 框住洞里那一块：相框本身透明，只有里面的小图被选中
    expect(pick(mesh, { minX: 30, minY: 30, maxX: 70, maxY: 70 }, alphaAt)).toEqual([1])
    // 往左上挪一点，碰到相框边框（不透明）→ 两张都进来
    expect(pick(mesh, { minX: 10, minY: 10, maxX: 70, maxY: 70 }, alphaAt).sort()).toEqual([0, 1])
  })

  it('图片还没解码（拿不到图名 / alpha 恒为 1）时退化成几何命中', () => {
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    const noImage = pick(mesh, { minX: 5, minY: 20, maxX: 40, maxY: 80 }, () => 1, () => '')
    expect(noImage).toEqual([0])
    // 未就绪的图 alphaAt 返回 1（imageAlpha 的约定），同样命中
    expect(pick(mesh, { minX: 5, minY: 20, maxX: 40, maxY: 80 }, () => 1)).toEqual([0])
  })

  it('比采样步长还小的重叠也至少采到一个点', () => {
    // 只框到右下角 0.2 个世界单位：步长 0.5，靠「格子中心 + 缩到 2 个点」兜住
    const mesh = meshOf([{ slot: 0, x: 0, y: 0, size: 100 }])
    expect(pick(mesh, { minX: 99.9, minY: 99.9, maxX: 100, maxY: 100 })).toEqual([0])
  })
})
