import { describe, expect, it } from 'vitest'
import { createEmptyDocument } from '@core/model/authoring'
import type {
  AuthoringAnimData,
  AuthoringAttachment,
  AuthoringBone,
  EditorDocument
} from '@core/model/authoring'
import {
  boneSlotAnchor,
  isDescendantOf,
  moveBone,
  moveDisplay,
  moveSlot,
  validateBoneMove
} from '@editor/commands/hierarchyCommands'
import { keySlotDisplay } from '@editor/commands/animationCommands'
import { MAT4_LENGTH, mul, trs } from '@core/math/matrix'
import { DEG2RAD } from '@core/math/utils'
import { setActiveScene } from '@editor/activeScene'
import { focusNode, frameOf } from '@editor/focusNode'
import type { FocusScene } from '@editor/focusNode'

function bone(name: string, parent: string): AuthoringBone {
  return {
    name,
    parent,
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 0.4,
    color: '#ffffff',
    locked: false
  }
}

function attachment(name: string): AuthoringAttachment {
  return {
    name,
    type: 'region',
    image: `${name}.png`,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    size: { x: 1, y: 1 },
    color: '#FFFFFFFF',
    vertices: [],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    triangles: [],
    edges: [],
    hull: 0,
    ffdInBoneSpace: false,
    linkedMeshSkin: '',
    linkedMeshAttachment: ''
  }
}

/** 按 fk.ts 的局部矩阵约定构造（支持斜切）：X 轴角 = r + shearX，Y 轴角 = r + 90 + shearY */
function localMatrix(b: AuthoringBone): Float32Array {
  const m = new Float32Array(MAT4_LENGTH)
  const rx = (b.rotation + b.localShear.x) * DEG2RAD
  const ry = (b.rotation + 90 + b.localShear.y) * DEG2RAD
  m[0] = Math.cos(rx) * b.localScale.x
  m[1] = Math.sin(rx) * b.localScale.x
  m[4] = Math.cos(ry) * b.localScale.y
  m[5] = Math.sin(ry) * b.localScale.y
  m[10] = 1
  m[12] = b.localPosition.x
  m[13] = b.localPosition.y
  m[15] = 1
  return m
}

/** 测试用世界矩阵：沿父链做矩阵乘法（inherit 全开的骨骼） */
function worldOf(bones: AuthoringBone[], name: string): Float32Array | null {
  const target = bones.find((item) => item.name === name)
  if (!target) return null
  const local = localMatrix(target)
  if (!target.parent) return local
  const parent = worldOf(bones, target.parent)
  return parent ? mul(parent, local) : local
}

/** 附件局部矩阵（附件只有 position / rotation / scale，没有斜切） */
function attachmentMatrix(a: AuthoringAttachment): Float32Array {
  return trs(a.position.x, a.position.y, a.rotation, a.scale.x, a.scale.y)
}

/** 附件世界矩阵 = 宿主骨骼世界 × 附件局部 */
function attachmentWorldOf(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName = 'default'
): Float32Array {
  const slot = doc.slots.find((item) => item.name === slotName)
  const skin = doc.skins.find((item) => item.name === skinName) ?? doc.skins[0]
  const att = skin.slots.find((item) => item.slot === slotName)?.attachments.find((item) => item.name === attachmentName)
  if (!slot || !att) throw new Error(`找不到 ${slotName}/${attachmentName}`)
  const boneWorld = worldOf(doc.bones, slot.bone)
  if (!boneWorld) throw new Error(`找不到骨骼 ${slot.bone}`)
  return mul(boneWorld, attachmentMatrix(att))
}

function expectSameMatrix(a: Float32Array, b: Float32Array): void {
  for (let i = 0; i < MAT4_LENGTH; i++) expect(a[i]).toBeCloseTo(b[i], 5)
}

function setup(): EditorDocument {
  const doc = createEmptyDocument('t')
  // root ─ boneA ─ childA
  //      └ boneB
  doc.bones.push(bone('root', ''), bone('boneA', 'root'), bone('childA', 'boneA'), bone('boneB', 'root'))
  doc.slots.push(
    { name: 'slotA', bone: 'boneA', color: '#FFFFFFFF', blendMode: 0, zOrder: 0, z: 0, attachment: 'body', visible: true, locked: false },
    { name: 'slotB', bone: 'boneB', color: '#FFFFFFFF', blendMode: 0, zOrder: 1, z: 0, attachment: '', visible: true, locked: false }
  )
  doc.skins[0].slots.push(
    { slot: 'slotA', attachments: [attachment('body'), attachment('head')] },
    { slot: 'slotB', attachments: [] }
  )
  return doc
}

describe('层级拖动：骨骼', () => {
  it('放到骨骼内部 = 成为它的子骨骼', () => {
    const doc = setup()
    const result = moveBone(doc, 'boneB', 'boneA', 'inside')
    expect(result.ok).toBe(true)
    expect(doc.bones.find((item) => item.name === 'boneB')?.parent).toBe('boneA')
  })

  it('贴上下沿 = 同级并排，调整数组顺序', () => {
    const doc = setup()
    moveBone(doc, 'boneB', 'boneA', 'above')
    expect(doc.bones.map((item) => item.name)).toEqual(['root', 'boneB', 'boneA', 'childA'])
    expect(doc.bones.find((item) => item.name === 'boneB')?.parent).toBe('root')
  })

  it('拖到空白 = 挂到根骨骼 root 下（不会变成与它平级的顶层骨骼）', () => {
    const doc = setup()
    const result = moveBone(doc, 'childA', '', 'inside')
    expect(result.ok).toBe(true)
    expect(doc.bones.find((item) => item.name === 'childA')?.parent).toBe('root')
    // 顶层骨骼始终只有 root 一根
    expect(doc.bones.filter((item) => !item.parent).map((item) => item.name)).toEqual(['root'])
  })

  it('层级根骨骼 root：自己不能移动（它是整棵树的根）', () => {
    const doc = setup()
    expect(validateBoneMove(doc, 'root', 'boneA').ok).toBe(false)
    const moved = moveBone(doc, 'root', '', 'inside')
    expect(moved.ok).toBe(false)
    expect(moved.message).toContain('层级根骨骼')
    expect(doc.bones.find((item) => item.name === 'root')?.parent).toBe('')
  })

  it('贴 root 行的上下沿 = 挂到 root 下（层级根没有平级位置）', () => {
    const doc = setup()
    moveBone(doc, 'childA', 'root', 'below')
    expect(doc.bones.find((item) => item.name === 'childA')?.parent).toBe('root')
    expect(doc.bones.filter((item) => !item.parent).map((item) => item.name)).toEqual(['root'])
  })

  it('挡掉「拖到自己身上」与「拖进自己的子树」', () => {
    const doc = setup()
    expect(validateBoneMove(doc, 'boneA', 'boneA').ok).toBe(false)
    const cyclic = moveBone(doc, 'boneA', 'childA', 'inside')
    expect(cyclic.ok).toBe(false)
    expect(cyclic.message).toContain('形成环')
    // 数据没被改动
    expect(doc.bones.find((item) => item.name === 'boneA')?.parent).toBe('root')
  })

  it('isDescendantOf 沿父链判断', () => {
    const doc = setup()
    expect(isDescendantOf(doc.bones, 'childA', 'root')).toBe(true)
    expect(isDescendantOf(doc.bones, 'boneB', 'boneA')).toBe(false)
  })
})

describe('重设父级保持世界变换', () => {
  it('换到另一根骨骼下面：全局位置 / 旋转 / 缩放逐元素不变', () => {
    const doc = createEmptyDocument('t')
    const root = { ...bone('root', ''), localPosition: { x: 10, y: 5 }, rotation: 30, localScale: { x: 2, y: 1.5 } }
    const holder = { ...bone('holder', ''), localPosition: { x: -4, y: 8 }, rotation: -45, localScale: { x: 0.5, y: 0.5 } }
    const arm = { ...bone('arm', 'root'), localPosition: { x: 1.2, y: 0.3 }, rotation: 15, localScale: { x: 1, y: 1 } }
    doc.bones.push(root, holder, arm)

    const before = worldOf(doc.bones, 'arm')
    expect(before).not.toBeNull()

    const result = moveBone(doc, 'arm', 'holder', 'inside', {
      worldMatrixOf: (name) => worldOf(doc.bones, name)
    })
    expect(result.ok).toBe(true)
    expect(doc.bones.find((item) => item.name === 'arm')?.parent).toBe('holder')
    expectSameMatrix(worldOf(doc.bones, 'arm') as Float32Array, before as Float32Array)
  })

  it('拖到空白 = 挂到 root 下：世界矩阵同样保持不变', () => {
    const doc = createEmptyDocument('t')
    const root = { ...bone('root', ''), localPosition: { x: 3, y: -2 }, rotation: 20, localScale: { x: 1.5, y: 0.75 } }
    const holder = { ...bone('holder', 'root'), localPosition: { x: 2, y: 1 }, rotation: 40, localScale: { x: 1, y: 1 } }
    const arm = { ...bone('arm', 'holder'), localPosition: { x: 0.5, y: 0.75 }, rotation: -10, localScale: { x: 1, y: 1 } }
    doc.bones.push(root, holder, arm)

    const before = worldOf(doc.bones, 'arm') as Float32Array
    moveBone(doc, 'arm', '', 'inside', { worldMatrixOf: (name) => worldOf(doc.bones, name) })
    expect(doc.bones.find((item) => item.name === 'arm')?.parent).toBe('root')
    expectSameMatrix(worldOf(doc.bones, 'arm') as Float32Array, before)
  })

  it('镜像骨骼（负缩放）：世界矩阵保持不变', () => {
    const doc = createEmptyDocument('t')
    const root = { ...bone('root', ''), localPosition: { x: -6, y: 4 }, rotation: 70, localScale: { x: 1, y: 1 } }
    const holder = { ...bone('holder', ''), rotation: 12, localScale: { x: 2, y: 2 } }
    const flipped = { ...bone('flipped', 'root'), localPosition: { x: 0.5, y: -0.25 }, localScale: { x: -1, y: 1 } }
    doc.bones.push(root, holder, flipped)

    const before = worldOf(doc.bones, 'flipped') as Float32Array
    moveBone(doc, 'flipped', 'holder', 'inside', { worldMatrixOf: (name) => worldOf(doc.bones, name) })
    expectSameMatrix(worldOf(doc.bones, 'flipped') as Float32Array, before)
  })

  it('带斜切的骨骼：世界矩阵保持不变（斜切被完整保留）', () => {
    const doc = createEmptyDocument('t')
    const root = { ...bone('root', ''), localPosition: { x: 2, y: 2 }, rotation: 33, localScale: { x: 1.2, y: 1.2 } }
    const holder = { ...bone('holder', ''), localPosition: { x: 5, y: -1 }, rotation: -25, localScale: { x: 0.8, y: 1.4 } }
    const skewed = { ...bone('skewed', 'root'), rotation: 10, localShear: { x: 18, y: -30 } }
    doc.bones.push(root, holder, skewed)

    const before = worldOf(doc.bones, 'skewed') as Float32Array
    moveBone(doc, 'skewed', 'holder', 'inside', { worldMatrixOf: (name) => worldOf(doc.bones, name) })
    expectSameMatrix(worldOf(doc.bones, 'skewed') as Float32Array, before)
    // 斜切归一化到 (-180,180]：不会留下 360 这种等价但难看的取值
    const moved = doc.bones.find((item) => item.name === 'skewed')
    expect(moved?.localShear.y).toBeGreaterThan(-180)
    expect(moved?.localShear.y).toBeLessThanOrEqual(180)
  })

  it('关闭继承的骨骼：局部 TRS 原样保留（不做逆推）', () => {
    const doc = createEmptyDocument('t')
    const root = { ...bone('root', ''), localPosition: { x: 7, y: 1 } }
    const holder = { ...bone('holder', 'root'), localPosition: { x: 2, y: 3 }, rotation: 30 }
    const free = { ...bone('free', 'root'), localPosition: { x: 1, y: 2 }, rotation: 12, inheritRotation: false }
    doc.bones.push(root, holder, free)

    moveBone(doc, 'free', 'holder', 'inside', { worldMatrixOf: (name) => worldOf(doc.bones, name) })
    const moved = doc.bones.find((item) => item.name === 'free')
    expect(moved?.parent).toBe('holder')
    expect(moved?.localPosition).toEqual({ x: 1, y: 2 })
    expect(moved?.rotation).toBe(12)
  })

  it('不传 worldMatrixOf 时保持旧行为（只改父级）', () => {
    const doc = setup()
    moveBone(doc, 'boneB', 'boneA', 'inside')
    expect(doc.bones.find((item) => item.name === 'boneB')?.localPosition).toEqual({ x: 0, y: 0 })
  })
})

describe('层级拖动：插槽', () => {
  it('换宿主骨骼并重排 zOrder', () => {
    const doc = setup()
    const result = moveSlot(doc, 'slotB', 'boneA', null)
    expect(result.ok).toBe(true)
    expect(doc.slots.find((item) => item.name === 'slotB')?.bone).toBe('boneA')
    // slotA(0) 仍在前面，slotB 被排到末尾
    expect(doc.slots.find((item) => item.name === 'slotA')?.zOrder).toBe(0)
    expect(doc.slots.find((item) => item.name === 'slotB')?.zOrder).toBe(1)
  })

  it('可以用锚点插到指定兄弟的前面', () => {
    const doc = setup()
    moveSlot(doc, 'slotB', 'boneA', { name: 'slotA', side: 'before' })
    expect(doc.slots.find((item) => item.name === 'slotB')?.zOrder).toBe(0)
    expect(doc.slots.find((item) => item.name === 'slotA')?.zOrder).toBe(1)
  })

  it('目标骨骼不存在时拒绝，且不改数据', () => {
    const doc = setup()
    const result = moveSlot(doc, 'slotA', 'nope', null)
    expect(result.ok).toBe(false)
    expect(doc.slots.find((item) => item.name === 'slotA')?.bone).toBe('boneA')
  })

  it('boneSlotAnchor 取该骨骼插槽列表的首 / 尾', () => {
    const doc = setup()
    moveSlot(doc, 'slotB', 'boneA', null)
    const list = doc.slots.filter((item) => item.bone === 'boneA')
    expect(boneSlotAnchor(doc, 'boneA', 'above')?.name).toBe(list[0].name)
    expect(boneSlotAnchor(doc, 'boneA', 'below')?.name).toBe(list[list.length - 1].name)
    expect(boneSlotAnchor(doc, 'nope', 'above')).toBeNull()
  })
})

describe('换宿主骨骼保持插槽全局变换', () => {
  function stage(): EditorDocument {
    const doc = createEmptyDocument('t')
    // 骨骼用均匀缩放：附件只有 position / rotation / scale（没有斜切），
    // 骨骼之间的相对变换是刚体 + 均匀缩放时才能被精确表达（非均匀缩放会引入斜切，见命令层注释）
    doc.bones.push(
      { ...bone('root', ''), localPosition: { x: 4, y: 3 }, rotation: 25, localScale: { x: 1.2, y: 1.2 } },
      { ...bone('hand', 'root'), localPosition: { x: 1, y: -0.5 }, rotation: 18, localScale: { x: 1, y: 1 } },
      { ...bone('foot', ''), localPosition: { x: -6, y: 2 }, rotation: -55, localScale: { x: 0.8, y: 0.8 } }
    )
    doc.slots.push({
      name: 'body',
      bone: 'hand',
      color: '#FFFFFFFF',
      blendMode: 0,
      zOrder: 0,
      z: 0,
      attachment: 'body',
      visible: true,
      locked: false
    })
    doc.skins[0].slots.push({
      slot: 'body',
      attachments: [
        { ...attachment('body'), position: { x: 0.4, y: -0.2 }, rotation: 30, scale: { x: 1.2, y: 0.8 } },
        { ...attachment('extra'), position: { x: -1, y: 0.5 }, rotation: -12, scale: { x: 1, y: 1 } }
      ]
    })
    // 第二张皮肤：同一插槽的附件也要一起换算
    doc.skins.push({
      name: 'alt',
      slots: [
        {
          slot: 'body',
          attachments: [{ ...attachment('body'), position: { x: 0.1, y: 0.3 }, rotation: 5, scale: { x: 0.9, y: 1.1 } }]
        }
      ]
    })
    return doc
  }

  const worldMatrixOf = (doc: EditorDocument) => (name: string) => worldOf(doc.bones, name)

  it('换到另一根骨骼下：插槽内每个附件的世界矩阵逐元素不变', () => {
    const doc = stage()
    const beforeBody = attachmentWorldOf(doc, 'body', 'body')
    const beforeExtra = attachmentWorldOf(doc, 'body', 'extra')

    const result = moveSlot(doc, 'body', 'foot', null, { worldMatrixOf: worldMatrixOf(doc) })
    expect(result.ok).toBe(true)
    expect(doc.slots.find((item) => item.name === 'body')?.bone).toBe('foot')

    expectSameMatrix(attachmentWorldOf(doc, 'body', 'body'), beforeBody)
    expectSameMatrix(attachmentWorldOf(doc, 'body', 'extra'), beforeExtra)
  })

  it('多张皮肤上的附件一起换算', () => {
    const doc = stage()
    const beforeAlt = attachmentWorldOf(doc, 'body', 'body', 'alt')
    moveSlot(doc, 'body', 'foot', null, { worldMatrixOf: worldMatrixOf(doc) })
    expectSameMatrix(attachmentWorldOf(doc, 'body', 'body', 'alt'), beforeAlt)
  })

  it('换到根骨骼（无父）场景下也保持', () => {
    const doc = stage()
    const root = { ...bone('plain', '') }
    doc.bones.push(root)
    const before = attachmentWorldOf(doc, 'body', 'body')
    moveSlot(doc, 'body', 'plain', null, { worldMatrixOf: worldMatrixOf(doc) })
    expectSameMatrix(attachmentWorldOf(doc, 'body', 'body'), before)
  })

  it('不传 worldMatrixOf 时保持旧行为（附件局部值不动）', () => {
    const doc = stage()
    const local = doc.skins[0].slots[0].attachments[0].position
    moveSlot(doc, 'body', 'foot', null)
    expect(doc.skins[0].slots[0].attachments[0].position).toEqual(local)
  })
})

describe('层级拖动：display', () => {
  it('移到另一个插槽，源插槽的显示项顺延到剩下的第一个', () => {
    const doc = setup()
    // slotA 当前显示 body，把 body 搬到 slotB
    const result = moveDisplay(doc, 'slotA', 'body', 'slotB', null, 'default')
    expect(result.ok).toBe(true)
    const skin = doc.skins[0]
    expect(skin.slots.find((item) => item.slot === 'slotA')?.attachments.map((a) => a.name)).toEqual(['head'])
    expect(skin.slots.find((item) => item.slot === 'slotB')?.attachments.map((a) => a.name)).toEqual(['body'])
    expect(doc.slots.find((item) => item.name === 'slotA')?.attachment).toBe('head')
    // 目标插槽原本没有显示项，接住搬过来的这个
    expect(doc.slots.find((item) => item.name === 'slotB')?.attachment).toBe('body')
  })

  it('同插槽内可以用锚点排序', () => {
    const doc = setup()
    moveDisplay(doc, 'slotA', 'head', 'slotA', { name: 'body', side: 'before' }, 'default')
    const list = doc.skins[0].slots.find((item) => item.slot === 'slotA')?.attachments ?? []
    expect(list.map((item) => item.name)).toEqual(['head', 'body'])
  })

  it('display 关键帧的下标按附件名重算', () => {
    const doc = setup()
    const anim: AuthoringAnimData = {
      name: 'idle',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    }
    doc.animations.push(anim)
    keySlotDisplay(anim, 'slotA', 0, 0, 'body')
    // 把 body 排到 head 后面，显示项仍是 body，但下标应从 0 变成 1
    moveDisplay(doc, 'slotA', 'body', 'slotA', { name: 'head', side: 'after' }, 'default')
    const track = anim.slots.find((item) => item.slot === 'slotA')
    expect(track?.displayAttachment).toEqual(['body'])
    expect(track?.displayIndex[0].value).toBe(1)
    expect(doc.slots.find((item) => item.name === 'slotA')?.attachment).toBe('body')
  })

  it('源插槽里没有这个 display 时拒绝', () => {
    const doc = setup()
    const result = moveDisplay(doc, 'slotB', 'body', 'slotA', null, 'default')
    expect(result.ok).toBe(false)
    expect(doc.skins[0].slots.find((item) => item.slot === 'slotA')?.attachments).toHaveLength(2)
  })
})

describe('display 换插槽保持全局变换', () => {
  function displayStage(): EditorDocument {
    const doc = createEmptyDocument('t')
    doc.bones.push(
      { ...bone('root', ''), localPosition: { x: 4, y: 3 }, rotation: 25, localScale: { x: 1.2, y: 1.2 } },
      { ...bone('hand', 'root'), localPosition: { x: 1, y: -0.5 }, rotation: 18, localScale: { x: 1, y: 1 } },
      { ...bone('foot', ''), localPosition: { x: -6, y: 2 }, rotation: -55, localScale: { x: 0.8, y: 0.8 } }
    )
    doc.slots.push(
      { name: 'slotA', bone: 'hand', color: '#FFFFFFFF', blendMode: 0, zOrder: 0, z: 0, attachment: 'body', visible: true, locked: false },
      { name: 'slotB', bone: 'foot', color: '#FFFFFFFF', blendMode: 0, zOrder: 1, z: 0, attachment: '', visible: true, locked: false }
    )
    doc.skins[0].slots.push(
      {
        slot: 'slotA',
        attachments: [
          { ...attachment('body'), position: { x: 0.4, y: -0.2 }, rotation: 30, scale: { x: 1.2, y: 0.8 } },
          { ...attachment('head'), position: { x: -0.6, y: 0.9 }, rotation: -15, scale: { x: 1, y: 1 } }
        ]
      },
      { slot: 'slotB', attachments: [] }
    )
    return doc
  }

  const worldMatrixOf = (doc: EditorDocument) => (name: string) => worldOf(doc.bones, name)

  it('移到另一根骨骼的插槽下：附件的世界矩阵逐元素不变', () => {
    const doc = displayStage()
    const before = attachmentWorldOf(doc, 'slotA', 'body')

    const result = moveDisplay(doc, 'slotA', 'body', 'slotB', null, 'default', {
      worldMatrixOf: worldMatrixOf(doc)
    })
    expect(result.ok).toBe(true)
    expect(doc.skins[0].slots.find((item) => item.slot === 'slotB')?.attachments.map((a) => a.name)).toEqual(['body'])
    expectSameMatrix(attachmentWorldOf(doc, 'slotB', 'body'), before)
  })

  it('同一插槽内排序：宿主没变，不做任何换算', () => {
    const doc = displayStage()
    const before = attachmentWorldOf(doc, 'slotA', 'body')
    const local = doc.skins[0].slots[0].attachments.find((a) => a.name === 'body')?.position

    moveDisplay(doc, 'slotA', 'body', 'slotA', { name: 'head', side: 'after' }, 'default', {
      worldMatrixOf: worldMatrixOf(doc)
    })
    const moved = doc.skins[0].slots[0].attachments.find((a) => a.name === 'body')
    expect(moved?.position).toEqual(local)
    expectSameMatrix(attachmentWorldOf(doc, 'slotA', 'body'), before)
  })
})

describe('双击节点聚焦（frameOf / focusNode）', () => {
  /** 假场景：骨骼世界矩阵用本文件的 worldOf 真算，附件世界矩阵由各用例指定 */
  function sceneOf(doc: EditorDocument, shown: Float32Array | null = null): FocusScene {
    return {
      worldMatrixOf: (name) => worldOf(doc.bones, name),
      attachmentWorldByName: () => shown
    }
  }

  it('骨骼：用自己的世界原点，框取骨骼长度的两倍', () => {
    const doc = setup()
    const boneA = doc.bones.find((item) => item.name === 'boneA')
    if (boneA) boneA.localPosition = { x: 2, y: -1 }
    // setup() 里骨骼长度 0.4 → 框 0.8
    expect(frameOf(sceneOf(doc), doc, { kind: 'bone', name: 'boneA' })).toEqual({
      x: 2,
      y: -1,
      width: 0.8,
      height: 0.8
    })
  })

  it('骨骼：极短的骨骼用下限，免得缩放到极限', () => {
    const doc = setup()
    doc.bones.push({ ...bone('tip', ''), length: 0.01 })
    expect(frameOf(sceneOf(doc), doc, { kind: 'bone', name: 'tip' })?.width).toBeCloseTo(0.6, 6)
  })

  it('display：用「宿主骨骼世界矩阵 × 附件 TRS」，点非当前显示的附件也准', () => {
    const doc = setup()
    const boneA = doc.bones.find((item) => item.name === 'boneA')
    // FK 约定：局部 +X 轴随 rotation 旋转，父链无旋转变换时 90° 会把 +X 转到世界 +Y
    if (boneA) boneA.rotation = 90
    const head = doc.skins[0].slots.find((item) => item.slot === 'slotA')?.attachments.find((i) => i.name === 'head')
    if (head) {
      head.position = { x: 0.5, y: 0 }
      head.size = { x: 0.4, y: 0.2 }
    }
    const frame = frameOf(sceneOf(doc), doc, { kind: 'display', slot: 'slotA', name: 'head' })
    expect(frame?.x).toBeCloseTo(0, 6)
    expect(frame?.y).toBeCloseTo(0.5, 6)
    expect(frame?.width).toBeCloseTo(0.4, 6)
    expect(frame?.height).toBeCloseTo(0.2, 6)
  })

  it('插槽：用当前显示附件的世界矩阵；空插槽退回宿主骨骼，尺寸仍按 setup 附件', () => {
    const doc = setup()
    const body = doc.skins[0].slots.find((item) => item.slot === 'slotA')?.attachments.find((i) => i.name === 'body')
    if (body) body.size = { x: 0.3, y: 0.6 }

    expect(frameOf(sceneOf(doc, trs(1.5, 0.25, 0, 1, 1)), doc, { kind: 'slot', name: 'slotA' })).toEqual({
      x: 1.5,
      y: 0.25,
      width: 0.3,
      height: 0.6
    })
    expect(frameOf(sceneOf(doc, null), doc, { kind: 'slot', name: 'slotA' })).toEqual({
      x: 0,
      y: 0,
      width: 0.3,
      height: 0.6
    })
  })

  it('约束：把整条骨骼链（含 target）都框进来', () => {
    const doc = setup()
    const boneB = doc.bones.find((item) => item.name === 'boneB')
    if (boneB) boneB.localPosition = { x: 2, y: 0 }
    doc.constraints.push({
      name: 'ik1',
      type: 'ik',
      bones: ['root', 'boneB'],
      target: 'boneB'
    } as unknown as EditorDocument['constraints'][number])

    const frame = frameOf(sceneOf(doc), doc, { kind: 'constraint', name: 'ik1' })
    // root 在原点、boneB 在 (2,0)：中心 (1,0)，宽 2×1.4，链在一条线上 → 高度取下限
    expect(frame?.x).toBeCloseTo(1, 6)
    expect(frame?.y).toBeCloseTo(0, 6)
    expect(frame?.width).toBeCloseTo(2.8, 6)
    expect(frame?.height).toBeCloseTo(0.6, 6)
  })

  it('名字对不上 / 数据缺失时返回 null，不抛错', () => {
    const doc = setup()
    const scene = sceneOf(doc)
    expect(frameOf(scene, doc, { kind: 'bone', name: 'nope' })).toBeNull()
    expect(frameOf(scene, doc, { kind: 'constraint', name: 'nope' })).toBeNull()
    expect(frameOf(scene, doc, { kind: 'display', slot: 'slotA', name: 'nope' })).toBeNull()
    expect(frameOf(scene, doc, { kind: 'display', slot: 'nope', name: 'body' })).toBeNull()
    expect(frameOf(scene, doc, { kind: 'slot', name: 'nope' })).toBeNull()
  })

  it('focusNode：把算好的框交给相机；场景未就绪时返回 false 且不动作', () => {
    const doc = setup()
    const calls: number[][] = []
    const scene = {
      ...sceneOf(doc),
      frameContent: (x: number, y: number, width: number, height: number) => {
        calls.push([x, y, width, height])
      }
    }
    setActiveScene(scene as unknown as Parameters<typeof setActiveScene>[0])

    expect(focusNode(doc, { kind: 'bone', name: 'root' })).toBe(true)
    expect(calls).toEqual([[0, 0, 0.8, 0.8]])

    setActiveScene(null)
    expect(focusNode(doc, { kind: 'bone', name: 'root' })).toBe(false)
    expect(calls).toHaveLength(1)
  })
})
