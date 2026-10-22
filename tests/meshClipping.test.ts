import { describe, expect, it } from 'vitest'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { Skeleton } from '@core/model/skeleton'
import { AttachmentType, createAttachmentData } from '@core/model/types'
import type { AttachmentData, BoneData, SkinData, SlotData } from '@core/model/types'
import { asset, bone, region, skin, slot } from './fixtures'

interface SetupResult {
  builder: MeshBuilder
  skeleton: Skeleton
}

function setup(bones: BoneData[], slots: SlotData[], skins: SkinData[]): SetupResult {
  const runtime = asset(bones, slots, skins)
  return { builder: new MeshBuilder(runtime), skeleton: new Skeleton(runtime) }
}

function clipping(name: string, points: number[], endSlot = '', inverse = false): AttachmentData {
  return createAttachmentData({
    name,
    type: AttachmentType.Clipping,
    vertices: Float32Array.from(points),
    hull: Math.floor(points.length / 2),
    clipEndSlot: endSlot,
    clipInverse: inverse,
    clipConvex: false
  })
}

/** 所有分组三角形的面积之和（世界单位） */
function totalArea(result: ReturnType<MeshBuilder['build']>): number {
  let area = 0
  const positions = result.positions
  for (const group of result.groups) {
    const indices = group.indices
    for (let i = 0; i + 2 < group.indexCount; i += 3) {
      const a = indices[i]
      const b = indices[i + 1]
      const c = indices[i + 2]
      const ax = positions[a * 2]
      const ay = positions[a * 2 + 1]
      const bx = positions[b * 2]
      const by = positions[b * 2 + 1]
      const cx = positions[c * 2]
      const cy = positions[c * 2 + 1]
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
    }
  }
  return area
}

const body = (): AttachmentData => region('body', 'tex', 100, 100)

describe('MeshBuilder 遮罩裁剪', () => {
  it('遮罩之后的附件被裁到多边形内', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('mask', 0, { setupAttachment: 'mask', displayIndex: 0 }), slot('body', 0, { setupAttachment: 'body', displayIndex: 0 })],
      [
        skin('default', [
          { slotName: 'mask', attachments: [clipping('mask', [-25, -25, 25, -25, 25, 25, -25, 25])] },
          { slotName: 'body', attachments: [body()] }
        ])
      ]
    )
    const result = builder.build(skeleton)
    expect(result.clipPolygons).toHaveLength(1)
    expect(result.clipPolygons[0].endSlotIndex).toBe(-1)
    // 100×100 的区域只保留中央 50×50
    expect(totalArea(result)).toBeCloseTo(2500, 3)
    // 裁剪出来的顶点不能被当成可编辑的原顶点
    let generated = 0
    for (let i = 0; i < result.vertexCount; i++) if (result.sourceVertex[i] === -1) generated++
    expect(generated).toBeGreaterThan(0)
  })

  it('结束插槽自身不被裁剪，遮罩之前的附件不受影响', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [
        slot('before', 0, { setupAttachment: 'before', displayIndex: 0 }),
        slot('mask', 0, { setupAttachment: 'mask', displayIndex: 0 }),
        slot('body', 0, { setupAttachment: 'body', displayIndex: 0 }),
        slot('after', 0, { setupAttachment: 'after', displayIndex: 0 })
      ],
      [
        skin('default', [
          { slotName: 'before', attachments: [region('before', 'tex', 100, 100)] },
          { slotName: 'mask', attachments: [clipping('mask', [-25, -25, 25, -25, 25, 25, -25, 25], 'after')] },
          { slotName: 'body', attachments: [body()] },
          { slotName: 'after', attachments: [region('after', 'tex', 100, 100)] }
        ])
      ]
    )
    const result = builder.build(skeleton)
    expect(result.clipPolygons[0].endSlotIndex).toBe(3)
    // before 10000 + body 2500 + after 10000
    expect(totalArea(result)).toBeCloseTo(22500, 3)
  })

  it('反向遮罩保留多边形外部', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('mask', 0, { setupAttachment: 'mask', displayIndex: 0 }), slot('body', 0, { setupAttachment: 'body', displayIndex: 0 })],
      [
        skin('default', [
          { slotName: 'mask', attachments: [clipping('mask', [-25, -25, 25, -25, 25, 25, -25, 25], '', true)] },
          { slotName: 'body', attachments: [body()] }
        ])
      ]
    )
    const result = builder.build(skeleton)
    expect(totalArea(result)).toBeCloseTo(7500, 3)
  })

  it('遮罩插槽隐藏时不生效', () => {
    const { builder, skeleton } = setup(
      [bone('root', -1)],
      [slot('mask', 0, { setupAttachment: 'mask', displayIndex: 0 }), slot('body', 0, { setupAttachment: 'body', displayIndex: 0 })],
      [
        skin('default', [
          { slotName: 'mask', attachments: [clipping('mask', [-25, -25, 25, -25, 25, 25, -25, 25])] },
          { slotName: 'body', attachments: [body()] }
        ])
      ]
    )
    skeleton.setSlotVisible(0, false)
    const result = builder.build(skeleton)
    expect(result.clipPolygons).toHaveLength(0)
    expect(totalArea(result)).toBeCloseTo(10000, 3)
  })
})
