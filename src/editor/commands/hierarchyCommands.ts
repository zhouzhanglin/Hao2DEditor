import type { EditorDocument } from '@core/model/authoring'
import { decomposeTrs, invert, mul, trs } from '@core/math/matrix'
import { findSkinSlot } from './authoringCommands'

/**
 * 层级树里的拖动重排：骨骼换父级 / 插槽换宿主 / display 换插槽。
 *
 * 规则（与编辑器里的说法一致）：
 * - 骨骼只能放到**骨骼**下面（inside = 成为子骨骼，above/below = 与目标同级并排）；放到空白处 = 根骨骼
 * - 插槽只能放到**骨骼**下面（inside = 换宿主骨骼，贴骨骼行上下沿 = 排到该骨骼插槽列表的首/尾）
 * - display 只能待在**插槽**下面（落到 display 行 = 在同一插槽内排序）
 *
 * 所有函数都直接改传入的文档（调用方负责放进 update / immer draft 里），
 * 返回 `{ ok, message }` 供 UI 直接提示。
 */

export type DropZone = 'inside' | 'above' | 'below'

/** 排序锚点：插到某个兄弟的前面 / 后面；null = 追加到末尾 */
export interface MoveAnchor {
  name: string
  side: 'before' | 'after'
}

export interface MoveResult {
  ok: boolean
  message: string
}

type Bones = EditorDocument['bones']
type Slots = EditorDocument['slots']

/** name 是否落在 ancestor 的子树里（用来挡住「把骨骼拖进自己的后代」这种成环操作） */
export function isDescendantOf(bones: readonly Bones[number][], name: string, ancestor: string): boolean {
  let current = bones.find((bone) => bone.name === name)?.parent ?? ''
  let guard = 0
  while (current && guard++ < 1024) {
    if (current === ancestor) return true
    current = bones.find((bone) => bone.name === current)?.parent ?? ''
  }
  return false
}

/** 骨骼移动的合法性检查（只读，不改文档）：UI 先校验再落历史，避免撤销栈里出现空操作 */
export function validateBoneMove(doc: EditorDocument, name: string, targetBone: string): MoveResult {
  if (!doc.bones.some((item) => item.name === name)) return { ok: false, message: `找不到骨骼「${name}」` }
  if (name === targetBone) return { ok: false, message: '骨骼不能拖到它自己下面' }
  if (targetBone && isDescendantOf(doc.bones, targetBone, name)) {
    return { ok: false, message: `「${targetBone}」在「${name}」的子树里，拖进去会形成环` }
  }
  if (targetBone && !doc.bones.some((item) => item.name === targetBone)) {
    return { ok: false, message: `找不到骨骼「${targetBone}」` }
  }
  return { ok: true, message: '' }
}

export interface MoveBoneOptions {
  /**
   * 取骨骼「当前世界矩阵」（列主序 16 个数，setup 姿态）的拷贝。
   * 传入后重设父级会**保持被移动骨骼的全局位置 / 旋转 / 缩放 / 斜切不变**；
   * 不传则只改父级（局部 TRS 原样保留，世界变换会跟着变）。
   */
  worldMatrixOf?: (boneName: string) => Float32Array | null
}

/**
 * 重设父级时保持世界变换：按新父（空 = 根层）把旧世界矩阵换算成新的局部 TRS。
 *
 * 关闭了「继承旋转 / 缩放」的骨骼不适用（它的局部参数与父级的组合不是标准矩阵乘法，
 * 逆推不成立），这类骨骼保持原局部值不动。
 */
function preserveWorldTransform(
  bone: Bones[number],
  newParent: string,
  worldMatrixOf: (boneName: string) => Float32Array | null
): void {
  if (!bone.inheritRotation || !bone.inheritScale) return
  const world = worldMatrixOf(bone.name)
  if (!world) return
  let local: Float32Array
  if (newParent) {
    const parentWorld = worldMatrixOf(newParent)
    if (!parentWorld) return
    local = mul(invert(parentWorld), world)
  } else {
    // 根层：局部矩阵就是世界矩阵
    local = world
  }
  const parts = decomposeTrs(local)
  bone.localPosition = { x: parts.x, y: parts.y }
  bone.rotation = parts.rotation
  bone.localScale = { x: parts.scaleX, y: parts.scaleY }
  bone.localShear = { x: parts.shearX, y: parts.shearY }
}

/**
 * 移动骨骼。
 * - `inside`：targetBone 为空串时变成根骨骼，否则成为它的子骨骼
 * - `above` / `below`：与 targetBone 同级，并排到它的前 / 后（数组顺序即树的显示顺序）
 *
 * 传入 `options.worldMatrixOf` 时保持骨骼的世界变换（全局位置 / 旋转 / 缩放 / 斜切不变）。
 */
export function moveBone(
  doc: EditorDocument,
  name: string,
  targetBone: string,
  zone: DropZone,
  options?: MoveBoneOptions
): MoveResult {
  const check = validateBoneMove(doc, name, targetBone)
  if (!check.ok) return check
  const bone = doc.bones.find((item) => item.name === name)
  if (!bone) return check

  if (zone === 'inside' || !targetBone) {
    if (options?.worldMatrixOf && bone.parent !== targetBone) {
      preserveWorldTransform(bone, targetBone, options.worldMatrixOf)
    }
    bone.parent = targetBone
  } else {
    const target = doc.bones.find((item) => item.name === targetBone)
    if (!target) return { ok: false, message: `找不到骨骼「${targetBone}」` }
    if (options?.worldMatrixOf && bone.parent !== target.parent) {
      preserveWorldTransform(bone, target.parent, options.worldMatrixOf)
    }
    bone.parent = target.parent
    const from = doc.bones.indexOf(bone)
    if (from >= 0) doc.bones.splice(from, 1)
    const at = doc.bones.indexOf(target)
    doc.bones.splice(zone === 'above' ? Math.max(0, at) : at + 1, 0, bone)
  }
  return {
    ok: true,
    message: targetBone ? `骨骼「${name}」已移到「${targetBone}」${zone === 'inside' ? '下' : '旁'}` : `骨骼「${name}」已变成根骨骼`
  }
}

/** 插槽移动的合法性检查：插槽要在、宿主骨骼要有 */
export function validateSlotMove(doc: EditorDocument, name: string, targetBone: string): MoveResult {
  if (!doc.slots.some((item) => item.name === name)) return { ok: false, message: `找不到插槽「${name}」` }
  if (!targetBone) return { ok: false, message: '插槽必须挂在某根骨骼下' }
  if (!doc.bones.some((item) => item.name === targetBone)) {
    return { ok: false, message: `找不到骨骼「${targetBone}」` }
  }
  return { ok: true, message: '' }
}

export interface MoveSlotOptions {
  /**
   * 取骨骼「当前世界矩阵」（列主序 16 个数，setup 姿态）的拷贝。
   * 传入后换宿主骨骼会**保持插槽内容的全局位置 / 旋转 / 缩放**不变。
   */
  worldMatrixOf?: (boneName: string) => Float32Array | null
}

/**
 * 换宿主骨骼时保持插槽内容的全局变换。
 *
 * 插槽本身没有变换，视觉姿态来自「宿主骨骼世界矩阵 × 附件局部 TRS」，
 * 所以把该插槽在**每张皮肤**上的附件从旧骨骼空间换算到新骨骼空间：
 *
 *   新局部 = inverse(新骨骼世界) × 旧骨骼世界 × 旧局部
 *
 * 附件只有 position / rotation / scale（没有斜切），骨骼之间带斜切时会丢极小一点，
 * 常规（骨骼无斜切）时逐元素精确保持。
 */
function preserveSlotContent(
  doc: EditorDocument,
  slotName: string,
  fromBone: string,
  toBone: string,
  worldMatrixOf: (boneName: string) => Float32Array | null
): void {
  const fromWorld = fromBone ? worldMatrixOf(fromBone) : null
  const toWorld = worldMatrixOf(toBone)
  if (!fromWorld || !toWorld) return
  const relative = mul(invert(toWorld), fromWorld)
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    if (!skinSlot) continue
    for (const attachment of skinSlot.attachments) {
      const local = trs(
        attachment.position.x,
        attachment.position.y,
        attachment.rotation,
        attachment.scale.x,
        attachment.scale.y
      )
      const parts = decomposeTrs(mul(relative, local))
      attachment.position = { x: parts.x, y: parts.y }
      attachment.rotation = parts.rotation
      attachment.scale = { x: parts.scaleX, y: parts.scaleY }
    }
  }
}

/**
 * 移动插槽：换宿主骨骼 + 按绘制顺序重排 zOrder。
 * zOrder 是全局的（编译时按它统一排序绘制），所以这里整表重排一遍。
 *
 * 传入 `options.worldMatrixOf` 时保持插槽内容的全局变换（位置 / 旋转 / 缩放不变）。
 */
export function moveSlot(
  doc: EditorDocument,
  name: string,
  targetBone: string,
  anchor: MoveAnchor | null,
  options?: MoveSlotOptions
): MoveResult {
  const check = validateSlotMove(doc, name, targetBone)
  if (!check.ok) return check
  const slot = doc.slots.find((item) => item.name === name)
  if (!slot) return check

  if (options?.worldMatrixOf && slot.bone !== targetBone) {
    preserveSlotContent(doc, name, slot.bone, targetBone, options.worldMatrixOf)
  }
  slot.bone = targetBone
  const ordered = [...doc.slots].sort((left, right) => left.zOrder - right.zOrder).filter((item) => item.name !== name)
  let index = ordered.length
  if (anchor) {
    const at = ordered.findIndex((item) => item.name === anchor.name)
    if (at >= 0) index = anchor.side === 'before' ? at : at + 1
  } else {
    // 追加到目标骨骼插槽列表的末尾
    const last = ordered.map((item) => item.bone).lastIndexOf(targetBone)
    index = last >= 0 ? last + 1 : ordered.length
  }
  ordered.splice(Math.max(0, Math.min(ordered.length, index)), 0, slot)
  ordered.forEach((item, order) => {
    item.zOrder = order
  })
  return { ok: true, message: `插槽「${name}」已挂到骨骼「${targetBone}」下` }
}

/** 目标骨骼插槽列表的首 / 尾，作为「贴在该骨骼行上下沿」时的排序锚点 */
export function boneSlotAnchor(doc: EditorDocument, boneName: string, zone: 'above' | 'below'): MoveAnchor | null {
  const ordered = [...doc.slots].sort((left, right) => left.zOrder - right.zOrder)
  const list = ordered.filter((item) => item.bone === boneName)
  if (list.length === 0) return null
  return zone === 'above'
    ? { name: list[0].name, side: 'before' }
    : { name: list[list.length - 1].name, side: 'after' }
}

/** display 移动的合法性检查：源插槽里真的挂着这个附件 */
export function validateDisplayMove(
  doc: EditorDocument,
  fromSlot: string,
  name: string,
  toSlot: string,
  skinName: string
): MoveResult {
  const skin = doc.skins.find((item) => item.name === skinName) ?? doc.skins[0]
  if (!skin) return { ok: false, message: '工程里没有皮肤' }
  const source = findSkinSlot(skin, fromSlot)
  const target = fromSlot === toSlot ? source : findSkinSlot(skin, toSlot)
  if (!source || !target) return { ok: false, message: '找不到对应的插槽附件清单' }
  if (!source.attachments.some((item) => item.name === name)) {
    return { ok: false, message: `插槽「${fromSlot}」里没有 display「${name}」` }
  }
  return { ok: true, message: '' }
}

/**
 * 移动 display（附件）到另一个插槽，或在同一插槽内排序。
 *
 * - 源插槽的「当前显示」若被搬走，顺延到剩下的第一个（没了就置空）
 * - 目标插槽原本没有显示项时，接住这个 display
 * - 最后按附件名重算相关插槽的 displayIndex 关键帧
 */
export function moveDisplay(
  doc: EditorDocument,
  fromSlot: string,
  name: string,
  toSlot: string,
  anchor: MoveAnchor | null,
  skinName: string
): MoveResult {
  const check = validateDisplayMove(doc, fromSlot, name, toSlot, skinName)
  if (!check.ok) return check

  const skin = doc.skins.find((item) => item.name === skinName) ?? doc.skins[0]
  if (!skin) return check
  const source = findSkinSlot(skin, fromSlot)
  const target = fromSlot === toSlot ? source : findSkinSlot(skin, toSlot)
  if (!source || !target) return check

  const at = source.attachments.findIndex((item) => item.name === name)
  if (at < 0) return check

  const [moved] = source.attachments.splice(at, 1)
  let index = target.attachments.length
  if (anchor) {
    const found = target.attachments.findIndex((item) => item.name === anchor.name)
    if (found >= 0) index = anchor.side === 'before' ? found : found + 1
  }
  target.attachments.splice(Math.max(0, Math.min(target.attachments.length, index)), 0, moved)

  // 同一插槽内只是排序，当前显示项不该被换掉
  if (fromSlot !== toSlot) {
    const sourceSlot = doc.slots.find((item) => item.name === fromSlot)
    if (sourceSlot && sourceSlot.attachment === name) {
      sourceSlot.attachment = source.attachments[0]?.name ?? ''
    }
  }
  const targetSlot = doc.slots.find((item) => item.name === toSlot)
  if (targetSlot && !targetSlot.attachment) targetSlot.attachment = name

  remapDisplayIndices(doc, [fromSlot, toSlot], skin.name)
  return {
    ok: true,
    message: fromSlot === toSlot ? `已调整 display「${name}」的顺序` : `display「${name}」已移到插槽「${toSlot}」下`
  }
}

/**
 * display 增删 / 移动后，把相关插槽的 displayIndex 关键帧按**附件名**重新解析成新下标。
 * 帧里同时存了 displayAttachment 名字（运行期优先按名字解析），这里把下标也同步好，
 * 免得编辑面板上显示的 index 与真正的显示项对不上。
 */
export function remapDisplayIndices(
  doc: EditorDocument,
  slotNames: readonly string[],
  skinName: string
): void {
  const skin = doc.skins.find((item) => item.name === skinName) ?? doc.skins[0]
  if (!skin) return
  for (const animation of doc.animations) {
    for (const track of animation.slots) {
      if (!slotNames.includes(track.slot)) continue
      const list = skin.slots.find((item) => item.slot === track.slot)?.attachments ?? []
      track.displayIndex.forEach((frame, index) => {
        const attachmentName = track.displayAttachment[index]
        const found = list.findIndex((item) => item.name === attachmentName)
        if (found >= 0) frame.value = found
      })
    }
  }
}

/** 插槽 zOrder 排序（给外部做校验 / 展示用） */
export function orderSlots(slots: readonly Slots[number][]): Slots[number][] {
  return [...slots].sort((left, right) => left.zOrder - right.zOrder)
}

/**
 * 按 UI 列表顺序重排插槽 zOrder：`names[0]` = 最上层（最后绘制）。
 * 只改 zOrder，不动 slots 数组本身。
 */
export function applySlotOrder(doc: EditorDocument, names: readonly string[]): void {
  const total = doc.slots.length
  names.forEach((name, index) => {
    const slot = doc.slots.find((item) => item.name === name)
    if (slot) slot.zOrder = total - 1 - index
  })
}

/** setup 绘制顺序（slot 名，第 0 个最先画 = 最底层） */
export function drawOrderOf(doc: EditorDocument): string[] {
  return orderSlots(doc.slots).map((slot) => slot.name)
}
