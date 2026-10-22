import { describe, expect, it } from 'vitest'
import {
  convertAttachmentToClipping,
  createClippingAttachment,
  deleteClippingPoint,
  insertClippingPoint,
  setClippingPoint,
  setClippingVertices
} from '@editor/commands/authoringCommands'
import {
  createAuthoringAttachment,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
function documentWithRegion() {
  const doc = createEmptyDocument('mask-authoring')
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
          type: 'region',
          image: 'body',
          size: { x: 100, y: 100 },
          uvs: [0, 0, 1, 0, 1, 1, 0, 1]
        })
      ]
    },
    {
      slot: 'body',
      attachments: [
        createAuthoringAttachment({
          name: 'body',
          type: 'region',
          image: 'body',
          size: { x: 100, y: 100 },
          uvs: [0, 0, 1, 0, 1, 1, 0, 1]
        })
      ]
    }
  )
  return doc
}

describe('遮罩编辑命令', () => {
  it('创建 / 改点 / 插入 / 删除', () => {
    const doc = createEmptyDocument('mask')
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
    doc.slots.push(createAuthoringSlot({ name: 'mask', bone: 'root', zOrder: 0 }))
    const created = createClippingAttachment(doc, 'mask', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ]
    })!
    expect(created.type).toBe('clipping')
    expect(doc.slots[0]!.attachment).toBe('mask')
    expect(setClippingPoint(doc, 'mask', 'mask', 0, { x: 1, y: 2 })).toBe(true)
    expect(created.vertices[0]).toEqual({ x: 1, y: 2, weights: [] })
    expect(insertClippingPoint(doc, 'mask', 'mask', 0, { x: 5, y: 5 })).toBe(true)
    expect(created.vertices).toHaveLength(4)
    expect(deleteClippingPoint(doc, 'mask', 'mask', 1)).toBe(true)
    expect(created.vertices).toHaveLength(3)
    expect(deleteClippingPoint(doc, 'mask', 'mask', 1)).toBe(false)
  })

  it('插入 / 删除控制点会清掉旧的 FFD 轨道，避免 offsets 错位', () => {
    const doc = createEmptyDocument('mask-ffd')
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
    doc.slots.push(createAuthoringSlot({ name: 'mask', bone: 'root', zOrder: 0 }))
    createClippingAttachment(doc, 'mask', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
    })
    doc.animations.push({
      name: 'sway',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [
        {
          slot: 'mask',
          attachment: 'mask',
          frames: [{ time: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0], vertexOffset: 0, easing: 0, curve: null }]
        }
      ],
      drawOrder: [],
      events: [],
      constraints: []
    })

    insertClippingPoint(doc, 'mask', 'mask', 0, { x: 5, y: 0 })
    expect(doc.animations[0]!.deforms).toHaveLength(0)

    // 再建一条，删除点也应清掉
    doc.animations[0]!.deforms.push({
      slot: 'mask',
      attachment: 'mask',
      frames: [{ time: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0], vertexOffset: 0, easing: 0, curve: null }]
    })
    deleteClippingPoint(doc, 'mask', 'mask', 0)
    expect(doc.animations[0]!.deforms).toHaveLength(0)
  })

  it('Region 转遮罩会保留名字并换算到骨骼空间', () => {
    const doc = documentWithRegion()
    expect(convertAttachmentToClipping(doc, 'mask', 'mask')).toBe(true)
    const attachment = doc.skins[0]!.slots[0]!.attachments[0]!
    expect(attachment.type).toBe('clipping')
    expect(attachment.name).toBe('mask')
    expect(attachment.position).toEqual({ x: 0, y: 0 })
    expect(attachment.vertices).toHaveLength(4)
    expect(attachment.vertices.map((point) => point.x).sort((a, b) => a - b)).toEqual([-50, -50, 50, 50])
    expect(
      setClippingVertices(doc, 'mask', 'mask', [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 }
      ])
    ).toBe(true)
  })
})
