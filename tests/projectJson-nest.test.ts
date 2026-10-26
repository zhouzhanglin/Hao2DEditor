import { describe, expect, it } from 'vitest'
import { normalizeDocument, serializeDocument } from '@core/codec/projectJson'
import { CURRENT_SCHEMA_VERSION, createAuthoringAnim, createEmptyDocument } from '@core/model/authoring'
import { emptySubArmatureKeyframe } from '@core/model/animation'

describe('工程文件 v3：骨架嵌套', () => {
  it('嵌套附件与「子骨架」通道能完整往返', () => {
    const doc = createEmptyDocument('Hero')
    doc.skins = [
      {
        name: 'default',
        slots: [
          {
            slot: 'weapon',
            attachments: [
              {
                name: 'Sword',
                type: 'armature',
                image: '',
                position: { x: 0.1, y: 0.2 },
                rotation: 15,
                scale: { x: 1, y: 1 },
                size: { x: 0, y: 0 },
                frameSize: { x: 0, y: 0 },
                contentOffset: { x: 0, y: 0 },
                color: '#FFFFFFFF',
                vertices: [],
                uvs: [],
                triangles: [],
                edges: [],
                hull: 0,
                ffdInBoneSpace: false,
                linkedMeshSkin: '',
                linkedMeshAttachment: '',
                clipEndSlot: '',
                clipInverse: false,
                clipConvex: false,
                subArmature: 'Sword',
                subAnimation: 'idle',
                subPlayTimes: 2,
                subOffset: 0.3,
                subSpeed: 1.5
              }
            ]
          }
        ]
      }
    ]
    const animation = createAuthoringAnim('attack', 1)
    animation.slots = [
      {
        slot: 'weapon',
        color: [],
        displayIndex: [],
        displayAttachment: [],
        visible: [],
        subArmature: [emptySubArmatureKeyframe(0.5, 'slash', 0, 0.1, 2)]
      }
    ]
    doc.animations = [animation]

    const text = serializeDocument(doc)
    const parsed = normalizeDocument(JSON.parse(text))
    expect(parsed.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    const attachment = parsed.document.skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe('armature')
    expect(attachment.subArmature).toBe('Sword')
    expect(attachment.subAnimation).toBe('idle')
    expect(attachment.subPlayTimes).toBe(2)
    expect(attachment.subOffset).toBeCloseTo(0.3)
    expect(attachment.subSpeed).toBe(1.5)
    const frame = parsed.document.animations[0].slots[0].subArmature[0]
    expect(frame.animation).toBe('slash')
    expect(frame.speed).toBe(2)
  })

  it('老工程（v2，无新字段）读入后按默认值补齐', () => {
    const parsed = normalizeDocument({
      schemaVersion: 2,
      armatureName: 'old',
      slots: [],
      skins: [
        {
          name: 'default',
          slots: [
            {
              slot: 's',
              attachments: [{ name: 'a', type: 'region', subArmature: undefined }]
            }
          ]
        }
      ],
      animations: [{ name: 'idle', duration: 1, slots: [{ slot: 's' }] }]
    })
    const attachment = parsed.document.skins[0].slots[0].attachments[0]
    expect(attachment.subArmature).toBe('')
    expect(attachment.subPlayTimes).toBe(0)
    expect(attachment.subSpeed).toBe(1)
    expect(parsed.document.animations[0].slots[0].subArmature).toEqual([])
    expect(parsed.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})
