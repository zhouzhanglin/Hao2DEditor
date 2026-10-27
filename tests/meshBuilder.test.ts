import { describe, expect, it } from 'vitest'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { Skeleton } from '@core/model/skeleton'
import { BlendMode } from '@core/model/types'
import type { AttachmentData, BoneData, SkinData, SlotData } from '@core/model/types'
import { asset, bone, mesh, region, skin, slot, weight } from './fixtures'

interface SetupResult {
  builder: MeshBuilder
  skeleton: Skeleton
}

function setup(
  bones: BoneData[],
  slots: SlotData[],
  skins: SkinData[],
  textures?: string[]
): SetupResult {
  const runtime = asset(bones, slots, skins, textures ? { textures } : undefined)
  return { builder: new MeshBuilder(runtime), skeleton: new Skeleton(runtime) }
}

function point(result: { positions: Float32Array }, index: number): [number, number] {
  return [round(result.positions[index * 2]), round(result.positions[index * 2 + 1])]
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5
}

function indicesOf(result: { groups: Array<{ indices: Uint32Array; indexCount: number }> }, group: number): number[] {
  const g = result.groups[group]
  return Array.from(g.indices.subarray(0, g.indexCount))
}

const singleRegion = () =>
  setup(
    [bone('root', -1, 0, 0, 0, 10)],
    [slot('s', 0)],
    [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
  )

describe('Region 顶点产出', () => {
  it('四角顺序为 (-hw,-hh) (hw,-hh) (hw,hh) (-hw,hh)', () => {
    const { builder, skeleton } = singleRegion()
    const result = builder.build(skeleton)
    expect(result.vertexCount).toBe(4)
    expect(point(result, 0)).toEqual([-1, -1])
    expect(point(result, 1)).toEqual([1, -1])
    expect(point(result, 2)).toEqual([1, 1])
    expect(point(result, 3)).toEqual([-1, 1])
  })

  it('UV 顺序与四角一致（数据 v=0 是图像底部，写出时翻转给 Pixi 采样）', () => {
    const { builder, skeleton } = singleRegion()
    const result = builder.build(skeleton)
    expect([result.uvs[0], result.uvs[1]]).toEqual([0, 1])
    expect([result.uvs[2], result.uvs[3]]).toEqual([1, 1])
    expect([result.uvs[4], result.uvs[5]]).toEqual([1, 0])
    expect([result.uvs[6], result.uvs[7]]).toEqual([0, 0])
  })

  it('单组、索引为 0-1-2 / 0-2-3', () => {
    const { builder, skeleton } = singleRegion()
    const result = builder.build(skeleton)
    expect(result.groups).toHaveLength(1)
    expect(indicesOf(result, 0)).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('包围盒覆盖四角', () => {
    const { builder, skeleton } = singleRegion()
    expect(builder.build(skeleton).bounds).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 })
  })

  it('骨骼旋转 90° 时四角随之旋转', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1, 0, 0, 90, 10)],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    const result = builder.build(skeleton)
    expect(point(result, 0)).toEqual([1, -1])
  })

  it('附件 position 作为局部偏移参与变换', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1, 10, 5)],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2, { x: 3, y: 0 })] }])]
    )
    const result = builder.build(skeleton)
    expect(point(result, 0)).toEqual([12, 4])
  })
})

describe('分组只与紧邻上一组合并（画家算法保序）', () => {
  it('同材质相邻槽合并为一组', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('a', 0), slot('b', 0)],
      [
        skin('default', [
          { slotName: 'a', attachments: [region('ra', 'tex', 2, 2)] },
          { slotName: 'b', attachments: [region('rb', 'tex', 2, 2)] }
        ])
      ],
      ['tex']
    )
    const result = builder.build(skeleton)
    expect(result.groups).toHaveLength(1)
    expect(result.vertexCount).toBe(8)
  })

  it('材质 A/B/A 交替时保持三组（不与更早的 A 合并）', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('a', 0), slot('b', 0), slot('c', 0)],
      [
        skin('default', [
          { slotName: 'a', attachments: [region('ra', 'texA', 2, 2)] },
          { slotName: 'b', attachments: [region('rb', 'texB', 2, 2)] },
          { slotName: 'c', attachments: [region('rc', 'texA', 2, 2)] }
        ])
      ],
      ['texA', 'texB']
    )
    const result = builder.build(skeleton)
    expect(result.groups).toHaveLength(3)
    expect(result.groups.map((g) => g.materialIndex)).toEqual([0, 1, 0])
  })

  it('同材质但混合模式不同分成两组', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('a', 0), slot('b', 0, { blendMode: BlendMode.Additive })],
      [
        skin('default', [
          { slotName: 'a', attachments: [region('ra', 'tex', 2, 2)] },
          { slotName: 'b', attachments: [region('rb', 'tex', 2, 2)] }
        ])
      ],
      ['tex']
    )
    const result = builder.build(skeleton)
    expect(result.groups).toHaveLength(2)
    expect(result.groups[0].blendMode).toBe(BlendMode.Normal)
    expect(result.groups[1].blendMode).toBe(BlendMode.Additive)
  })

  it('绘制顺序变化会改变分组顺序', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('a', 0), slot('b', 0)],
      [
        skin('default', [
          { slotName: 'a', attachments: [region('ra', 'texA', 2, 2)] },
          { slotName: 'b', attachments: [region('rb', 'texB', 2, 2)] }
        ])
      ],
      ['texA', 'texB']
    )
    skeleton.drawOrder[0] = 1
    skeleton.drawOrder[1] = 0
    expect(builder.build(skeleton).groups.map((g) => g.materialIndex)).toEqual([1, 0])
  })
})

describe('Mesh 蒙皮与 FFD', () => {
  function rigged(attachments: AttachmentData[], bones: BoneData[]): SetupResult {
    return setup(bones, [slot('s', 0)], [skin('default', [{ slotName: 's', attachments }])])
  }

  it('单骨骼权重 1 等价于刚体变换', () => {
    const { builder, skeleton } = rigged(
      [
        mesh('m', 'tex', [0, 0, 10, 0, 10, 10], [0, 1, 2], [
          weight(0, 1, 0, 0),
          weight(0, 1, 10, 0),
          weight(0, 1, 10, 10)
        ])
      ],
      [bone('root', -1)]
    )
    skeleton.localPos[0] = 5
    skeleton.localPos[1] = 3
    skeleton.updateFk(0)
    const result = builder.build(skeleton)
    expect(point(result, 0)).toEqual([5, 3])
    expect(point(result, 1)).toEqual([15, 3])
    expect(point(result, 2)).toEqual([15, 13])
    expect(builder.lastBuildHadWeightedMesh).toBe(true)
  })

  it('两骨骼 50/50 权重产出中点', () => {
    const { builder, skeleton } = rigged(
      [
        mesh('m', 'tex', [0, 0], [0], [
          {
            b0: 0,
            b1: 1,
            b2: 0,
            b3: 0,
            lx0: 0,
            ly0: 0,
            lx1: 0,
            ly1: 0,
            lx2: 0,
            ly2: 0,
            lx3: 0,
            ly3: 0,
            w0: 0.5,
            w1: 0.5,
            w2: 0,
            w3: 0
          }
        ])
      ],
      [bone('root', -1, 0, 0), bone('child', 0, 10, 0)]
    )
    expect(point(builder.build(skeleton), 0)).toEqual([5, 0])
  })

  it('骨内 FFD 偏移在蒙皮之前叠加', () => {
    const { builder, skeleton } = rigged(
      [mesh('m', 'tex', [0, 0], [0], [weight(0, 1, 0, 0)], { ffdInBoneSpace: true })],
      [bone('root', -1, 0, 0, 90)]
    )
    skeleton.deformOffsets[0] = [10, 0]
    skeleton.deformOffsetBase[0] = 0
    skeleton.updateFk(0)
    // 骨内偏移 (10,0) 经骨骼旋转 90° → 世界 (0,10)
    expect(point(builder.build(skeleton), 0)).toEqual([0, 10])
  })

  it('无权重时走刚体路径，不标记加权网格', () => {
    const { builder, skeleton } = rigged([mesh('m', 'tex', [0, 0, 4, 0], [0, 1], [])], [bone('root', -1)])
    const result = builder.build(skeleton)
    expect(builder.lastBuildHadWeightedMesh).toBe(false)
    expect(result.vertexCount).toBe(2)
  })

  it('Mesh 没有三角形时仍写出顶点但不产生索引（与 Unity 端 Hao2D 运行时一致）', () => {
    const { builder, skeleton } = rigged([mesh('m', 'tex', [0, 0, 1, 1], [], [])], [bone('root', -1)])
    const result = builder.build(skeleton)
    expect(result.vertexCount).toBe(2)
    expect(result.groups.reduce((sum, g) => sum + g.indexCount, 0)).toBe(0)
  })
})

describe('插槽状态与染色', () => {
  it('隐藏插槽不产出顶点', () => {
    const { builder, skeleton } = singleRegion()
    skeleton.slotVisible[0] = 0
    expect(builder.build(skeleton).vertexCount).toBe(0)
  })

  it('displayIndex 为 -1 的插槽不绘制', () => {
    const { builder, skeleton } = singleRegion()
    skeleton.slotDisplayIndex[0] = -1
    expect(builder.build(skeleton).vertexCount).toBe(0)
  })

  it('顶点色 = 插槽色 × 附件色 × 整体染色', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('s', 0, { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } })],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    builder.tint = { r: 1, g: 0.5, b: 1, a: 0.5 }
    const result = builder.build(skeleton)
    expect(result.colors[0]).toBeCloseTo(0.5, 5)
    expect(result.colors[1]).toBeCloseTo(0.25, 5)
    expect(result.colors[3]).toBeCloseTo(0.5, 5)
  })

  it('顶点缓冲在多次构建之间复用', () => {
    const { builder, skeleton } = singleRegion()
    const first = builder.build(skeleton)
    const positions = first.positions
    expect(builder.build(skeleton).positions).toBe(positions)
  })

  it('顶点数变化时缓冲扩容且数据正确', () => {
    const { builder, skeleton } = singleRegion()
    builder.build(skeleton)
    const result = builder.build(skeleton)
    expect(result.vertexCount).toBe(4)
    expect(point(result, 3)).toEqual([-1, 1])
  })
})
