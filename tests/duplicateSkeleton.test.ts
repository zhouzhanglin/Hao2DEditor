import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuthoringAnim, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { installCommands } from '@editor/commands'
import { executeCommand } from '@editor/commands/registry'
import { useProjectStore } from '@editor/store/projectStore'

/** 骨架复制：骨骼 / 皮肤 / 动画全部深拷贝，图片池共享，名字不撞车 */
function sourceDoc(): EditorDocument {
  const doc = createEmptyDocument('Hero')
  doc.bones.push({ name: 'arm', parent: 'root', length: 10, rotation: 0, x: 5, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inheritRotation: true, inheritScale: true })
  doc.slots.push({ name: 'weapon', bone: 'arm', attachment: 'knife', zOrder: 0, color: { r: 1, g: 1, b: 1, a: 1 } })
  doc.skins[0].slots.push({ slot: 'weapon', attachments: [{ type: 'region', name: 'knife', image: 'knife.png', width: 10, height: 10, position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }] })
  doc.animations.push(createAuthoringAnim('attack', 1))
  return doc
}

beforeAll(() => installCommands())

beforeEach(() => {
  useProjectStore.getState().setProject([sourceDoc()], 0, null, false)
})

describe('AI 命令：复制骨架', () => {
  it('默认复制当前骨架，返回副本下标 / 名字 / 总数 / 来源', async () => {
    const result = await executeCommand('duplicateSkeleton', {})
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.data).toMatchObject({ index: 1, name: 'Hero_2', count: 2, source: 'Hero' })

    const state = useProjectStore.getState()
    expect(state.skeletons).toHaveLength(2)
    expect(state.activeSkeleton).toBe(1)
    expect(state.document.animations.map((anim) => anim.name)).toEqual(['attack'])
  })

  it('下标越界折成 ok:false', async () => {
    const result = await executeCommand('duplicateSkeleton', { index: 99 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('下标越界')
    expect(useProjectStore.getState().skeletons).toHaveLength(1)
  })
})

describe('复制骨架', () => {
  it('复制骨骼 / 插槽 / 皮肤 / 动画，深拷贝且切到副本', () => {
    const result = useProjectStore.getState().duplicateSkeleton(0)
    const state = useProjectStore.getState()
    expect(result.ok).toBe(true)
    expect(state.skeletons).toHaveLength(2)
    expect(state.activeSkeleton).toBe(1)
    expect(state.document.armatureName).toBe('Hero_2')
    expect(state.document.bones.map((bone) => bone.name)).toEqual(['arm'])
    expect(state.document.slots.map((slot) => slot.name)).toEqual(['weapon'])
    expect(state.document.skins[0].slots[0].attachments[0].name).toBe('knife')
    expect(state.document.animations.map((anim) => anim.name)).toEqual(['attack'])

    // 深拷贝：改副本不要影响原骨架
    state.document.bones[0].length = 99
    state.document.animations[0].duration = 8
    expect(state.skeletons[0].bones[0].length).toBe(10)
    expect(state.skeletons[0].animations[0].duration).toBe(1)
  })

  it('重名时继续加后缀，图片池共享', () => {
    const second = sourceDoc()
    second.armatureName = 'Hero_2'
    useProjectStore.getState().setProject([sourceDoc(), second], 1, null, false)
    const pool = useProjectStore.getState().document.images
    const result = useProjectStore.getState().duplicateSkeleton(0)
    expect(result.ok).toBe(true)
    const state = useProjectStore.getState()
    expect(state.document.armatureName).toBe('Hero_3')
    expect(state.skeletons.every((skeleton) => skeleton.images === pool)).toBe(true)
  })

  it('标脏且可撤销：撤销一次回到复制前', () => {
    useProjectStore.getState().duplicateSkeleton(0)
    expect(useProjectStore.getState().dirty).toBe(true)
    useProjectStore.getState().undo()
    const state = useProjectStore.getState()
    expect(state.skeletons).toHaveLength(1)
    expect(state.skeletons[0].armatureName).toBe('Hero')
  })
})
