import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { installCommands } from '@editor/commands'
import { clearRegistry, executeCommand } from '@editor/commands/registry'
import { useProjectStore } from '@editor/store/projectStore'

function maskDoc(): EditorDocument {
  const doc = createEmptyDocument('mask-commands')
  doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
  doc.slots = [
    createAuthoringSlot({ name: 'mask', bone: 'root', zOrder: 0 }),
    createAuthoringSlot({ name: 'body', bone: 'root', zOrder: 1, attachment: 'body' }),
    createAuthoringSlot({ name: 'after', bone: 'root', zOrder: 2 })
  ]
  doc.skins = [
    {
      name: 'default',
      slots: [
        { slot: 'mask', attachments: [] },
        {
          slot: 'body',
          attachments: [
            createAuthoringAttachment({
              name: 'body',
              type: 'region',
              image: 'body.png',
              size: { x: 2, y: 2 },
              uvs: [0, 0, 1, 0, 1, 1, 0, 1]
            })
          ]
        },
        { slot: 'after', attachments: [] }
      ]
    }
  ]
  doc.animations = [createAuthoringAnim('sway')]
  return doc
}

function currentDoc(): EditorDocument {
  return useProjectStore.getState().document
}

function attach(slot: string, name: string) {
  return currentDoc().skins[0]!.slots
    .find((item) => item.slot === slot)!
    .attachments.find((item) => item.name === name)!
}

const POINTS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 }
]

beforeEach(() => {
  clearRegistry()
  installCommands()
  useProjectStore.getState().setDocument(maskDoc(), null, false)
})

describe('AI 遮罩命令', () => {
  it('createMask / getMask / listMasks', async () => {
    const created = await executeCommand('createMask', { slot: 'mask', points: POINTS, endSlot: 'body' })
    expect(created.ok).toBe(true)
    const data = created.data as { attachment: string; pointCount: number; endSlot: string }
    expect(data.attachment).toBe('mask')
    expect(data.pointCount).toBe(4)
    expect(data.endSlot).toBe('body')
    expect(attach('mask', 'mask').type).toBe('clipping')
    expect(currentDoc().slots.find((item) => item.name === 'mask')!.attachment).toBe('mask')

    const got = await executeCommand('getMask', { slot: 'mask', attachment: 'mask' })
    expect(got.ok).toBe(true)
    expect((got.data as { points: unknown[] }).points).toHaveLength(4)

    const list = await executeCommand('listMasks')
    expect((list.data as { masks: unknown[] }).masks).toHaveLength(1)
  })

  it('setMaskOptions / setMaskPoint / insert / delete', async () => {
    await executeCommand('createMask', { slot: 'mask', points: POINTS })
    const options = await executeCommand('setMaskOptions', {
      slot: 'mask',
      attachment: 'mask',
      inverse: true,
      endSlot: 'after'
    })
    expect(options.ok).toBe(true)
    expect(attach('mask', 'mask').clipInverse).toBe(true)
    expect(attach('mask', 'mask').clipConvex).toBe(true)

    const moved = await executeCommand('setMaskPoint', {
      slot: 'mask',
      attachment: 'mask',
      index: 0,
      point: { x: -2, y: -2 }
    })
    expect(moved.ok).toBe(true)
    expect(attach('mask', 'mask').vertices[0]).toMatchObject({ x: -2, y: -2 })

    const inserted = await executeCommand('insertMaskPoint', {
      slot: 'mask',
      attachment: 'mask',
      index: 0,
      point: { x: 0, y: -2 }
    })
    expect(inserted.ok).toBe(true)
    expect(attach('mask', 'mask').vertices).toHaveLength(5)

    const deleted = await executeCommand('deleteMaskPoint', {
      slot: 'mask',
      attachment: 'mask',
      index: 0
    })
    expect(deleted.ok).toBe(true)
    expect(attach('mask', 'mask').vertices).toHaveLength(4)
  })

  it('convertToMask 保留名字并允许设置选项', async () => {
    const result = await executeCommand('convertToMask', {
      slot: 'body',
      attachment: 'body',
      endSlot: 'after'
    })
    expect(result.ok).toBe(true)
    const converted = attach('body', 'body')
    expect(converted.type).toBe('clipping')
    expect(converted.clipEndSlot).toBe('after')
    expect(converted.vertices).toHaveLength(4)
  })

  it('遮罩可以直接打 FFD 帧', async () => {
    const created = await executeCommand('createMask', { slot: 'mask', points: POINTS })
    const attachment = (created.data as { attachment: string }).attachment
    const keyed = await executeCommand('keyDeformFrame', {
      animation: 'sway',
      slot: 'mask',
      attachment,
      time: 0,
      offsets: [0.2, 0, 0, 0, 0, 0, 0, 0]
    })
    expect(keyed.ok).toBe(true)
    const track = currentDoc().animations[0]!.deforms[0]!
    expect(track.attachment).toBe('mask')
    expect(track.frames[0]!.offsets[0]).toBeCloseTo(0.2, 5)
  })

  it('点数不足 / 结束时插槽非法会报错且不改文档', async () => {
    const tooFew = await executeCommand('createMask', {
      slot: 'mask',
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }]
    })
    expect(tooFew.ok).toBe(false)

    const badEnd = await executeCommand('createMask', {
      slot: 'mask',
      points: POINTS,
      endSlot: 'missing'
    })
    expect(badEnd.ok).toBe(false)
    expect(attach('mask', 'mask')).toBeUndefined()
  })
})
