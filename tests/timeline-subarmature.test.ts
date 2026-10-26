import { describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { keySlotDisplay, keySlotSubArmature, pruneEmptyTracks } from '@editor/commands/animationCommands'
import {
  buildTimeline,
  deleteKeys,
  findKeyframe,
  moveKeys,
  pasteKeyframes,
  revealTrackFor
} from '@editor/timeline/model'
import type { KeySelector } from '@editor/timeline/model'

function docWithNest(): { doc: EditorDocument; animation: string } {
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
            createAuthoringAttachment({ name: 'Sword', type: 'armature', subArmature: 'Sword' })
          ]
        }
      ]
    }
  ]
  const animation = createAuthoringAnim('attack', 2)
  doc.animations = [animation]
  return { doc, animation: animation.name }
}

const selector = (time: number): KeySelector => ({
  kind: 'slot',
  target: 'weapon',
  attachment: '',
  channel: 'subArmature',
  time
})

describe('「子骨架」时间轴通道', () => {
  it('挂嵌套骨架的插槽即使没帧也显示该通道', () => {
    const { doc } = docWithNest()
    const tracks = buildTimeline(doc.animations[0], new Set(['weapon']))
    const track = tracks.find((item) => item.kind === 'slot' && item.channel === 'subArmature')
    expect(track).toBeDefined()
    expect(track?.keys).toHaveLength(0)
    // 不传集合时退化为「有帧才显示」
    expect(buildTimeline(doc.animations[0]).some((item) => item.channel === 'subArmature')).toBe(false)
  })

  it('打帧 / 读回 / 覆盖同一时间点', () => {
    const { doc, animation } = docWithNest()
    keySlotSubArmature(doc.animations[0], 'weapon', 0.5, {
      animation: 'slash',
      playTimes: 0,
      offset: 0,
      speed: 1
    })
    keySlotSubArmature(doc.animations[0], 'weapon', 0.5, {
      animation: 'idle',
      playTimes: 3,
      offset: 0.25,
      speed: 2
    })
    const frame = findKeyframe(doc.animations[0], selector(0.5))
    expect(frame?.animation).toBe('idle')
    expect(frame?.playTimes).toBe(3)
    expect(frame?.offset).toBeCloseTo(0.25)
    expect(frame?.speed).toBe(2)
    expect(doc.animations[0].slots[0].subArmature).toHaveLength(1)
    void animation
  })

  it('拖动 / 删除 / 复制粘贴都走通用链路', () => {
    const { doc } = docWithNest()
    keySlotSubArmature(doc.animations[0], 'weapon', 0.2, {
      animation: 'slash',
      playTimes: 0,
      offset: 0,
      speed: 1
    })

    expect(moveKeys(doc, 'attack', [selector(0.2)], 0.3)).toBe(1)
    expect(findKeyframe(doc.animations[0], selector(0.5))?.animation).toBe('slash')

    const frame = findKeyframe(doc.animations[0], selector(0.5))
    expect(frame).not.toBeNull()
    expect(
      pasteKeyframes(doc, 'attack', [
        { selector: selector(0.5), frame: frame!, time: 1.2 }
      ])
    ).toBe(1)
    expect(findKeyframe(doc.animations[0], selector(1.2))?.animation).toBe('slash')

    expect(deleteKeys(doc, 'attack', [selector(0.5)])).toBe(1)
    expect(findKeyframe(doc.animations[0], selector(0.5))).toBeNull()
  })

  it('选中 display 时时间轴定位到「显示」通道行（不认名字也能命中）', () => {
    const { doc } = docWithNest()
    // DragonBones 老数据：display 帧只有下标、没有名字
    keySlotDisplay(doc.animations[0], 'weapon', 0, 1, '')
    const tracks = buildTimeline(doc.animations[0])

    const displayRow = revealTrackFor(
      { kind: 'attachment', bone: '', slot: 'weapon', attachment: 'Sword' },
      tracks
    )
    expect(displayRow?.id).toBe('slot:weapon:display')
    expect(displayRow?.channel).toBe('display')

    // 选插槽本身仍然定位到分组行
    expect(revealTrackFor({ kind: 'slot', bone: '', slot: 'weapon', attachment: '' }, tracks)?.isGroup).toBe(true)

    // 分组折叠（子行不在列表里）时退回分组行
    const collapsed = tracks.filter((track) => track.isGroup)
    expect(revealTrackFor({ kind: 'attachment', bone: '', slot: 'weapon', attachment: 'Sword' }, collapsed)?.isGroup).toBe(
      true
    )
  })

  it('骨骼与插槽同名时，选槽 / display 不会命中骨骼分组', () => {
    const doc = createEmptyDocument('Hero')
    // DragonBones 常见：骨骼 R-JIAN1 上挂着同名插槽 R-JIAN1
    doc.bones = [createAuthoringBone({ name: 'root' }), createAuthoringBone({ name: 'R-JIAN1', parent: 'root' })]
    doc.slots = [createAuthoringSlot({ name: 'R-JIAN1', bone: 'R-JIAN1', attachment: 'Sword' })]
    doc.skins = [
      {
        name: 'default',
        slots: [
          {
            slot: 'R-JIAN1',
            attachments: [createAuthoringAttachment({ name: 'Sword', type: 'armature', subArmature: 'Sword' })]
          }
        ]
      }
    ]
    const animation = createAuthoringAnim('attack', 1)
    // 骨骼要有真实关键帧才会生成骨骼分组行，才复现得出「同名先命中骨骼」
    animation.bones = [
      {
        bone: 'R-JIAN1',
        translate: [],
        rotate: [{ time: 0, value: 0, easing: 0, curve: null }],
        scale: [],
        shear: []
      }
    ]
    doc.animations = [animation]
    keySlotDisplay(animation, 'R-JIAN1', 0, 0, 'Sword')
    const tracks = buildTimeline(animation)

    const slotRow = revealTrackFor({ kind: 'slot', bone: '', slot: 'R-JIAN1', attachment: '' }, tracks)
    expect(slotRow?.kind).toBe('slot')
    expect(slotRow?.isGroup).toBe(true)

    const displayRow = revealTrackFor({ kind: 'attachment', bone: '', slot: 'R-JIAN1', attachment: 'Sword' }, tracks)
    expect(displayRow?.id).toBe('slot:R-JIAN1:display')

    // 选骨骼时仍要命中骨骼分组
    expect(
      revealTrackFor({ kind: 'bone', bone: 'R-JIAN1', slot: '', attachment: '' }, tracks)?.kind
    ).toBe('bone')
  })

  it('删掉最后一帧后整条插槽轨道被清理', () => {
    const { doc } = docWithNest()
    keySlotSubArmature(doc.animations[0], 'weapon', 0, {
      animation: 'slash',
      playTimes: 0,
      offset: 0,
      speed: 1
    })
    deleteKeys(doc, 'attack', [selector(0)])
    pruneEmptyTracks(doc.animations[0])
    expect(doc.animations[0].slots).toHaveLength(0)
  })
})
