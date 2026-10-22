import { describe, expect, it } from 'vitest'
import { compileDocument } from '@core/codec/compile'
import { HAO2D_VERSION, writeHao2d } from '@core/codec/hao2dWriter'
import { readHao2d } from '@core/codec/hao2dReader'
import {
  createAuthoringAttachment,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import { AttachmentType } from '@core/model/types'

describe('.hao2d v7 遮罩往返', () => {
  it('Clipping 类型与结束插槽 / 反向 / 凸形写入后能读回', () => {
    const doc = createEmptyDocument('mask-test')
    doc.bones.push({
      name: 'root',
      parent: '',
      localPosition: { x: 0, y: 0 },
      rotation: 0,
      localScale: { x: 1, y: 1 },
      localShear: { x: 0, y: 0 },
      inheritRotation: true,
      inheritScale: true,
      length: 10,
      color: '#F97316',
      locked: false
    })
    doc.slots.push(
      createAuthoringSlot({ name: 'mask', bone: 'root', zOrder: 0, attachment: 'mask' }),
      createAuthoringSlot({ name: 'body', bone: 'root', zOrder: 1, attachment: 'body' })
    )
    doc.skins[0]!.slots.push(
      {
        slot: 'mask',
        attachments: [
          createAuthoringAttachment({
            name: 'mask',
            type: 'clipping',
            vertices: [
              { x: -50, y: -50, weights: [] },
              { x: 50, y: -50, weights: [] },
              { x: 50, y: 50, weights: [] },
              { x: -50, y: 50, weights: [] }
            ],
            hull: 4,
            clipEndSlot: 'body',
            clipInverse: true,
            clipConvex: true
          })
        ]
      },
      {
        slot: 'body',
        attachments: [
          createAuthoringAttachment({
            name: 'body',
            type: 'region',
            size: { x: 100, y: 100 },
            uvs: [0, 0, 1, 0, 1, 1, 0, 1]
          })
        ]
      }
    )

    const { asset } = compileDocument(doc)
    const bytes = writeHao2d(asset)
    const restored = readHao2d(bytes).asset
    const attachment = restored.skins[0]!.slots
      .find((slot) => slot.slotName === 'mask')!
      .attachments.find((item) => item.name === 'mask')!

    expect(viewVersion(bytes)).toBe(HAO2D_VERSION)
    expect(attachment.type).toBe(AttachmentType.Clipping)
    expect(attachment.clipEndSlot).toBe('body')
    expect(attachment.clipInverse).toBe(true)
    expect(attachment.clipConvex).toBe(true)
    expect(Array.from(attachment.vertices)).toEqual([-50, -50, 50, -50, 50, 50, -50, 50])
  })
})

function viewVersion(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true)
}
