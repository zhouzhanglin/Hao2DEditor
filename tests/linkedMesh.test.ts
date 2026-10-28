import { describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { AuthoringAttachment, EditorDocument } from '@core/model/authoring'
import {
  createLinkedMesh,
  patchAttachmentInSkin,
  setLinkedMeshImage,
  setLinkedMeshSource,
  unlinkLinkedMesh
} from '@editor/commands/authoringCommands'
import { keyDeformFrame } from '@editor/commands/animOps'
import { attachmentSkinOf, linkedMeshUvs, resolveAuthoringLinkedMesh } from '@core/skin/linkedMesh'
import { compileDocument } from '@core/codec/compile'
import { buildRuntimeMaps } from '@core/model/asset'

/**
 * 链接网格（linkedmesh）：一套网格几何 + 多套皮肤换贴图。
 *
 * 这里锁的是三件事：
 * 1. 创建 / 改源 / 解链的行为（含同名覆盖与自动改名）
 * 2. UV 按「自己那块图集区域」重算（换图不画成源皮肤那块）
 * 3. FFD 的点数取源网格、轨道带皮肤归属（不串到同名源网格上）
 */

/** 四角网格：UV 按 hero/arm 区域（x0 y0 64×64 / 页 128×128）给出整页坐标 */
function quadMesh(name: string, image: string, regionName: string, uvs: number[]): AuthoringAttachment {
  return createAuthoringAttachment({
    name,
    type: 'mesh',
    image,
    regionName,
    vertices: [
      { x: -0.5, y: -0.5, weights: [] },
      { x: 0.5, y: -0.5, weights: [] },
      { x: 0.5, y: 0.5, weights: [] },
      { x: -0.5, y: 0.5, weights: [] }
    ],
    uvs,
    triangles: [0, 1, 2, 0, 2, 3],
    edges: [0, 1, 2, 3],
    hull: 4,
    size: { x: 1, y: 1 }
  })
}

/** default 皮肤里有一条网格 arm；goblin 皮肤是空皮肤（等着放链接网格） */
function setup(): EditorDocument {
  const doc = createEmptyDocument()
  doc.bones.push(createAuthoringBone({ name: 'root' }))
  doc.slots.push(createAuthoringSlot({ name: 'arm', bone: 'root', attachment: 'arm' }))
  doc.images.push({
    name: 'hero.png',
    path: 'hero.png',
    width: 128,
    height: 128,
    loose: false,
    regions: [{ name: 'hero/arm', x: 0, y: 0, width: 64, height: 64 }]
  })
  doc.images.push({
    name: 'goblin.png',
    path: 'goblin.png',
    width: 128,
    height: 128,
    loose: false,
    regions: [{ name: 'goblin/arm', x: 64, y: 64, width: 64, height: 64 }]
  })
  doc.skins[0].slots.push({
    slot: 'arm',
    attachments: [quadMesh('arm', 'hero.png', 'hero/arm', [0, 0.5, 0.5, 0.5, 0.5, 1, 0, 1])]
  })
  doc.skins.push({ name: 'goblin', slots: [{ slot: 'arm', attachments: [] }] })
  return doc
}

/** 在 goblin 皮肤里建一条指向 default / arm 的链接网格（换图） */
function withGoblinLink(doc: EditorDocument): AuthoringAttachment {
  const result = createLinkedMesh(doc, {
    slot: 'arm',
    skin: 'goblin',
    source: 'arm',
    image: 'goblin.png'
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(result.attachment).toBe('arm')
  const created = doc.skins[1].slots[0].attachments[0]
  expect(created).toBeTruthy()
  return created
}

describe('createLinkedMesh', () => {
  it('同名覆盖该插槽的显示，几何留空、链接字段指向源网格', () => {
    const doc = setup()
    const linked = withGoblinLink(doc)

    expect(linked.type).toBe('linkedmesh')
    expect(linked.name).toBe('arm')
    // 几何不复制：运行期从源网格合并
    expect(linked.vertices).toHaveLength(0)
    expect(linked.triangles).toHaveLength(0)
    expect(linked.linkedMeshAttachment).toBe('arm')
    // 源在默认皮肤 → 空串（与 Spine 缺省语义一致）
    expect(linked.linkedMeshSkin).toBe('')
    expect(linked.image).toBe('goblin.png')
    expect(doc.slots[0].attachment).toBe('arm')
  })

  it('按自己的图集区域重算 UV（不是照抄源网格那块）', () => {
    const doc = setup()
    const linked = withGoblinLink(doc)
    // goblin/arm 在 (64,64) 64×64：左下(0.5,0) 右下(1,0) 右上(1,0.5) 左上(0.5,0.5)
    expect(Array.from(linked.uvs)).toEqual([0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5])
  })

  it('同皮肤下与源同名会自动加序号，避免覆盖源网格本身', () => {
    const doc = setup()
    const result = createLinkedMesh(doc, { slot: 'arm', source: 'arm' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment).toBe('arm_2')
    // 源网格原样保留
    expect(doc.skins[0].slots[0].attachments[0].type).toBe('mesh')
  })

  it('源不是网格 / 源皮肤不存在时明确失败', () => {
    const doc = setup()
    doc.skins[0].slots[0].attachments.push(
      createAuthoringAttachment({ name: 'plain', type: 'region', image: 'hero.png' })
    )
    const notMesh = createLinkedMesh(doc, { slot: 'arm', source: 'plain' })
    expect(notMesh.ok).toBe(false)
    if (!notMesh.ok) expect(notMesh.reason).toContain('只能来自网格')

    const noSkin = createLinkedMesh(doc, { slot: 'arm', source: 'arm', sourceSkin: 'nope' })
    expect(noSkin.ok).toBe(false)
  })
})

describe('UV 重算', () => {
  it('碎图（没有 regions）按整页当一块区域', () => {
    const doc = setup()
    doc.images.push({ name: 'loose.png', path: 'loose.png', width: 32, height: 32, loose: true })
    const parent = doc.skins[0].slots[0].attachments[0]
    const uvs = linkedMeshUvs(doc, { image: 'loose.png', regionName: undefined }, parent)
    expect(uvs).toHaveLength(parent.uvs.length)
    // 整页当区域 → 等价于区域的四角
    expect(uvs).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
  })

  it('缺少图集信息时返回 null（调用方留空 UV，运行期退回父 UV）', () => {
    const doc = setup()
    const parent = doc.skins[0].slots[0].attachments[0]
    expect(linkedMeshUvs(doc, { image: 'missing.png', regionName: undefined }, parent)).toBeNull()
  })
})

describe('resolveAuthoringLinkedMesh', () => {
  it('源名空串 = 自身同名；源皮肤空串 = 默认皮肤', () => {
    const doc = setup()
    const linked = withGoblinLink(doc)
    linked.linkedMeshAttachment = ''
    const view = resolveAuthoringLinkedMesh(doc, linked, 'arm')
    expect(view?.parent.name).toBe('arm')
    expect(view?.vertices).toHaveLength(4)
  })

  it('父附件本身也是 linkedmesh 时返回 null（禁止链式）', () => {
    const doc = setup()
    withGoblinLink(doc)
    // 新建一套皮肤，把 goblin 里的链接网格当源
    doc.skins.push({ name: 'goblin2', slots: [{ slot: 'arm', attachments: [] }] })
    const result = createLinkedMesh(doc, {
      slot: 'arm',
      skin: 'goblin2',
      sourceSkin: 'goblin',
      source: 'arm'
    })
    // 创建命令自己就挡住「源不是 mesh」
    expect(result.ok).toBe(false)
  })
})

describe('换图 / 改源 / 解链', () => {
  it('换图只改这一条，不动同名的源网格', () => {
    const doc = setup()
    withGoblinLink(doc)
    const parent = doc.skins[0].slots[0].attachments[0]

    const result = setLinkedMeshImage(doc, { slot: 'arm', attachment: 'arm', skin: 'goblin', image: 'hero.png' })
    expect(result.ok).toBe(true)
    expect(doc.skins[1].slots[0].attachments[0].image).toBe('hero.png')
    expect(parent.image).toBe('hero.png')
    // 源网格没有被改走
    expect(doc.skins[0].slots[0].attachments[0].regionName).toBe('hero/arm')
  })

  it('patchAttachmentInSkin 不跨皮肤', () => {
    const doc = setup()
    withGoblinLink(doc)
    patchAttachmentInSkin(doc, 'goblin', 'arm', 'arm', (attachment) => {
      attachment.position.x = 5
    })
    expect(doc.skins[1].slots[0].attachments[0].position.x).toBe(5)
    expect(doc.skins[0].slots[0].attachments[0].position.x).toBe(0)
  })

  it('改源后链接字段与 UV 一起更新', () => {
    const doc = setup()
    withGoblinLink(doc)
    // 再来一条网格当新源
    doc.skins[0].slots[0].attachments.push(
      quadMesh('arm_b', 'goblin.png', 'goblin/arm', [0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5])
    )
    const result = setLinkedMeshSource(doc, { slot: 'arm', attachment: 'arm', skin: 'goblin', source: 'arm_b' })
    expect(result.ok).toBe(true)
    const linked = doc.skins[1].slots[0].attachments[0]
    expect(linked.linkedMeshAttachment).toBe('arm_b')
    expect(Array.from(linked.uvs)).toEqual([0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5])
  })

  it('解链把几何深拷贝成普通网格，并清掉链接字段', () => {
    const doc = setup()
    const linked = withGoblinLink(doc)
    const result = unlinkLinkedMesh(doc, { slot: 'arm', attachment: 'arm', skin: 'goblin' })
    expect(result.ok).toBe(true)
    expect(linked.type).toBe('mesh')
    expect(linked.vertices).toHaveLength(4)
    expect(linked.triangles).toHaveLength(6)
    expect(linked.linkedMeshSkin).toBe('')
    expect(linked.linkedMeshAttachment).toBe('')

    // 解链后是独立副本：改源网格不再影响它
    doc.skins[0].slots[0].attachments[0].vertices[0].x = 9
    expect(linked.vertices[0].x).toBe(-0.5)
  })
})

describe('FFD', () => {
  it('点数按源网格算，轨道带皮肤归属', () => {
    const doc = setup()
    withGoblinLink(doc)
    doc.animations.push(createAuthoringAnim('idle'))

    const result = keyDeformFrame(doc, {
      animation: 'idle',
      slot: 'arm',
      attachment: 'arm',
      time: 0,
      offsets: new Array(8).fill(0),
      skin: 'goblin'
    })
    expect(result.vertexCount).toBe(4)
    const track = doc.animations[0].deforms[0]
    expect(track.skin).toBe('goblin')
  })

  it('默认皮肤里的网格轨道不带皮肤（与老工程兼容）', () => {
    const doc = setup()
    doc.animations.push(createAuthoringAnim('idle'))
    keyDeformFrame(doc, {
      animation: 'idle',
      slot: 'arm',
      attachment: 'arm',
      time: 0,
      offsets: new Array(8).fill(0)
    })
    expect(doc.animations[0].deforms[0].skin).toBeUndefined()
    expect(attachmentSkinOf(doc, 'arm', 'arm', 'goblin')).toBe('default')
  })

  it('点数不匹配时报错（链接网格按源点数校验）', () => {
    const doc = setup()
    withGoblinLink(doc)
    doc.animations.push(createAuthoringAnim('idle'))
    expect(() =>
      keyDeformFrame(doc, {
        animation: 'idle',
        slot: 'arm',
        attachment: 'arm',
        time: 0,
        offsets: [0, 0],
        skin: 'goblin'
      })
    ).toThrow()
  })
})

describe('编译与运行期合并', () => {
  it('链接网格在运行期解析出源几何，贴图与 UV 用自己的', () => {
    const doc = setup()
    const linked = withGoblinLink(doc)
    doc.editorMeta.activeSkin = 'goblin'

    const { asset } = compileDocument(doc)
    const maps = buildRuntimeMaps(asset, 'goblin')
    const slotIndex = asset.slots.findIndex((item) => item.name === 'arm')
    const resolved = maps.resolved[slotIndex]
    expect(resolved).toBeTruthy()

    // setup 显示下标指向那条链接网格
    const display = maps.setupDisplayIndex[slotIndex]
    const merged = resolved?.[display]
    expect(merged).toBeTruthy()
    expect(merged?.name).toBe('arm')
    expect(merged?.textureName).toBe('goblin.png')
    // 运行期 vertices 是扁平数组（x,y）
    expect(merged?.vertices.length).toBe(8)
    expect(Array.from(merged?.uvs ?? [])).toEqual(Array.from(linked.uvs))
  })
})
