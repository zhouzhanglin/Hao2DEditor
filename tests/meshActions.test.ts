import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyDocument } from '@core/model/authoring'
import type { AuthoringBone, EditorDocument } from '@core/model/authoring'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { createRegionFromImage, findAttachment } from '@editor/commands/authoringCommands'
import { buildGridMesh, buildOutlineMesh } from '@editor/commands/meshActions'

function bone(name: string): AuthoringBone {
  return {
    name,
    parent: '',
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 0.5,
    color: '#ffffff',
    locked: false
  }
}

/** 一个骨骼 + 一张 200×100 的图片（自动建成插槽，附件是 Region） */
function setupDoc(): EditorDocument {
  const doc = createEmptyDocument('t')
  doc.bones.push(bone('root'))
  createRegionFromImage(doc, { image: 'a.png', bone: 'root', width: 200, height: 100 })
  return doc
}

/** 把文档装进 store，并选中它的附件 */
function install(doc: EditorDocument): { slot: string; attachment: string } {
  useProjectStore.getState().setDocument(doc, null, false)
  const slot = doc.slots[0].name
  const attachment = doc.slots[0].attachment
  useSelectionStore.getState().selectAttachment(slot, attachment)
  return { slot, attachment }
}

describe('网格生成 / 重设（密度）', () => {
  beforeEach(() => {
    useModeStore.getState().setMode('pose')
    useSelectionStore.getState().clear()
  })

  it('Animate 态拒绝生成，并提示切到 Pose', () => {
    install(setupDoc())
    useModeStore.getState().setMode('animate')

    const result = buildGridMesh(4)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Pose')
  })

  it('没有选中附件时给出明确提示', () => {
    useProjectStore.getState().setDocument(setupDoc(), null, false)
    useSelectionStore.getState().clear()

    const result = buildGridMesh(4)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('选中')
  })

  it('按密度把 Region 转成规则网格：(N+1)² 顶点 / 2N² 三角面', () => {
    const doc = setupDoc()
    const { slot, attachment } = install(doc)

    const result = buildGridMesh(3)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('3×3')

    const mesh = findAttachment(useProjectStore.getState().document, slot, attachment)!
    expect(mesh.type).toBe('mesh')
    expect(mesh.vertices).toHaveLength(16) // (3+1)²
    expect(mesh.triangles).toHaveLength(2 * 3 * 3 * 3) // 2N² 个三角形 × 3 下标
    // 首次转换会留一份原 Region 快照，之后可以一键还原
    expect(mesh.regionSnapshot).toBeDefined()
  })

  it('已经是手工编辑过的网格（无快照）时，栅格生成给出替代指引', () => {
    const doc = setupDoc()
    const { slot, attachment } = install(doc)
    buildGridMesh(2)
    // 清掉快照 = 模拟「不是由图片转来的纯网格」
    useProjectStore.getState().update('t', (draft) => {
      const mesh = findAttachment(draft, slot, attachment)!
      delete mesh.regionSnapshot
    })

    const again = buildGridMesh(2)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('自动生成网格')
  })

  it('轮廓生成在没有视口时给出可读提示（不抛异常）', () => {
    install(setupDoc())

    const result = buildOutlineMesh(4)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('视口')
  })
})
