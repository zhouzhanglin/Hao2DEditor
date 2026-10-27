import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthoringAttachment, createAuthoringSlot, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { useProjectStore } from '@editor/store/projectStore'

/** 造一个带一张图片 + 一个 region 附件的骨架（附件按名字引用图片） */
function docWithImage(armature: string, image: { name: string; path: string }): EditorDocument {
  const document = createEmptyDocument(armature)
  document.images = [{ name: image.name, path: image.path, width: 10, height: 10, loose: false }]
  document.slots.push(createAuthoringSlot({ name: 'body', bone: '' }))
  document.skins[0].slots.push({
    slot: 'body',
    attachments: [createAuthoringAttachment({ name: 'body', image: image.name })]
  })
  return document
}

beforeEach(() => {
  useProjectStore.getState().reset()
})

describe('appendSkeletons：把导入的骨架并入当前工程', () => {
  it('追加到骨架列表末尾并切过去，项目名 / 保存路径不动', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'hero.png', path: '/a/hero.png' }), null, false)
    store.setProjectInfo({ projectName: '我的工程', projectPath: '/tmp/a.hao2d.proj' })

    const at = useProjectStore.getState().appendSkeletons([docWithImage('Sword', { name: 'sword.png', path: '/b/sword.png' })])
    const after = useProjectStore.getState()

    expect(at).toBe(1)
    expect(after.skeletons).toHaveLength(2)
    expect(after.activeSkeleton).toBe(1)
    expect(after.document).toBe(after.skeletons[1])
    expect(after.document.armatureName).toBe('Sword')
    expect(after.projectName).toBe('我的工程')
    expect(after.projectPath).toBe('/tmp/a.hao2d.proj')
    expect(after.dirty).toBe(true)
  })

  it('图片池合并后由所有骨架共享', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'hero.png', path: '/a/hero.png' }), null, false)
    useProjectStore
      .getState()
      .appendSkeletons([docWithImage('Sword', { name: 'sword.png', path: '/b/sword.png' })])

    const after = useProjectStore.getState()
    const names = after.document.images.map((image) => image.name)
    expect(names).toEqual(['hero.png', 'sword.png'])
    // 同一份池子：切回旧骨架也能看到新导入的图
    expect(after.skeletons[0].images).toBe(after.skeletons[1].images)
  })

  it('同名不同文件的图片自动改名，并改写新骨架里的引用', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'atlas.png', path: '/a/atlas.png' }), null, false)
    useProjectStore
      .getState()
      .appendSkeletons([docWithImage('Sword', { name: 'atlas.png', path: '/b/atlas.png' })])

    const after = useProjectStore.getState()
    const names = after.document.images.map((image) => image.name)
    expect(names).toEqual(['atlas.png', 'atlas_2.png'])
    // 新骨架指向改名后的图，老骨架仍指向自己的那张
    expect(after.skeletons[1].skins[0].slots[0].attachments[0].image).toBe('atlas_2.png')
    expect(after.skeletons[0].skins[0].slots[0].attachments[0].image).toBe('atlas.png')
    expect(after.document.images.find((image) => image.name === 'atlas_2.png')?.path).toBe('/b/atlas.png')
    // 改名不是静默的：要有一条提示报到状态栏
    expect(after.warnings.some((item) => item.includes('atlas_2.png'))).toBe(true)
  })

  it('同名同路径 = 同一张图：复用且不重复入池', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'shared.png', path: '/a/shared.png' }), null, false)
    useProjectStore
      .getState()
      .appendSkeletons([docWithImage('Sword', { name: 'shared.png', path: '/a/shared.png' })])

    const after = useProjectStore.getState()
    expect(after.document.images).toHaveLength(1)
    expect(after.document.skins[0].slots[0].attachments[0].image).toBe('shared.png')
  })

  it('可以整步撤销（骨架与图片池一起回滚）', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'hero.png', path: '/a/hero.png' }), null, false)
    useProjectStore
      .getState()
      .appendSkeletons([docWithImage('Sword', { name: 'sword.png', path: '/b/sword.png' })])
    expect(useProjectStore.getState().skeletons).toHaveLength(2)

    useProjectStore.getState().undo()

    const after = useProjectStore.getState()
    expect(after.skeletons).toHaveLength(1)
    expect(after.document.armatureName).toBe('Hero')
    expect(after.document.images.map((image) => image.name)).toEqual(['hero.png'])
  })

  it('骨架重名自动加后缀，并把同批骨架里的嵌套引用改指过去', () => {
    useProjectStore
      .getState()
      .setDocument(docWithImage('Hero', { name: 'hero.png', path: '/a/hero.png' }), null, false)

    const incoming = docWithImage('Hero', { name: 'other.png', path: '/b/other.png' })
    // 再补一个引用它的骨架（模拟 DragonBones 一份 JSON 里多个 armature 互相引用）
    const child = createEmptyDocument('Child')
    child.slots.push(createAuthoringSlot({ name: 'weapon', bone: '' }))
    child.skins[0].slots.push({
      slot: 'weapon',
      attachments: [
        createAuthoringAttachment({ name: 'sword', type: 'armature', subArmature: 'Hero' })
      ]
    })

    useProjectStore.getState().appendSkeletons([incoming, child])

    const after = useProjectStore.getState()
    expect(after.skeletons.map((item) => item.armatureName)).toEqual(['Hero', 'Hero_2', 'Child'])
    expect(after.skeletons[2].skins[0].slots[0].attachments[0].subArmature).toBe('Hero_2')
    // 自动改名要有提示（否则用户不知道工程里多了一个 Hero_2）
    expect(after.warnings.some((item) => item.includes('Hero_2'))).toBe(true)
  })

  it('空数组什么都不做', () => {
    const store = useProjectStore.getState()
    store.setDocument(docWithImage('Hero', { name: 'hero.png', path: '/a/hero.png' }), null, false)
    const at = useProjectStore.getState().appendSkeletons([])
    expect(at).toBe(0)
    expect(useProjectStore.getState().skeletons).toHaveLength(1)
  })
})
