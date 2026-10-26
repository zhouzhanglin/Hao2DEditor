import { describe, expect, it } from 'vitest'
import { parseRuntimeSke, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import { collectHao2dWarnings } from '@core/codec/hao2dWriter'
import { buildSpineJson } from '@editor/services/spineExport'
import { compileDocument } from '@core/codec/compile'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import { emptySubArmatureKeyframe } from '@core/model/animation'
import type { EditorDocument } from '@core/model/authoring'

function heroDoc(): EditorDocument {
  const doc = createEmptyDocument('Hero')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [createAuthoringSlot({ name: 'weapon', bone: 'root', attachment: 'Sword' })]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'weapon',
          attachments: [
            createAuthoringAttachment({
              name: 'Sword',
              type: 'armature',
              subArmature: 'Sword',
              subAnimation: 'idle'
            })
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
      subArmature: [emptySubArmatureKeyframe(0, 'slash', 0, 0, 1)]
    }
  ]
  doc.animations = [animation]
  return doc
}

describe('运行时 ske v2', () => {
  it('写出版本 2 与 nested 清单，v1 文件仍可读', () => {
    const asset = compileDocument(heroDoc()).asset
    const text = serializeRuntimeSke(asset, {
      atlasFileName: 'hero_atlas.json',
      nested: [{ armatureName: 'Sword', file: 'Sword_ske.json' }]
    })
    const parsed = parseRuntimeSke(text)
    expect(parsed.version).toBe(2)
    expect(parsed.nested).toEqual([{ armatureName: 'Sword', file: 'Sword_ske.json' }])
    // 附件的嵌套字段与动画通道都要带上
    const attachment = (
      parsed.skins as Array<{ slots: Array<{ attachments: Array<Record<string, unknown>> }> }>
    )[0].slots[0].attachments[0]
    expect(attachment.subArmature).toBe('Sword')
    expect(attachment.subAnimation).toBe('idle')
  })

  it('v1 老文件读成空 nested', () => {
    const legacy = JSON.stringify({
      format: 'hao2d-ske',
      version: 1,
      armatureName: 'old',
      frameRate: 30,
      ppu: 100,
      atlas: 'a.json',
      dataType: 1,
      textureNames: [],
      bones: [],
      slots: [],
      skins: [],
      constraints: [],
      animations: [],
      bindposes: []
    })
    expect(parseRuntimeSke(legacy).nested).toEqual([])
  })
})

describe('不支持嵌套的格式：跳过并告警', () => {
  it('.hao2d 导出告警里点名嵌套骨架', () => {
    const asset = compileDocument(heroDoc()).asset
    const warnings = collectHao2dWarnings(asset)
    expect(warnings.some((warning) => warning.includes('嵌套骨架'))).toBe(true)
  })

  it('Spine 导出的皮肤里不出现嵌套 display（不崩、不留空 region）', () => {
    const asset = compileDocument(heroDoc()).asset
    const spine = buildSpineJson(asset)
    const skins = (spine as unknown as { skins: Array<{ attachments: Record<string, Record<string, unknown>> }> })
      .skins
    const entries = Object.values(skins[0]?.attachments ?? {})
    for (const slotEntries of entries) {
      expect(Object.keys(slotEntries)).not.toContain('Sword')
    }
  })
})
