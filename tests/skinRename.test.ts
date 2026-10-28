import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthoringAnim, createAuthoringAttachment, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { installCommands } from '@editor/commands'
import { clearRegistry, executeCommand } from '@editor/commands/registry'
import { renameSkin } from '@editor/commands/authoringCommands'
import { useProjectStore } from '@editor/store/projectStore'

/** 默认皮肤 + goblin；goblin 里挂一条变形轨道与一条链接网格，都按皮肤名记录归属 */
function docWithSkins(): EditorDocument {
  const doc = createEmptyDocument('hero')
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'body',
          attachments: [createAuthoringAttachment({ name: 'body', type: 'region', image: 'body.png' })]
        }
      ]
    },
    {
      name: 'goblin',
      slots: [
        {
          slot: 'body',
          attachments: [
            {
              ...createAuthoringAttachment({ name: 'body', type: 'linkedmesh', image: 'goblin.png' }),
              linkedMeshSkin: 'goblin',
              linkedMeshAttachment: 'body'
            }
          ]
        }
      ]
    }
  ]
  const animation = createAuthoringAnim('idle', 1)
  animation.deforms.push({ slot: 'body', attachment: 'body', skin: 'goblin', frames: [] })
  doc.animations = [animation]
  doc.editorMeta.activeSkin = 'goblin'
  return doc
}

describe('皮肤改名', () => {
  beforeEach(() => {
    clearRegistry()
    installCommands()
    useProjectStore.getState().setDocument(docWithSkins(), null, false)
  })

  it('拒绝和已有皮肤重名（数据一个字节都不动）', () => {
    const doc = docWithSkins()
    const result = renameSkin(doc, 'goblin', 'default')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已有同名皮肤')
    expect(doc.skins.map((skin) => skin.name)).toEqual(['default', 'goblin'])
  })

  it('空名 / 默认皮肤改名都拒绝', () => {
    const doc = docWithSkins()
    expect(renameSkin(doc, 'goblin', '   ').ok).toBe(false)
    expect(renameSkin(doc, 'goblin', '   ').message).toContain('不能为空')
    const byDefault = renameSkin(doc, 'default', 'base')
    expect(byDefault.ok).toBe(false)
    expect(byDefault.message).toContain('默认皮肤')
    expect(doc.skins.map((skin) => skin.name)).toEqual(['default', 'goblin'])
  })

  it('改名后变形归属 / 链接网格源皮肤 / 当前皮肤一起跟随', () => {
    const doc = docWithSkins()
    const result = renameSkin(doc, 'goblin', 'orc')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('orc')

    expect(doc.skins.map((skin) => skin.name)).toEqual(['default', 'orc'])
    // 变形（FFD）轨道按皮肤名判定归属：不改会整个失效
    expect(doc.animations[0].deforms[0].skin).toBe('orc')
    // 链接网格的源皮肤也按名字记录
    expect(doc.skins[1].slots[0].attachments[0].linkedMeshSkin).toBe('orc')
    expect(doc.editorMeta.activeSkin).toBe('orc')
  })

  it('皮肤不存在时给明确提示', () => {
    const result = renameSkin(docWithSkins(), 'ghost', 'orc')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('皮肤不存在')
  })

  it('AI 命令 renameSkin 重名时报错，不写进文档', async () => {
    const result = await executeCommand('renameSkin', { name: 'goblin', newName: 'default' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('已有同名皮肤')
    expect(useProjectStore.getState().document.skins.map((skin) => skin.name)).toEqual(['default', 'goblin'])
  })

  it('AI 命令 renameSkin 成功后可以撤销', async () => {
    const result = await executeCommand('renameSkin', { name: 'goblin', newName: 'orc' })
    expect(result.ok).toBe(true)
    expect(useProjectStore.getState().document.skins.map((skin) => skin.name)).toEqual(['default', 'orc'])
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().document.skins.map((skin) => skin.name)).toEqual(['default', 'goblin'])
  })
})
