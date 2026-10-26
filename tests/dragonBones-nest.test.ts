import { describe, expect, it } from 'vitest'
import { importDragonBoneProject } from '@importers/dragonBones'
import { AttachmentType } from '@core/model/types'
import type { DbJson } from '@importers/dragonBonesTypes'

/**
 * 最小可用的「父 + 子」DragonBones 数据：
 * - `Hero` 的 weapon 插槽挂了一个 `Sword` 骨架（setup 默认播 idle）；
 * - `Hero` 的 attack 动画在 0 帧指定子骨架播 slash（DB 的 frame.actions）。
 */
function fixture(): DbJson {
  return {
    frameRate: 24,
    armature: [
      {
        name: 'Hero',
        bone: [{ name: 'root' }, { name: 'hand', parent: 'root', transform: { x: 10 } }],
        slot: [{ name: 'weapon', parent: 'hand', displayIndex: 0 }],
        skin: [
          {
            name: '',
            slot: [
              {
                name: 'weapon',
                display: [{ type: 'armature', name: 'Sword', transform: { x: 5, y: 2 } }],
                actions: [{ gotoAndPlay: 'idle' }]
              }
            ]
          }
        ],
        animation: [
          {
            name: 'attack',
            duration: 10,
            slot: [{ name: 'weapon', frame: [{ duration: 10, actions: [{ gotoAndPlay: 'slash' }] }] }]
          }
        ]
      },
      {
        name: 'Sword',
        bone: [{ name: 'root' }],
        slot: [{ name: 'blade', parent: 'root' }],
        skin: [{ name: '', slot: [] }],
        animation: [{ name: 'slash', duration: 5 }, { name: 'idle', duration: 5 }]
      }
    ]
  }
}

const input = () => ({ json: fixture(), subTextures: [], pageSizes: {}, pageImages: {} })

describe('DragonBones 嵌套导入', () => {
  it('一个 armature = 一个骨架', () => {
    const result = importDragonBoneProject(input())
    expect(result.names).toEqual(['Hero', 'Sword'])
    expect(result.assets).toHaveLength(2)
    expect(result.assets[1].armatureName).toBe('Sword')
  })

  it('type:"armature" 的 display 变成嵌套附件（引用骨架名 + setup 默认动画）', () => {
    const hero = importDragonBoneProject(input()).assets[0]
    const weapon = hero.skins[0].slots.find((slot) => slot.slotName === 'weapon')
    const attachment = weapon?.attachments[0]
    expect(attachment?.type).toBe(AttachmentType.Armature)
    expect(attachment?.subArmature).toBe('Sword')
    expect(attachment?.subAnimation).toBe('idle')
    // DB 的 y-down → 编辑器 y-up：transform.y 取反
    expect(attachment?.position).toEqual({ x: 5 / 100, y: -2 / 100 })
  })

  it('slot 帧 actions 落成「子骨架」通道关键帧', () => {
    const hero = importDragonBoneProject(input()).assets[0]
    const attack = hero.animations.find((animation) => animation.name === 'attack')
    const track = attack?.slots.find((slot) => slot.slotIndex === 0)
    expect(track?.subArmature).toHaveLength(1)
    expect(track?.subArmature[0].animation).toBe('slash')
    expect(track?.subArmature[0].playTimes).toBe(0)
    expect(track?.subArmature[0].time).toBe(0)
  })

  it('重名 armature 自动加后缀，嵌套引用仍指向第一个', () => {
    const json = fixture()
    json.armature![1].name = 'Hero'
    // 父骨架的嵌套 display 也改成引用 'Hero'（DB 里按名字引用只能指到第一个）
    json.armature![0].skin![0].slot![0].display![0].name = 'Hero'
    const result = importDragonBoneProject({ ...input(), json })
    expect(result.names).toEqual(['Hero', 'Hero_2'])
    expect(result.warnings.some((warning) => warning.includes('重复'))).toBe(true)
    const attachment = result.assets[0].skins[0].slots[0].attachments[0]
    expect(attachment.subArmature).toBe('Hero')
  })

  it('引用了不存在的 armature 时保留 display 但留空并告警', () => {
    const json = fixture()
    json.armature![0].skin![0].slot![0].display![0].name = 'Missing'
    const result = importDragonBoneProject({ ...input(), json })
    const attachment = result.assets[0].skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe(AttachmentType.Armature)
    expect(attachment.subArmature).toBe('')
    expect(result.warnings.some((warning) => warning.includes('不存在'))).toBe(true)
  })
})
