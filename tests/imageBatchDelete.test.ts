import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyDocument } from '@core/model/authoring'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { useProjectStore } from '@editor/store/projectStore'

function image(name: string): AuthoringImage {
  return { name, path: `/img/${name}`, width: 8, height: 8, loose: true }
}

function docWithImages(): EditorDocument {
  const doc = createEmptyDocument('hero')
  doc.images = [image('a.png'), image('b.png'), image('c.png')]
  return doc
}

const namesOf = (): string[] => useProjectStore.getState().document.images.map((item) => item.name)

describe('资源面板：图片批量删除', () => {
  beforeEach(() => {
    useProjectStore.getState().setDocument(docWithImages(), null, false)
  })

  it('一次删除多张只留一条撤销记录，撤销一次全部回来', () => {
    useProjectStore.getState().removeImages(['a.png', 'c.png'])
    expect(namesOf()).toEqual(['b.png'])

    useProjectStore.getState().undo()
    expect(namesOf()).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('不存在的名字被忽略；一个都不存在时不动文档（也不压历史）', () => {
    const before = useProjectStore.getState().document
    useProjectStore.getState().removeImages(['ghost.png'])
    expect(useProjectStore.getState().document).toBe(before)

    useProjectStore.getState().removeImages(['a.png', 'ghost.png'])
    expect(namesOf()).toEqual(['b.png', 'c.png'])
  })

  it('单张删除仍走同一入口，语义不变', () => {
    useProjectStore.getState().removeImage('b.png')
    expect(namesOf()).toEqual(['a.png', 'c.png'])
    useProjectStore.getState().undo()
    expect(namesOf()).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('删除图片会同时清掉附件对它的引用（附件保留、贴图退化为纯色）', () => {
    const store = useProjectStore.getState()
    store.update('造一个引用 a.png 的插槽', (draft) => {
      draft.slots.push({ name: 'body', bone: draft.bones[0]?.name ?? 'root', color: '#FFFFFFFF', visible: true, zOrder: 0 } as never)
      draft.skins[0].slots.push({
        slot: 'body',
        attachments: [
          {
            name: 'body',
            type: 'region',
            image: 'a.png',
            position: { x: 0, y: 0 },
            rotation: 0,
            scale: { x: 1, y: 1 },
            color: '#FFFFFFFF',
            size: { x: 1, y: 1 },
            vertices: [],
            uvs: [],
            triangles: [],
            edges: [],
            hull: 0,
            weights: [],
            bones: [],
            ffdInBoneSpace: false,
            linkedMeshSkin: '',
            linkedMeshAttachment: '',
            contentOffset: { x: 0, y: 0 },
            clipEndSlot: '',
            clipInverse: false,
            clipConvex: false,
            subArmature: '',
            subAnimation: '',
            subPlayTimes: 0
          } as never
        ]
      })
    })

    useProjectStore.getState().removeImages(['a.png'])
    const attachment = useProjectStore.getState().document.skins[0].slots.find((slot) => slot.slot === 'body')
      ?.attachments[0]
    // 附件还在，贴图引用被清空（视口里退化成纯色块）
    expect(attachment?.name).toBe('body')
    expect(attachment?.image).toBe('')
  })
})
