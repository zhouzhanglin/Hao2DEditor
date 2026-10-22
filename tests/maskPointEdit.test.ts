import { describe, expect, it } from 'vitest'
import { createAuthoringSlot, createEmptyDocument } from '@core/model/authoring'
import { createClippingAttachment } from '@editor/commands/authoringCommands'
import { deleteSelectedMaskPoint } from '@editor/tools/authoringTools'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { useToolStore } from '@editor/store/toolStore'
import type { EditorScene } from '@editor/scene'

function sceneWithMaskPoint(index: number) {
  let state = {
    maskPoint: { slot: 'mask', attachment: 'mask', index }
  } as unknown as EditorScene['state']
  const messages: string[] = []
  const scene = {
    get state() {
      return state
    },
    setViewState(patch: Partial<EditorScene['state']>) {
      state = { ...state, ...patch } as EditorScene['state']
    },
    setDocument() {},
    refresh() {}
  } as unknown as EditorScene
  return {
    scene,
    status: (text: string) => messages.push(text),
    messages,
    picked: () => state.maskPoint
  }
}

function setupProject() {
  const doc = createEmptyDocument('mask-point')
  doc.bones.push({
    name: 'root',
    parent: '',
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 20,
    color: '#F97316',
    locked: false
  })
  doc.slots.push(createAuthoringSlot({ name: 'mask', bone: 'root', zOrder: 0 }))
  createClippingAttachment(doc, 'mask', {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    ]
  })
  useProjectStore.setState({ document: doc })
  useSelectionStore.getState().selectAttachment('mask', 'mask')
  useModeStore.setState({ mode: 'pose' })
  useToolStore.setState({ tool: 'mask' })
  return doc
}

describe('遮罩控制点编辑', () => {
  it('Delete 删除当前选中的控制点，并清空选中下标', () => {
    const doc = setupProject()
    const h = sceneWithMaskPoint(1)
    expect(deleteSelectedMaskPoint(h.scene, h.status)).toBe(true)
    const updated = useProjectStore.getState().document
    expect(updated.skins[0]!.slots[0]!.attachments[0]!.vertices).toHaveLength(3)
    expect(h.picked()).toBeNull()
    expect(h.messages.at(-1)).toContain('已删除')
  })

  it('少于 3 个点时拒绝删除', () => {
    const doc = setupProject()
    const attachment = doc.skins[0]!.slots[0]!.attachments[0]!
    attachment.vertices.splice(3)
    const h = sceneWithMaskPoint(0)
    expect(deleteSelectedMaskPoint(h.scene, h.status)).toBe(true)
    expect(attachment.vertices).toHaveLength(3)
    expect(h.messages.at(-1)).toContain('至少保留 3 个')
  })

  it('选中了别的对象时，不删除隐藏的遮罩点', () => {
    setupProject()
    useSelectionStore.getState().selectBone('root')
    const h = sceneWithMaskPoint(0)
    expect(deleteSelectedMaskPoint(h.scene, h.status)).toBe(false)
    expect(h.picked()).toBeNull()
  })
})
