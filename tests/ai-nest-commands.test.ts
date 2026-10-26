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
import { catalog, clearRegistry, executeCommand } from '@editor/commands/registry'
import { useProjectStore } from '@editor/store/projectStore'

/** 父骨架：一个插槽 weapon；`nest` 为真时挂一个引用 Sword 的嵌套 display */
function parentDoc(nest: boolean): EditorDocument {
  const doc = createEmptyDocument('Hero')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [createAuthoringSlot({ name: 'weapon', bone: 'root', attachment: nest ? 'Sword' : '' })]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'weapon',
          attachments: nest
            ? [
                createAuthoringAttachment({
                  name: 'Sword',
                  type: 'armature',
                  subArmature: 'Sword',
                  subAnimation: 'idle'
                })
              ]
            : [createAuthoringAttachment({ name: 'knife', type: 'region', image: 'knife.png' })]
        }
      ]
    }
  ]
  const animation = createAuthoringAnim('attack', 1)
  doc.animations = [animation]
  return doc
}

function childDoc(): EditorDocument {
  const doc = createEmptyDocument('Sword')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [createAuthoringSlot({ name: 'blade', bone: 'root' })]
  doc.animations = [createAuthoringAnim('slash', 0.5), createAuthoringAnim('idle', 0.5)]
  return doc
}

beforeEach(() => {
  clearRegistry()
  installCommands()
  useProjectStore.getState().setProject([parentDoc(true), childDoc()], 0, null, false)
})

describe('AI 命令：骨架嵌套', () => {
  it('命令目录里有嵌套与子骨架动画命令', () => {
    const names = catalog().map((spec) => spec.name)
    expect(names).toContain('nestArmature')
    expect(names).toContain('setNestedArmature')
    expect(names).toContain('keySlotSubArmatureFrame')
  })

  it('nestArmature：把工程内另一个骨架挂到插槽上，listDisplays 能看到 nested', async () => {
    useProjectStore.getState().setProject([parentDoc(false), childDoc()], 0, null, false)
    const result = await executeCommand('nestArmature', { slot: 'weapon', armature: 'Sword' })
    expect(result.ok).toBe(true)
    const displays = await executeCommand('listDisplays', { slot: 'weapon', skin: 'default' })
    expect(displays.ok).toBe(true)
    const list = (displays.data as { displays: Array<Record<string, unknown>> }).displays
    expect(list.some((item) => item.type === 'armature' && (item.nested as { armature: string }).armature === 'Sword')).toBe(true)
  })

  it('nestArmature 拒绝自引用', async () => {
    const result = await executeCommand('nestArmature', { slot: 'weapon', armature: 'Hero' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('自己')
  })

  it('setNestedArmature：改引用骨架与默认播放参数', async () => {
    const result = await executeCommand('setNestedArmature', {
      slot: 'weapon',
      attachment: 'Sword',
      animation: 'slash',
      playTimes: 2,
      offset: 0.1,
      speed: 1.5
    })
    expect(result.ok).toBe(true)
    const attachment = useProjectStore.getState().document.skins[0].slots[0].attachments[0]
    expect(attachment.subAnimation).toBe('slash')
    expect(attachment.subPlayTimes).toBe(2)
    expect(attachment.subOffset).toBeCloseTo(0.1)
    expect(attachment.subSpeed).toBe(1.5)
  })

  it('setNestedArmature 对普通图片附件报错', async () => {
    useProjectStore.getState().setProject([parentDoc(false), childDoc()], 0, null, false)
    const result = await executeCommand('setNestedArmature', {
      slot: 'weapon',
      attachment: 'knife',
      animation: 'slash'
    })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('不是嵌套骨架')
  })

  it('keySlotSubArmatureFrame：写帧、读回、挪帧、改缓动、清轨道', async () => {
    const keyed = await executeCommand('keySlotSubArmatureFrame', {
      animation: 'attack',
      slot: 'weapon',
      time: 0.2,
      clip: 'slash',
      playTimes: 0,
      offset: 0.1,
      speed: 2
    })
    expect(keyed.ok).toBe(true)

    const read = await executeCommand('getAnimationKeys', { animation: 'attack', slot: 'weapon' })
    expect(read.ok).toBe(true)
    const slots = (read.data as { slots: Array<{ subArmature: Array<Record<string, unknown>> }> }).slots
    expect(slots[0].subArmature).toHaveLength(1)
    expect(slots[0].subArmature[0].clip).toBe('slash')
    expect(slots[0].subArmature[0].speed).toBe(2)

    const moved = await executeCommand('moveKeyframe', {
      animation: 'attack',
      kind: 'slot',
      target: 'weapon',
      channel: 'subArmature',
      from: 0.2,
      to: 0.5
    })
    expect(moved.ok).toBe(true)

    const easing = await executeCommand('setKeyframeEasing', {
      animation: 'attack',
      kind: 'slot',
      target: 'weapon',
      channel: 'subArmature',
      time: 0.5,
      easing: 'stepped'
    })
    expect(easing.ok).toBe(true)

    const cleared = await executeCommand('clearTrack', {
      animation: 'attack',
      kind: 'slot',
      target: 'weapon',
      channel: 'subArmature',
      time: 0.5
    })
    expect(cleared.ok).toBe(true)
    const track = useProjectStore.getState().document.animations[0].slots.find((item) => item.slot === 'weapon')
    expect(track?.subArmature ?? []).toHaveLength(0)
  })

  it('插槽没有嵌套骨架时打子骨架帧会报错', async () => {
    useProjectStore.getState().setProject([parentDoc(false), childDoc()], 0, null, false)
    const result = await executeCommand('keySlotSubArmatureFrame', {
      animation: 'attack',
      slot: 'weapon',
      time: 0,
      clip: 'slash'
    })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('没有嵌套骨架')
  })
})
