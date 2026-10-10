import { describe, expect, it } from 'vitest'
import {
  boundsOf,
  buildAutoMesh,
  buildBinaryMask,
  contourArea,
  largestComponent,
  simplifyToTarget,
  traceOutline
} from '@core/mesh/autoMesh'
import type { AlphaMask } from '@core/mesh/autoMesh'
import { autoGenerateRegionMesh, convertMeshToRegion } from '@editor/commands/authoringCommands'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'

/** 造一张像素遮罩：`opaque(x, y)` 决定该像素是否不透明（y = 0 是图片顶部） */
function maskOf(width: number, height: number, opaque: (x: number, y: number) => boolean): AlphaMask {
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      alpha[y * width + x] = opaque(x, y) ? 255 : 0
    }
  }
  return { width, height, alpha }
}

const FULL_UV = { u0: 0, v0: 0, u1: 1, v1: 1 }

function meshOf(mask: AlphaMask, divisions = 8, size = { x: 10, y: 10 }) {
  return buildAutoMesh(mask, { size, uvRect: FULL_UV, divisions })
}

describe('二值化与连通域', () => {
  it('降采样时「块内有不透明像素即保留」，全透明返回 null', () => {
    const mask = maskOf(2000, 800, (x, y) => x > 1000 && y < 400)
    const binary = buildBinaryMask(mask, 128, 512)
    expect(binary).toBeTruthy()
    expect(Math.max(binary!.width, binary!.height)).toBeLessThanOrEqual(512)
    expect(buildBinaryMask(maskOf(4, 4, () => false))).toBeNull()
  })

  it('只保留面积最大的连通块（4-连通，对角不算相连）', () => {
    const mask = maskOf(100, 100, (x, y) => (x >= 10 && x < 70 && y >= 10 && y < 70) || (x > 80 && y > 80))
    const binary = buildBinaryMask(mask)!
    const component = largestComponent(binary)!
    let count = 0
    for (const value of component) if (value === 1) count++
    // 大块 60×60 = 3600，小块只有 19×19 = 361
    expect(count).toBe(3600)

    // 对角相邻（(0,0) 与 (1,1)）在 4-连通下是两块，取大的那块（单像素）
    const diagonal = buildBinaryMask(maskOf(4, 4, (x, y) => (x === 0 && y === 0) || (x === 1 && y === 1)))!
    let diagonalCount = 0
    for (const value of largestComponent(diagonal)!) if (value === 1) diagonalCount++
    expect(diagonalCount).toBe(1)
  })
})

describe('轮廓跟踪', () => {
  it('实心矩形的轮廓是闭合回环，顶点落在格子角上', () => {
    const mask = maskOf(20, 20, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15)
    const component = largestComponent(buildBinaryMask(mask)!)!
    const outline = traceOutline(component, mask.width, mask.height)
    expect(outline.length).toBeGreaterThanOrEqual(4)
    for (const point of outline) {
      const onGrid = Number.isInteger(point.x) && Number.isInteger(point.y)
      expect(onGrid).toBe(true)
      expect(point.x).toBeGreaterThanOrEqual(5)
      expect(point.x).toBeLessThanOrEqual(15)
      expect(point.y).toBeGreaterThanOrEqual(5)
      expect(point.y).toBeLessThanOrEqual(15)
    }
    // 闭合回环：绕一圈回到起点，面积等于 10×10
    expect(Math.abs(contourArea(outline))).toBeCloseTo(100, 4)
  })

  it('闭合多边形简化到目标顶点数，且退化时能兜底成包围盒', () => {
    const circle: Array<{ x: number; y: number }> = []
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2
      circle.push({ x: Math.cos(angle) * 50, y: Math.sin(angle) * 50 })
    }
    expect(simplifyToTarget(circle, 12).length).toBeLessThanOrEqual(12)
    expect(simplifyToTarget(circle, 40).length).toBeGreaterThanOrEqual(20)
    expect(boundsOf(circle)).toHaveLength(4)
  })
})

describe('自动网格（轮廓贴合）', () => {
  it('实心矩形：只覆盖矩形区域，显示空间尺寸与 UV 都正确', () => {
    // 图片 100×100，不透明区域 x∈[20,60)、y∈[20,50)（y 从上往下）
    const mask = maskOf(100, 100, (x, y) => x >= 20 && x < 60 && y >= 20 && y < 50)
    const mesh = meshOf(mask)!
    expect(mesh).toBeTruthy()
    // 显示尺寸 10×10 世界单位：40×30 像素 → 4×3
    expect(Math.abs(contourArea(mesh.vertices))).toBeCloseTo(12, 1)
    expect(mesh.vertices.length).toBeGreaterThanOrEqual(4)
    expect(mesh.vertices.length).toBeLessThanOrEqual(8)
    expect(mesh.triangles.length).toBeGreaterThanOrEqual(6)
    // 外环语义：hull = 顶点数，edges 覆盖全部顶点
    expect(mesh.hull).toBe(mesh.vertices.length)
    expect(mesh.edges).toHaveLength(mesh.vertices.length)
    // 所有顶点都落在矩形区域内（显示空间：中心为原点，y 向上）
    for (const point of mesh.vertices) {
      expect(point.x).toBeGreaterThanOrEqual(-3.01)
      expect(point.x).toBeLessThanOrEqual(1.01)
      expect(point.y).toBeGreaterThanOrEqual(-0.01)
      expect(point.y).toBeLessThanOrEqual(3.01)
    }
  })

  it('忽略内部孔洞：环形素材的网格覆盖整块外框', () => {
    // 外框 10..90，中间 30..70 透明（10 单位里 8×8 的外框，孔洞 4×4）
    const mask = maskOf(100, 100, (x, y) => {
      const inOuter = x >= 10 && x < 90 && y >= 10 && y < 90
      const inHole = x >= 30 && x < 70 && y >= 30 && y < 70
      return inOuter && !inHole
    })
    const mesh = meshOf(mask)!
    const area = Math.abs(contourArea(mesh.vertices))
    // 尊重孔洞会是 64 - 16 = 48；覆盖孔洞则为 64
    expect(area).toBeGreaterThan(60)
    expect(area).toBeLessThan(66)
  })

  it('凹形（L 形）保留凹角，不会退化成包围盒', () => {
    // 竖条 3×8 + 横条 8×3 - 重叠 3×3 = 39 世界单位²（包围盒会是 8×8 = 64）
    const mask = maskOf(100, 100, (x, y) => {
      const vertical = x >= 10 && x < 40 && y >= 10 && y < 90
      const horizontal = x >= 10 && x < 90 && y >= 10 && y < 40
      return vertical || horizontal
    })
    const mesh = meshOf(mask, 8)!
    // L 形至少 6 个角；凹陷处必须保留
    expect(mesh.vertices.length).toBeGreaterThanOrEqual(6)
    // 有顶点落在内凹角附近（像素 (40, 40) → 显示空间 (-1, 1)）
    const hasNotch = mesh.vertices.some(
      (point) => Math.abs(point.x + 1) < 0.35 && Math.abs(point.y - 1) < 0.35
    )
    expect(hasNotch).toBe(true)
    expect(Math.abs(contourArea(mesh.vertices))).toBeGreaterThan(36)
    expect(Math.abs(contourArea(mesh.vertices))).toBeLessThan(42)
  })

  it('忽略零碎块：只保留最大连通区域', () => {
    const mask = maskOf(100, 100, (x, y) => (x >= 10 && x < 70 && y >= 10 && y < 70) || (x >= 85 && y >= 85))
    const mesh = meshOf(mask)!
    expect(Math.abs(contourArea(mesh.vertices))).toBeGreaterThan(34)
    expect(Math.abs(contourArea(mesh.vertices))).toBeLessThan(38)
    // 没有一个顶点跑到右下角那块碎图的位置（x > 7.4 对应像素 85 以上）
    for (const point of mesh.vertices) expect(point.x).toBeLessThan(3.1)
  })

  it('方向约定：图片上半的像素对应 y > 0 且 UV 的 v > 0.5', () => {
    // 上半不透明（y < 50），下半透明
    const mask = maskOf(100, 100, (_x, y) => y < 50)
    const mesh = meshOf(mask)!
    for (let i = 0; i < mesh.vertices.length; i++) {
      // 不透明区域在图片上半：显示空间 y ≥ 0（下边界正好是图片中线），UV 的 v ≥ 0.5
      expect(mesh.vertices[i].y).toBeGreaterThanOrEqual(0)
      expect(mesh.uvs[i * 2 + 1]).toBeGreaterThanOrEqual(0.5)
    }
    // 全部顶点都在上半，网格上边界贴着图片顶边（y = 5 = size/2）
    const maxY = Math.max(...mesh.vertices.map((point) => point.y))
    expect(maxY).toBeGreaterThan(4.5)
    expect(maxY).toBeLessThanOrEqual(5.01)
  })

  it('UV 映射进传入的 uvRect（图集子区域）', () => {
    const mask = maskOf(100, 100, (x, y) => x >= 20 && x < 80 && y >= 20 && y < 80)
    const mesh = buildAutoMesh(mask, {
      size: { x: 8, y: 8 },
      uvRect: { u0: 0.25, v0: 0.1, u1: 0.5, v1: 0.6 },
      divisions: 8
    })!
    for (let i = 0; i < mesh.vertices.length; i++) {
      const u = mesh.uvs[i * 2]
      const v = mesh.uvs[i * 2 + 1]
      expect(u).toBeGreaterThanOrEqual(0.25 - 1e-6)
      expect(u).toBeLessThanOrEqual(0.5 + 1e-6)
      expect(v).toBeGreaterThanOrEqual(0.1 - 1e-6)
      expect(v).toBeLessThanOrEqual(0.6 + 1e-6)
    }
  })

  it('遮罩是整张图时，只取本附件 UV 矩形内的内容（顶点按矩形归一化，不按整图）', () => {
    /*
     * 图片 100×100，两块内容：
     * - 左边一大块（30×80 = 2400 像素）—— 它是整图里「面积最大的连通块」
     * - 右边一小块（30×30 = 900 像素）
     * 附件只覆盖**右半张图**（u ∈ [0.5, 1]）：网格必须跟着右边那一小块走，
     * 既不能按整图占比缩到一角，也不能被左边那块更大的部件带跑。
     */
    const mask = maskOf(100, 100, (x, y) => {
      const left = x >= 10 && x < 40 && y >= 10 && y < 90
      const right = x >= 60 && x < 90 && y >= 10 && y < 40
      return left || right
    })
    const mesh = buildAutoMesh(mask, {
      size: { x: 8, y: 8 },
      uvRect: { u0: 0.5, v0: 0, u1: 1, v1: 1 },
      divisions: 8
    })!
    expect(mesh).toBeTruthy()
    const xs = mesh.vertices.map((point) => point.x)
    const ys = mesh.vertices.map((point) => point.y)
    // 右块横向：像素 60..90 → 矩形内 0.2..0.8 → 显示空间 -2.4..2.4
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-2.6)
    expect(Math.max(...xs)).toBeLessThanOrEqual(2.6)
    // 纵向：像素 10..40（自上而下）→ 矩形内 0.1..0.4 → 显示空间 0.8..3.2
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0.6)
    expect(Math.max(...ys)).toBeLessThanOrEqual(3.4)
    // 面积 ≈ 4.8 × 2.4（若被左边那块带跑，量级会完全不同）
    expect(Math.abs(contourArea(mesh.vertices))).toBeGreaterThan(10)
    expect(Math.abs(contourArea(mesh.vertices))).toBeLessThan(13)
    // UV 落在矩形内
    for (let i = 0; i < mesh.vertices.length; i++) {
      expect(mesh.uvs[i * 2]).toBeGreaterThanOrEqual(0.5 - 1e-6)
      expect(mesh.uvs[i * 2]).toBeLessThanOrEqual(1 + 1e-6)
    }
  })

  it('顶点数量级随细分数非递减，且不超过上限', () => {
    const mask = maskOf(200, 200, (x, y) => {
      const dx = x - 100
      const dy = y - 100
      return dx * dx + dy * dy < 80 * 80
    })
    const low = meshOf(mask, 3)!.vertices.length
    const mid = meshOf(mask, 8)!.vertices.length
    const high = meshOf(mask, 20)!.vertices.length
    expect(mid).toBeGreaterThanOrEqual(low)
    expect(high).toBeGreaterThanOrEqual(mid)

    const capped = buildAutoMesh(mask, { size: { x: 10, y: 10 }, uvRect: FULL_UV, divisions: 24, maxVertices: 12 })!
    expect(capped.vertices.length).toBeLessThanOrEqual(12)
  })

  it('全透明图片返回 null（调用方给出提示）', () => {
    expect(meshOf(maskOf(64, 64, () => false))).toBeNull()
  })
})

describe('autoGenerateRegionMesh 命令', () => {
  function docWithRegion(image = 'a.png'): EditorDocument {
    const doc = createEmptyDocument('t')
    doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
    doc.slots = [createAuthoringSlot({ name: 'body', bone: 'root', attachment: 'art' })]
    doc.skins = [
      {
        name: 'default',
        slots: [
          {
            slot: 'body',
            attachments: [
              createAuthoringAttachment({ name: 'art', type: 'region', image, size: { x: 4, y: 3 } })
            ]
          }
        ]
      }
    ]
    doc.images = [{ name: image, path: '/art/a.png', width: 100, height: 100, loose: true }]
    return doc
  }

  const mask = maskOf(100, 100, (x, y) => x >= 20 && x < 80 && y >= 20 && y < 80)

  it('把 Region 转成轮廓网格：权重绑宿主骨骼、留下快照、可一键还原', () => {
    const doc = docWithRegion()
    const result = autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)
    expect(result).toBeTruthy()
    expect(result!.vertices).toBeGreaterThanOrEqual(4)

    const attachment = doc.skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe('mesh')
    expect(attachment.vertices).toHaveLength(result!.vertices)
    expect(attachment.hull).toBe(attachment.vertices.length)
    expect(attachment.edges).toHaveLength(attachment.vertices.length)
    expect(attachment.vertices[0].weights).toEqual([{ bone: 'root', weight: 1 }])
    expect(attachment.regionSnapshot?.size).toEqual({ x: 4, y: 3 })

    // 还原回 Region
    expect(convertMeshToRegion(doc, 'body', 'art')).toBe(true)
    expect(attachment.type).toBe('region')
    expect(attachment.vertices).toEqual([])
    expect(attachment.regionSnapshot).toBeUndefined()
  })

  it('已经是轮廓网格时可以再次生成（用快照里的 UV 矩形，结果依然正确）', () => {
    const doc = docWithRegion()
    autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)
    const first = doc.skins[0].slots[0].attachments[0].uvs.slice()

    const again = autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)
    expect(again).toBeTruthy()
    const attachment = doc.skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe('mesh')
    // 同样的输入得到同样的结果（不会因为上一次的网格 UV 而漂移）
    expect(attachment.uvs).toEqual(first)
  })

  it('重新生成网格会清掉该附件的 FFD 帧（顶点数变化会让旧 offsets 错位）', () => {
    const doc = docWithRegion()
    autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)
    const animation = createAuthoringAnim('idle')
    animation.deforms = [
      { slot: 'body', attachment: 'art', frames: [] },
      { slot: 'other', attachment: 'x', frames: [] }
    ]
    doc.animations.push(animation)

    expect(autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)).toBeTruthy()
    const deforms = doc.animations[0].deforms
    expect(deforms.some((track) => track.slot === 'body' && track.attachment === 'art')).toBe(false)
    // 其它附件的 FFD 不受影响
    expect(deforms.some((track) => track.slot === 'other')).toBe(true)
  })

  it('全透明图片：命令返回 null 且不改动附件', () => {
    const doc = docWithRegion()
    const result = autoGenerateRegionMesh(doc, 'body', 'art', maskOf(100, 100, () => false), 8)
    expect(result).toBeNull()
    expect(doc.skins[0].slots[0].attachments[0].type).toBe('region')
  })

  it('附件不存在 / 类型不支持时返回 null', () => {
    const doc = docWithRegion()
    expect(autoGenerateRegionMesh(doc, 'body', 'missing', mask, 8)).toBeNull()
    doc.skins[0].slots[0].attachments[0].type = 'boundingbox'
    expect(autoGenerateRegionMesh(doc, 'body', 'art', mask, 8)).toBeNull()
  })
})
