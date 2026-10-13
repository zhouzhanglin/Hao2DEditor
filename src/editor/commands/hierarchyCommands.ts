import type { AuthoringAttachment, AuthoringBone, EditorDocument } from '@core/model/authoring'
import { rootBoneName } from '@core/model/authoring'
import { MAT4_LENGTH, decomposeTrs, invert, mul, trs } from '@core/math/matrix'
import { DEG2RAD } from '@core/math/utils'
import { findSkinSlot } from './authoringCommands'

/**
 * 层级树里的拖动重排：骨骼换父级 / 插槽换宿主 / display 换插槽。
 *
 * 规则（与编辑器里的说法一致）：
 * - 骨骼只能放到**骨骼**下面（inside = 成为子骨骼，above/below = 与目标同级并排）；放到空白处 = 挂到根骨骼下
 * - 层级根骨骼 `root` 是**唯一**的顶层骨骼：它自己不能移动，别的骨骼也不能被拖到它旁边与它平级
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

/**
 * 「换父级 / 换宿主时保持世界变换」用的世界矩阵查询。
 *
 * 传了它就按**拖动前**的世界矩阵反推出新的局部值，对象在画面上不动；
 * 不传 = 老行为（只改父子关系，局部值原样保留）。
 * 返回 `null` 表示这根骨骼当前查不到（比如场景还没就绪）—— 那一步就不换算，宁可不换算也不乱改。
 */
export interface MoveOptions {
  worldMatrixOf?: (boneName: string) => Float32Array | null
}

/** 骨骼的局部矩阵：含斜切（X 轴角 = rotation + shearX，Y 轴角 = rotation + 90 + shearY），与 decomposeTrs 互逆 */
function boneLocalMatrix(bone: AuthoringBone): Float32Array {
  const m = new Float32Array(MAT4_LENGTH)
  const rx = (bone.rotation + bone.localShear.x) * DEG2RAD
  const ry = (bone.rotation + 90 + bone.localShear.y) * DEG2RAD
  m[0] = Math.cos(rx) * bone.localScale.x
  m[1] = Math.sin(rx) * bone.localScale.x
  m[4] = Math.cos(ry) * bone.localScale.y
  m[5] = Math.sin(ry) * bone.localScale.y
  m[10] = 1
  m[12] = bone.localPosition.x
  m[13] = bone.localPosition.y
  m[15] = 1
  return m
}

/** 把矩阵写回骨骼的局部 TRS（含斜切；镜像统一归到 scaleY 取负，见 decomposeTrs） */
function applyLocalMatrix(bone: AuthoringBone, m: Float32Array): void {
  const parts = decomposeTrs(m)
  bone.localPosition = { x: parts.x, y: parts.y }
  bone.rotation = parts.rotation
  bone.localScale = { x: parts.scaleX, y: parts.scaleY }
  bone.localShear = { x: parts.shearX, y: parts.shearY }
}

/** 附件局部矩阵：附件只有 position / rotation / scale，没有斜切 */
function attachmentLocalMatrix(att: AuthoringAttachment): Float32Array {
  return trs(att.position.x, att.position.y, att.rotation, att.scale.x, att.scale.y)
}

/**
 * 换宿主骨骼后，把附件局部值重算成「相对新宿主骨骼」的等价变换（世界矩阵逐元素不变）。
 *
 * 附件只有 position / rotation / scale（**没有斜切字段**），而两根骨骼之间可能是
 * 「非均匀缩放 + 斜切」—— 那种相对变换无法用这三个量精确表达，只能取最接近的分解
 * （画面会有一点点形变）。骨骼之间是刚体 + **均匀**缩放时（拖槽位的常见做法）则是精确的。
 */
function rebindAttachment(att: AuthoringAttachment, oldBoneWorld: Float32Array, newBoneWorld: Float32Array): void {
  const world = mul(oldBoneWorld, attachmentLocalMatrix(att))
  const parts = decomposeTrs(mul(invert(newBoneWorld), world))
  att.position = { x: parts.x, y: parts.y }
  att.rotation = parts.rotation
  att.scale = { x: parts.scaleX, y: parts.scaleY }
}

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
  /*
   * 层级根骨骼是整棵树的根：它一动，下面所有骨骼的世界变换都要跟着漂，
   * 「唯一顶层骨骼」这个结构前提也没了 —— 直接拒绝（它自己也没有可平级的位置）。
   */
  if (name === rootBoneName(doc.bones)) {
    return { ok: false, message: `「${name}」是层级根骨骼：其他骨骼都在它之下，它自己不能移动` }
  }
  if (targetBone && isDescendantOf(doc.bones, targetBone, name)) {
    return { ok: false, message: `「${targetBone}」在「${name}」的子树里，拖进去会形成环` }
  }
  if (targetBone && !doc.bones.some((item) => item.name === targetBone)) {
    return { ok: false, message: `找不到骨骼「${targetBone}」` }
  }
  return { ok: true, message: '' }
}

/**
 * 移动骨骼。
 * - `inside`：成为 targetBone 的子骨骼；targetBone 为空串（拖到列表空白处）= 挂到层级根骨骼 root 下
 * - `above` / `below`：与 targetBone 同级，并排到它的前 / 后（数组顺序即树的显示顺序）；
 *   贴**根骨骼**行的上下沿则挂到它下面 —— 层级根是唯一的顶层，不存在与它平级的位置
 */
export function moveBone(
  doc: EditorDocument,
  name: string,
  targetBone: string,
  zone: DropZone,
  options?: MoveOptions
): MoveResult {
  const check = validateBoneMove(doc, name, targetBone)
  if (!check.ok) return check
  const bone = doc.bones.find((item) => item.name === name)
  if (!bone) return check

  /*
   * 新父级：inside = 目标骨骼本身（目标是空白 = 层级根骨骼）；
   * above / below = 与目标同级（挂到目标的父级），目标就是层级根时改挂到它下面。
   *
   * `|| root` 是**兜底**：老工程里若存在第二根顶层骨骼（`parent` 为空），
   * 贴它上下沿也不会落到顶层去与根骨骼平级。
   */
  const root = rootBoneName(doc.bones)
  const target = targetBone ? doc.bones.find((item) => item.name === targetBone) : null
  const parent =
    zone === 'inside'
      ? targetBone || root
      : target
        ? target.name === root
          ? root
          : target.parent || root
        : root

  /*
   * 保持世界变换：用**拖动前**的世界矩阵（父链还是旧的那条）反推出新的局部 TRS。
   * 必须在改 parent 之前取矩阵 —— 改完再算就成「用新父级算旧世界」了。
   * 关闭继承（inheritRotation / inheritScale）的骨骼不做逆推：它的局部值本来就不跟随父级，
   * 强行换算反而会改变语义。
   */
  if (options?.worldMatrixOf) {
    const world = options.worldMatrixOf(name)
    const parentWorld = parent ? options.worldMatrixOf(parent) : null
    if (world && bone.inheritRotation && bone.inheritScale && (parent === '' || parentWorld)) {
      applyLocalMatrix(bone, parent && parentWorld ? mul(invert(parentWorld), world) : world)
    }
  }

  if (zone === 'inside' || !targetBone) {
    bone.parent = parent
  } else {
    if (!target) return { ok: false, message: `找不到骨骼「${targetBone}」` }
    bone.parent = parent
    const from = doc.bones.indexOf(bone)
    if (from >= 0) doc.bones.splice(from, 1)
    const at = doc.bones.indexOf(target)
    doc.bones.splice(zone === 'above' ? Math.max(0, at) : at + 1, 0, bone)
  }
  return {
    ok: true,
    // 贴上下沿是「与目标同级」：父级会跟着换成目标的父级，只说「已移到旁边」会被当成只动了顺序
    message: targetBone
      ? zone === 'inside'
        ? `骨骼「${name}」已移到「${targetBone}」下`
        : `骨骼「${name}」已移到「${targetBone}」旁（与它同父级）`
      : root
        ? `骨骼「${name}」已移到根骨骼「${root}」下`
        : `骨骼「${name}」已变成根骨骼`
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

/**
 * 移动插槽：换宿主骨骼 + 按绘制顺序重排 zOrder。
 * zOrder 是全局的（编译时按它统一排序绘制），所以这里整表重排一遍。
 */
export function moveSlot(
  doc: EditorDocument,
  name: string,
  targetBone: string,
  anchor: MoveAnchor | null,
  options?: MoveOptions
): MoveResult {
  const check = validateSlotMove(doc, name, targetBone)
  if (!check.ok) return check
  const slot = doc.slots.find((item) => item.name === name)
  if (!slot) return check

  /*
   * 换宿主骨骼：插槽本身没有局部变换，动的是它里面的附件 ——
   * 每张皮肤上挂在这个插槽下的附件都要按「旧宿主 → 新宿主」换算一次，画面上才会待在原地。
   */
  if (slot.bone !== targetBone && options?.worldMatrixOf) {
    const oldWorld = options.worldMatrixOf(slot.bone)
    const newWorld = options.worldMatrixOf(targetBone)
    if (oldWorld && newWorld) {
      for (const skin of doc.skins) {
        const skinSlot = findSkinSlot(skin, name)
        if (!skinSlot) continue
        for (const att of skinSlot.attachments) rebindAttachment(att, oldWorld, newWorld)
      }
    }
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
  skinName: string,
  options?: MoveOptions
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

  // 换到别的插槽 = 换宿主骨骼：按旧宿主的世界矩阵把这个附件换算到新宿主空间（保持世界变换）。
  // 同一插槽内只是排序（宿主没变）时不做任何换算。
  if (moved && fromSlot !== toSlot && options?.worldMatrixOf) {
    const fromBone = doc.slots.find((item) => item.name === fromSlot)?.bone ?? ''
    const toBone = doc.slots.find((item) => item.name === toSlot)?.bone ?? ''
    const oldWorld = fromBone ? options.worldMatrixOf(fromBone) : null
    const newWorld = toBone ? options.worldMatrixOf(toBone) : null
    if (oldWorld && newWorld && fromBone !== toBone) rebindAttachment(moved, oldWorld, newWorld)
  }
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
