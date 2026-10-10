import { describe, expect, it } from 'vitest'
import { pickAttachmentPixel, pickBone, pickBoneHandle } from '@render/picking'
import { createBoneData } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import type { MeshBuildResult, MeshGroup } from '@core/skin/meshBuilder'

interface QuadSpec {
  slot: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 造一组「四边形附件」的 mesh 结果：顶点顺序 = 左下 → 右下 → 右上 → 左上，
 * uv 对应 (0,0) (1,0) (1,1) (0,1)，三角形 0-1-2 / 0-2-3。
 * 每个四边形一个 group（模拟不同插槽被拆成不同绘制分组）。
 */
function quadMesh(quads: QuadSpec[]): MeshBuildResult {
  const vertexCount = quads.length * 4
  const positions = new Float32Array(vertexCount * 2)
  const uvs = new Float32Array(vertexCount * 2)
  const sourceSlot = new Int32Array(vertexCount)
  const sourceVertex = new Int32Array(vertexCount)
  const groups: MeshGroup[] = []
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  quads.forEach((quad, q) => {
    const base = q * 4
    const corners: Array<[number, number]> = [
      [quad.minX, quad.minY],
      [quad.maxX, quad.minY],
      [quad.maxX, quad.maxY],
      [quad.minX, quad.maxY]
    ]
    const cornerUvs: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ]
    corners.forEach((corner, i) => {
      const index = base + i
      positions[index * 2] = corner[0]
      positions[index * 2 + 1] = corner[1]
      uvs[index * 2] = cornerUvs[i][0]
      uvs[index * 2 + 1] = cornerUvs[i][1]
      sourceSlot[index] = quad.slot
      sourceVertex[index] = i
      minX = Math.min(minX, corner[0])
      minY = Math.min(minY, corner[1])
      maxX = Math.max(maxX, corner[0])
      maxY = Math.max(maxY, corner[1])
    })
    groups.push({
      materialIndex: 0,
      blendMode: 0,
      color: { r: 1, g: 1, b: 1, a: 1 },
      indices: new Uint32Array([base, base + 1, base + 2, base, base + 2, base + 3]),
      indexCount: 6
    })
  })

  return {
    positions,
    uvs,
    colors: new Float32Array(vertexCount * 4),
    sourceSlot,
    sourceVertex,
    vertexCount,
    groups,
    bounds: { minX, minY, maxX, maxY }
  }
}

/** 左半边不透明、右半边透明的「图片」 */
const leftHalfOpaque = (_image: string, u: number): number => (u < 0.5 ? 1 : 0)

describe('pickAttachmentPixel', () => {
  it('命中不透明像素：左半边点得中，右半边（透明）点不中', () => {
    const mesh = quadMesh([{ slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 }])
    const options = { imageOfSlot: () => 'a.png', alphaAt: leftHalfOpaque }

    expect(pickAttachmentPixel(mesh, 0.5, 1, options)).toEqual({ slotIndex: 0 })
    expect(pickAttachmentPixel(mesh, 1.5, 1, options)).toBeNull()
  })

  it('没有图片信息时退化为几何命中（图片没解码完也不会点不中）', () => {
    const mesh = quadMesh([{ slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 }])
    const options = { imageOfSlot: () => '', alphaAt: () => 0 }

    expect(pickAttachmentPixel(mesh, 1.5, 1, options)).toEqual({ slotIndex: 0 })
  })

  it('alpha 低于阈值算透明（滤掉边缘抗锯齿像素）', () => {
    const mesh = quadMesh([{ slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 }])
    const faint = { imageOfSlot: () => 'a.png', alphaAt: () => 0.02 }
    expect(pickAttachmentPixel(mesh, 1, 1, faint)).toBeNull()

    const solid = { imageOfSlot: () => 'a.png', alphaAt: () => 0.05 }
    expect(pickAttachmentPixel(mesh, 1, 1, solid)).toEqual({ slotIndex: 0 })
  })

  it('重叠时取最后绘制的（视觉最上层）', () => {
    // slot 0 在下、slot 1 在上，两块完全重叠且都不透明
    const mesh = quadMesh([
      { slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 },
      { slot: 1, minX: 0, minY: 0, maxX: 2, maxY: 2 }
    ])
    const options = { imageOfSlot: (slot: number) => `s${slot}.png`, alphaAt: () => 1 }
    expect(pickAttachmentPixel(mesh, 1, 1, options)).toEqual({ slotIndex: 1 })
  })

  it('上层透明处穿透到下层', () => {
    const mesh = quadMesh([
      { slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 },
      { slot: 1, minX: 0, minY: 0, maxX: 2, maxY: 2 }
    ])
    const options = {
      imageOfSlot: (slot: number) => `s${slot}.png`,
      // 上层只有左半边有内容
      alphaAt: (image: string, u: number) => (image === 's1.png' ? (u < 0.5 ? 1 : 0) : 1)
    }
    expect(pickAttachmentPixel(mesh, 0.5, 1, options)).toEqual({ slotIndex: 1 })
    expect(pickAttachmentPixel(mesh, 1.5, 1, options)).toEqual({ slotIndex: 0 })
  })

  it('落在所有三角形之外不命中', () => {
    const mesh = quadMesh([{ slot: 0, minX: 0, minY: 0, maxX: 2, maxY: 2 }])
    const options = { imageOfSlot: () => 'a.png', alphaAt: () => 1 }
    expect(pickAttachmentPixel(mesh, 3, 1, options)).toBeNull()
    expect(pickAttachmentPixel(mesh, 1, -1, options)).toBeNull()
    expect(pickAttachmentPixel(null, 1, 1, options)).toBeNull()
  })
})

/** 命中阈值（世界单位，约等于 8px @100PPU） */
const BONE_TOLERANCE = 0.1

/** 父 + 子两根水平骨骼：都从各自的 x 起、沿 +x 延伸 length；子相对父定位 */
function bonesSkeleton(parent: { x: number; length: number }, child: { x: number; length: number }): Skeleton {
  const asset = createRuntimeAsset()
  asset.bones = [
    createBoneData({ name: 'root', parentIndex: -1, localPosition: { x: parent.x, y: 0 }, length: parent.length }),
    createBoneData({ name: 'root_child', parentIndex: 0, localPosition: { x: child.x, y: 0 }, length: child.length })
  ]
  return new Skeleton(asset)
}

describe('骨骼拾取：距离打平时子骨骼优先', () => {
  it('完全重叠（父 0→2、子 0→2）：点中段与末端都选到子骨骼', () => {
    const skeleton = bonesSkeleton({ x: 0, length: 2 }, { x: 0, length: 2 })
    expect(pickBone(skeleton, 1, 0, BONE_TOLERANCE)?.boneIndex).toBe(1)
    expect(pickBone(skeleton, 1.9, 0, BONE_TOLERANCE)?.boneIndex).toBe(1)
  })

  it('部分重叠（父 0→2、子 1→3）：重叠区选子骨骼，各自独有段仍归自己', () => {
    const skeleton = bonesSkeleton({ x: 0, length: 2 }, { x: 1, length: 2 })
    expect(pickBone(skeleton, 1.5, 0, BONE_TOLERANCE)?.boneIndex).toBe(1) // 重叠区 → 子
    expect(pickBone(skeleton, 2.5, 0, BONE_TOLERANCE)?.boneIndex).toBe(1) // 子独有
    expect(pickBone(skeleton, 0.5, 0, BONE_TOLERANCE)?.boneIndex).toBe(0) // 父独有
  })

  it('「更近」仍然优先于「子优先」：离父骨骼更近时选父', () => {
    const asset = createRuntimeAsset()
    asset.bones = [
      createBoneData({ name: 'root', parentIndex: -1, localPosition: { x: 0, y: 0 }, length: 2 }),
      createBoneData({ name: 'root_child', parentIndex: 0, localPosition: { x: 0, y: 0.3 }, length: 2 })
    ]
    const skeleton = new Skeleton(asset)
    expect(pickBone(skeleton, 1, 0.02, BONE_TOLERANCE)?.boneIndex).toBe(0)
    expect(pickBone(skeleton, 1, 0.28, BONE_TOLERANCE)?.boneIndex).toBe(1)
  })

  it('原点圈拾取同一规则：完全重叠时点原点也选子骨骼', () => {
    const skeleton = bonesSkeleton({ x: 0, length: 2 }, { x: 0, length: 2 })
    const hit = pickBoneHandle(skeleton, 0.01, 0, BONE_TOLERANCE, 0.3)
    expect(hit?.boneIndex).toBe(1)
    expect(hit?.zone).toBe('origin')
  })
})
