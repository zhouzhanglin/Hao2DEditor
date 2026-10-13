import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { installCommands } from '@editor/commands'
import { catalog, clearRegistry, executeCommand } from '@editor/commands/registry'
import { useProjectStore } from '@editor/store/projectStore'

/** 三插槽工程：a / b / c（zOrder 0/1/2，绘制顺序 a → b → c） */
function threeSlotDoc(): EditorDocument {
  const doc = createEmptyDocument('t')
  doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
  doc.slots = ['a', 'b', 'c'].map((name, index) =>
    createAuthoringSlot({ name, bone: 'root', attachment: `${name}_art`, zOrder: index })
  )
  doc.skins = [
    {
      name: 'default',
      slots: ['a', 'b', 'c'].map((name) => ({
        slot: name,
        attachments: [
          {
            ...createAuthoringAttachment({ name: `${name}_art`, type: 'region', image: `${name}.png` }),
            size: { x: 1, y: 1 }
          }
        ]
      }))
    }
  ]
  doc.images = ['a', 'b', 'c'].map<AuthoringImage>((name) => ({
    name: `${name}.png`,
    path: `/art/${name}.png`,
    width: 64,
    height: 64,
    loose: true
  }))
  doc.animations = [createAuthoringAnim('idle')]
  return doc
}

/** 当前绘制顺序：第 0 个最先画（最底层） */
function drawOrder(doc: EditorDocument): string[] {
  return [...doc.slots].sort((a, b) => a.zOrder - b.zOrder).map((slot) => slot.name)
}

function boneNames(): string[] {
  return useProjectStore.getState().document.bones.map((bone) => bone.name)
}

beforeEach(() => {
  clearRegistry()
  installCommands()
  // setDocument 会清撤销栈：每个用例从干净的三插槽工程起步
  useProjectStore.getState().setDocument(threeSlotDoc(), null, false)
})

describe('命令注册表', () => {
  it('安装后目录自描述完整、名字唯一', () => {
    const commands = catalog()
    const names = commands.map((spec) => spec.name)
    expect(commands.length).toBeGreaterThan(60)
    expect(new Set(names).size).toBe(names.length)
    for (const spec of commands) {
      expect(spec.title).not.toBe('')
      expect(spec.description).not.toBe('')
      expect(['read', 'write']).toContain(spec.kind)
    }
    for (const name of ['addBone', 'listBones', 'convertToMesh', 'setDrawOrder', 'keyBoneFrame']) {
      expect(names).toContain(name)
    }
  })

  it('未知命令给出候选与查目录的提示', () => {
    const result = executeCommand('addbon', {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有这个命令')
  })
})

describe('写命令：校验、撤销记录、事务', () => {
  it('参数不合法：ok=false 且文档原样不动', () => {
    const before = useProjectStore.getState().document
    const result = executeCommand('setBoneTransform', {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('bone')
    expect(useProjectStore.getState().document).toBe(before)
  })

  it('失败的命令不占撤销记录', () => {
    executeCommand('setBoneTransform', {})
    executeCommand('renameNode', { name: 'root', nextName: 'root2' })
    expect(executeCommand('addBone', { name: 'arm' }).ok).toBe(true)
    expect(boneNames()).toContain('arm')

    // 撤销一次就应撤掉 addBone（前面的失败没有留下记录）
    useProjectStore.getState().undo()
    expect(boneNames()).not.toContain('arm')
  })

  it('事务把一批命令合并成一条撤销记录', () => {
    expect(executeCommand('beginTransaction', {}).ok).toBe(true)
    expect(executeCommand('addBone', { name: 'arm' }).ok).toBe(true)
    expect(executeCommand('addBone', { name: 'hand', parent: 'arm' }).ok).toBe(true)
    expect(executeCommand('endTransaction', {}).ok).toBe(true)
    expect(boneNames()).toEqual(['root', 'arm', 'hand'])

    useProjectStore.getState().undo()
    expect(boneNames()).toEqual(['root'])
  })

  it('rollbackTransaction 把文档整体还原', () => {
    executeCommand('beginTransaction', {})
    executeCommand('addBone', { name: 'arm' })
    executeCommand('addBone', { name: 'hand', parent: 'arm' })
    expect(executeCommand('rollbackTransaction', {}).ok).toBe(true)
    expect(boneNames()).toEqual(['root'])
  })
})

describe('层级与顺序命令', () => {
  it('setDrawOrder 按「先画的在前」重排', () => {
    const result = executeCommand('setDrawOrder', { order: ['c', 'b', 'a'] })
    expect(result.ok).toBe(true)
    expect(drawOrder(useProjectStore.getState().document)).toEqual(['c', 'b', 'a'])
  })

  it('setDrawOrder 必须给全插槽名', () => {
    const result = executeCommand('setDrawOrder', { order: ['a', 'b'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('c')
    expect(drawOrder(useProjectStore.getState().document)).toEqual(['a', 'b', 'c'])
  })

  it('renameNode 骨骼改名会级联更新宿主引用', () => {
    const result = executeCommand('renameNode', { kind: 'bone', name: 'root', nextName: 'spine' })
    expect(result.ok).toBe(true)
    const doc = useProjectStore.getState().document
    expect(doc.bones[0]!.name).toBe('spine')
    for (const slot of doc.slots) expect(slot.bone).toBe('spine')
  })
})
