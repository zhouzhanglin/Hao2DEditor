import { describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import { keySlotDisplay, keySlotSubArmature } from '@editor/commands/animationCommands'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { cleanupEmptyTracks, deleteSelectedTrack, deleteTrack } from '@editor/timeline/actions'
import { buildTimeline } from '@editor/timeline/model'
import type { AuthoringAnimData } from '@core/model/authoring'

function docWithKeys(): void {
  const doc = createEmptyDocument('hero')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [createAuthoringSlot({ name: 'weapon', bone: 'root', attachment: 'sword' })]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'weapon',
          attachments: [
            createAuthoringAttachment({ name: 'sword', type: 'region' }),
            createAuthoringAttachment({ name: 'nest', type: 'armature', subArmature: 'knife' })
          ]
        }
      ]
    }
  ]
  const anim = createAuthoringAnim('walk', 1)
  keySlotDisplay(anim, 'weapon', 0, 1, 'nest')
  keySlotSubArmature(anim, 'weapon', 0, { animation: 'idle', playTimes: 0, offset: 0, speed: 1 })
  doc.animations = [anim]
  useProjectStore.getState().setDocument(doc, null, false)
  useTimelineStore.getState().setAnimation('walk')
}

describe('删除整条通道', () => {
  it('显示通道：关键帧带 display 名也能删掉', () => {
    docWithKeys()
    useTimelineStore.getState().setSelectedTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: 'display'
    })
    const result = deleteSelectedTrack()
    expect(result.ok).toBe(true)
    const track = useProjectStore.getState().document.animations[0].slots.find((s) => s.slot === 'weapon')
    expect(track?.displayIndex.length ?? 0).toBe(0)
  })

  it('行尾垃圾桶直接删该通道（不需要先选中）', () => {
    docWithKeys()
    const result = deleteTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: 'display',
      time: 0
    })
    expect(result.ok).toBe(true)
    const track = useProjectStore.getState().document.animations[0].slots.find((s) => s.slot === 'weapon')
    expect(track?.displayIndex.length ?? 0).toBe(0)
  })

  it('挂嵌套骨架但没打过帧的插槽：时间轴里不自动出现这一行', () => {
    // 用户反馈：只加了子骨架、一帧都没打，不该凭空多出 right-hand-item2 / Sub-armature 两行
    const doc = createEmptyDocument('hero')
    doc.bones = [createAuthoringBone({ name: 'root' })]
    doc.slots = [createAuthoringSlot({ name: 'right-hand-item2', bone: 'root' })]
    doc.skins = [
      {
        name: 'default',
        slots: [
          {
            slot: 'right-hand-item2',
            attachments: [createAuthoringAttachment({ name: 'nest', type: 'armature', subArmature: 'knife' })]
          }
        ]
      }
    ]
    doc.animations = [createAuthoringAnim('walk', 1)]
    useProjectStore.getState().setDocument(doc, null, false)
    useTimelineStore.getState().setAnimation('walk')

    expect(buildTimeline(useProjectStore.getState().document.animations[0])).toEqual([])
  })

  it('删掉一条通道的帧后，这一行随之消失（不留空行）', () => {
    docWithKeys()
    const anim = (): AuthoringAnimData => useProjectStore.getState().document.animations[0]
    expect(buildTimeline(anim()).some((track) => track.id === 'slot:weapon:display')).toBe(true)

    const result = deleteTrack({ kind: 'slot', target: 'weapon', attachment: '', channel: 'display', time: 0 })
    expect(result.ok).toBe(true)
    // 「显示」行不再常驻：帧没了行就没了
    expect(buildTimeline(anim()).some((track) => track.id === 'slot:weapon:display')).toBe(false)
    // 子骨架还有帧，分组行留着
    expect(buildTimeline(anim()).some((track) => track.id === 'slot:weapon')).toBe(true)
  })

  it('骨骼 / 插槽分组行删除整组通道', () => {
    docWithKeys()
    const result = deleteTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: '',
      time: 0
    })
    expect(result.ok).toBe(true)
    const track = useProjectStore.getState().document.animations[0].slots.find((s) => s.slot === 'weapon')
    expect(track).toBeUndefined()
  })

  it('子骨架通道也能删', () => {
    docWithKeys()
    useTimelineStore.getState().setSelectedTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: 'subArmature'
    })
    expect(deleteSelectedTrack().ok).toBe(true)
    const track = useProjectStore.getState().document.animations[0].slots.find((s) => s.slot === 'weapon')
    expect(track?.subArmature?.length ?? 0).toBe(0)
  })
})

describe('清理帧', () => {
  it('一键清掉没有关键帧的轨道条目，有帧的保留', () => {
    docWithKeys()
    const doc = useProjectStore.getState().document
    // 造两条 0 帧轨道：插槽一条、骨骼一条（导入 / 早期版本残留的形态）
    doc.animations[0].slots.push({
      slot: 'weapon2',
      color: [],
      displayIndex: [],
      displayAttachment: [],
      visible: [],
      subArmature: []
    })
    doc.animations[0].bones.push({ bone: 'helper', translate: [], rotate: [], scale: [], shear: [] })
    useProjectStore.getState().setDocument(doc, null, false)

    const result = cleanupEmptyTracks()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2')

    const anim = useProjectStore.getState().document.animations[0]
    expect(anim.slots.some((track) => track.slot === 'weapon2')).toBe(false)
    expect(anim.bones.some((track) => track.bone === 'helper')).toBe(false)
    // 有帧的插槽轨道原样保留
    expect(anim.slots.some((track) => track.slot === 'weapon')).toBe(true)
    // 清理后时间轴只剩有帧的行
    expect(buildTimeline(anim).every((track) => track.isGroup || track.keys.length > 0)).toBe(true)
  })

  it('没有空通道时只给提示', () => {
    docWithKeys()
    const result = cleanupEmptyTracks()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('没有空通道')
    expect(useProjectStore.getState().document.animations[0].slots).toHaveLength(1)
  })
})
