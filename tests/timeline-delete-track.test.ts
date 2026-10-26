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
import { deleteSelectedTrack, deleteTrack } from '@editor/timeline/actions'

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

  it('空入口行给出说明而不是「删除失败」', () => {
    docWithKeys()
    const result = deleteTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: 'subArmature',
      time: 0
    })
    expect(result.ok).toBe(true)
    const again = deleteTrack({
      kind: 'slot',
      target: 'weapon',
      attachment: '',
      channel: 'subArmature',
      time: 0
    })
    expect(again.ok).toBe(false)
    expect(again.message).toContain('常驻入口行')
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
