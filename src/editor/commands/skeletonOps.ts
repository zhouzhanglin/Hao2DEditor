import type { AuthoringBone, AuthoringAttachment, EditorDocument } from '@core/model/authoring'
import { createAuthoringAnim, createAuthoringBone, createAuthoringSlot, rootBoneName } from '@core/model/authoring'
import { createIkConstraint, createPathConstraint, createTransformConstraint } from '@core/model/constraints'
import { BlendMode } from '@core/model/types'
import { getActiveScene } from '../activeScene'
import { moveBone, moveSlot } from './hierarchyCommands'
import { addImageDisplay, deleteAttachment, patchAttachment, uniqueName } from './authoringCommands'

/**
 * 创建 / 设置类命令的**纯文档操作**。
 *
 * 与 `authoringCommands` 的分工：那边是「对已有对象做编辑」，这边是「从无到有地造对象」
 * 以及「一次性写入一组属性」。全部是 `(doc, options) => Result` 的纯函数，
 * 由 `skeletonCommands.ts` 包成 AI 可调用的命令；层级树 UI 也复用它们，
 * 保证「人手点」和「AI 调用」走同一套语义、同一套命名去重规则。
 *
 * 关于失败：**参数不合法（名字不存在、链不成链）一律抛异常** —— 注册表会把它折成
 * `ok:false` 连同一句人话回给 AI，比返回 `null` 更容易让 AI 自我纠正。
 */

export type Vec2 = { x: number; y: number }

/** 新建 IK 节点骨的颜色：与视口里 IK 手柄同色 */
export const IK_NODE_COLOR = '#e4572e'

/** 取骨骼当前世界矩阵；场景未就绪时返回 null */
function worldMatrixOfBone(boneName: string): Float32Array | null {
  return getActiveScene()?.worldMatrixOf(boneName) ?? null
}

/** 骨骼末端的世界坐标（原点沿骨骼 x 轴前进 length）：新建 IK 节点骨要摆在链尾末端 */
export function boneTipWorld(boneName: string, length: number): Vec2 | null {
  const matrix = worldMatrixOfBone(boneName)
  if (!matrix || matrix.length < 14) return null
  // mat4 列主序：第 0 列是骨骼 x 轴方向，平移在 [12] / [13]
  return { x: matrix[0] * length + matrix[12], y: matrix[1] * length + matrix[13] }
}

/**
 * 整理出「父 → 子」连续的骨骼链（IK 用）。
 *
 * 乱七八糟的一组骨骼（选了两条腿）拿去当链只会配出错的 IK，所以这里严格校验：
 * 相邻两根必须是父子关系。顺序给反了（链尾在前）也接受，翻转后同样连续就用翻转的结果 ——
 * IK 的链根必须排在前面。
 */
export function asBoneChain(doc: EditorDocument, names: readonly string[]): string[] {
  const picked = names.filter(Boolean)
  const isChain = (list: readonly string[]): boolean =>
    list.length >= 2 &&
    list.every((name, index) => {
      if (index === 0) return doc.bones.some((bone) => bone.name === name)
      const bone = doc.bones.find((item) => item.name === name)
      return !!bone && bone.parent === list[index - 1]
    })
  if (isChain(picked)) return [...picked]
  const reversed = [...picked].reverse()
  if (isChain(reversed)) return reversed
  return []
}

function requireBone(doc: EditorDocument, name: string, role: string): AuthoringBone {
  const bone = doc.bones.find((item) => item.name === name)
  if (!bone) throw new Error(`${role}不存在：${name}（用 listBones 查现有骨骼名）`)
  return bone
}

// ---------------- 骨骼 ----------------

export interface AddBoneOptions {
  /** 不传就按「父名_child」生成，重名自动加序号 */
  name?: string
  /** 不传就挂到层级根骨骼下 */
  parent?: string
  localPosition?: Vec2
  /** 度 */
  rotation?: number
  /** 骨长，默认 0.4 */
  length?: number
  color?: string
}

export interface AddBoneResult {
  name: string
  parent: string
}

/** 新建一根骨骼。父级默认为层级根骨骼（其他骨骼都必须待在它之下） */
export function addBone(doc: EditorDocument, options: AddBoneOptions = {}): AddBoneResult {
  const parent = options.parent ?? rootBoneName(doc.bones)
  if (options.parent !== undefined && options.parent !== '') requireBone(doc, options.parent, '父骨骼')
  const name = uniqueName(doc.bones.map((bone) => bone.name), options.name?.trim() || (parent ? `${parent}_child` : 'bone'))
  doc.bones.push(
    createAuthoringBone({
      name,
      parent,
      localPosition: options.localPosition ?? { x: 0, y: 0 },
      rotation: options.rotation ?? 0,
      length: options.length ?? 0.4,
      ...(options.color ? { color: options.color } : {})
    })
  )
  return { name, parent }
}

export interface SetBoneTransformOptions {
  bone: string
  /** 换父级（保持全局位置 / 旋转 / 缩放）；空串 = 变成顶层骨骼 */
  parent?: string
  localPosition?: Vec2
  /** 度 */
  rotation?: number
  localScale?: Vec2
  localShear?: Vec2
  length?: number
  color?: string
  locked?: boolean
  hollow?: boolean
  inheritRotation?: boolean
  inheritScale?: boolean
}

/** 一次性写入骨骼的一组属性（只写传了的字段，没传的保持原样） */
export function setBoneTransform(doc: EditorDocument, options: SetBoneTransformOptions): void {
  const bone = requireBone(doc, options.bone, '骨骼')
  if (options.localPosition) bone.localPosition = { ...options.localPosition }
  if (options.rotation !== undefined) bone.rotation = options.rotation
  if (options.localScale) bone.localScale = { ...options.localScale }
  if (options.localShear) bone.localShear = { ...options.localShear }
  if (options.length !== undefined) bone.length = options.length
  if (options.color !== undefined) bone.color = options.color
  if (options.locked !== undefined) bone.locked = options.locked
  if (options.hollow !== undefined) bone.hollow = options.hollow
  if (options.inheritRotation !== undefined) bone.inheritRotation = options.inheritRotation
  if (options.inheritScale !== undefined) bone.inheritScale = options.inheritScale
  /*
   * 换父级必须走 moveBone：它带世界矩阵，能在换父后保持骨骼的全局位姿，
   * 也能挡住「把骨骼拖进自己子孙里」这种会断链的操作。直接改 bone.parent 会把整棵子树瞬移。
   */
  if (options.parent !== undefined) {
    const result = moveBone(doc, bone.name, options.parent, 'inside', { worldMatrixOf: worldMatrixOfBone })
    if (!result.ok) throw new Error(result.message || `换父级失败：${options.parent}`)
  }
}

// ---------------- 插槽 ----------------

export interface AddSlotOptions {
  name?: string
  /** 宿主骨骼；不传就用层级根骨骼 */
  bone?: string
  /** 绘制层序；不传就排到最后 */
  zOrder?: number
  color?: string
  visible?: boolean
  locked?: boolean
}

export interface AddSlotResult {
  name: string
  bone: string
}

/** 新建插槽。插槽必须挂在骨骼上，宿主默认取层级根骨骼 */
export function addSlot(doc: EditorDocument, options: AddSlotOptions = {}): AddSlotResult {
  const bone = options.bone ?? rootBoneName(doc.bones)
  if (!bone) throw new Error('骨架里还没有骨骼，插槽必须挂在骨骼上：先用 addBone 建一根')
  requireBone(doc, bone, '宿主骨骼')
  const name = uniqueName(doc.slots.map((slot) => slot.name), options.name?.trim() || 'slot')
  doc.slots.push(
    createAuthoringSlot({
      name,
      bone,
      zOrder: options.zOrder ?? doc.slots.length,
      ...(options.color ? { color: options.color } : {}),
      ...(options.visible !== undefined ? { visible: options.visible } : {}),
      ...(options.locked !== undefined ? { locked: options.locked } : {})
    })
  )
  /*
   * 附件都活在皮肤里，所以新建插槽必须同时给它开一个空槽位：
   * 不补这一条，之后 addDisplay 就没地方放图（层级树新建插槽也是这么做的）。
   */
  doc.skins[0]?.slots.push({ slot: name, attachments: [] })
  return { name, bone }
}

export interface SetSlotPropsOptions {
  slot: string
  color?: string
  blendMode?: string
  /** setup pose 显示的附件名；空串 = 不显示 */
  attachment?: string
  visible?: boolean
  locked?: boolean
}

/** 写入插槽的非层级属性（换宿主骨骼 / 调层序请用 moveSlot / setSlotOrder，那些要保持全局位姿） */
export function setSlotProps(doc: EditorDocument, options: SetSlotPropsOptions): void {
  const slot = doc.slots.find((item) => item.name === options.slot)
  if (!slot) throw new Error(`插槽不存在：${options.slot}（用 listSlots 查现有插槽名）`)
  if (options.color !== undefined) slot.color = options.color
  if (options.blendMode !== undefined) {
    // 字符串枚举名换成枚举值：AI 记不住数字，直接给 'normal' / 'additive' 更不容易错
    const table = BlendMode as unknown as Record<string, number>
    const mode = table[options.blendMode]
    if (typeof mode !== 'number') {
      const names = Object.keys(table).filter((key) => Number.isNaN(Number(key)))
      throw new Error(`blendMode 不合法：${options.blendMode}（只能是 ${names.join(' / ')}）`)
    }
    slot.blendMode = mode as typeof slot.blendMode
  }
  if (options.attachment !== undefined) slot.attachment = options.attachment
  if (options.visible !== undefined) slot.visible = options.visible
  if (options.locked !== undefined) slot.locked = options.locked
}

/**
 * 换插槽的宿主骨骼，并保持内容的全局位姿。
 *
 * 直接改 `slot.bone` 会让整块内容瞬移（骨骼的坐标系完全不同），
 * 所以必须走 `moveSlot`：它带世界矩阵，会反算出新的局部变换。
 */
export function setSlotHost(doc: EditorDocument, slotName: string, boneName: string): void {
  if (!doc.slots.some((item) => item.name === slotName)) {
    throw new Error(`插槽不存在：${slotName}（用 listSlots 查现有插槽名）`)
  }
  requireBone(doc, boneName, '新宿主骨骼')
  const result = moveSlot(doc, slotName, boneName, null, { worldMatrixOf: worldMatrixOfBone })
  if (!result.ok) throw new Error(result.message || `换宿主失败：${slotName} → ${boneName}`)
}

// ---------------- 约束 ----------------

export interface AddConstraintOptions {
  kind: 'ik' | 'transform' | 'path'
  name?: string
  /** 被驱动的骨链，父 → 子顺序（给反了会自动翻转）；transform / path 只用第一根当宿主 */
  bones?: string[]
  /**
   * 目标骨（IK 的目标 / 变换的来源骨 / 路径骨）。
   * IK 不传时会**自动新建一根 IK 节点骨**摆在链尾末端 —— 目标骨要能独立拖动、打帧，
   * 拿链上的骨骼当目标会让 IK 拉着自己跑。
   */
  target?: string
  /** 自动新建 IK 节点骨时的落点（世界坐标）；不传则摆在链尾末端 */
  nodePosition?: Vec2
  /** 自动新建 IK 节点骨时的名字，默认「链尾_ik」 */
  nodeName?: string
}

export interface AddConstraintResult {
  name: string
  kind: AddConstraintOptions['kind']
  bones: string[]
  target: string
  /** IK 自动新建的节点骨名（没新建就没有这个字段） */
  nodeBone?: string
}

export function addConstraint(doc: EditorDocument, options: AddConstraintOptions): AddConstraintResult {
  const kind = options.kind
  const picked = (options.bones ?? []).filter(Boolean)
  for (const name of picked) requireBone(doc, name, '被驱动骨骼')

  if (kind !== 'ik') {
    // 变换 / 路径的宿主是第一根被驱动骨；来源骨 / 路径骨在属性面板里再选
    const host = picked[0] ?? rootBoneName(doc.bones)
    if (!host) throw new Error('骨架里还没有骨骼：先用 addBone 建一根')
    requireBone(doc, host, '宿主骨骼')
    if (options.target) requireBone(doc, options.target, '目标骨骼')
    const name = uniqueName(doc.constraints.map((item) => item.name), options.name?.trim() || kind)
    const creator = kind === 'transform' ? createTransformConstraint : createPathConstraint
    doc.constraints.push({
      ...creator(),
      name,
      order: doc.constraints.length,
      enabled: true,
      bones: [host],
      target: options.target ?? ''
    })
    return { name, kind, bones: [host], target: options.target ?? '' }
  }

  const chain = asBoneChain(doc, picked)
  if (chain.length === 0) {
    throw new Error(
      picked.length >= 2
        ? `IK 的骨链必须「父 → 子」连续：${picked.join(' / ')} 不构成一条链（顺序给反了会自动翻转）`
        : 'IK 至少需要一根被驱动的骨骼，并且必须是父 → 子连续的链'
    )
  }
  const tail = chain[chain.length - 1]
  let target = options.target ?? ''
  let nodeBone: string | undefined
  if (target) {
    requireBone(doc, target, 'IK 目标骨骼')
  } else {
    const tip = options.nodePosition ?? boneTipWorld(tail, doc.bones.find((b) => b.name === tail)?.length ?? 0) ?? { x: 0, y: 0 }
    nodeBone = uniqueName(doc.bones.map((bone) => bone.name), options.nodeName?.trim() || `${tail}_ik`)
    doc.bones.push(
      createAuthoringBone({
        name: nodeBone,
        parent: rootBoneName(doc.bones),
        localPosition: tip,
        // 零长度：节点骨就是个把手，不需要骨长
        length: 0,
        color: IK_NODE_COLOR
      })
    )
    target = nodeBone
  }
  const name = uniqueName(doc.constraints.map((item) => item.name), options.name?.trim() || kind)
  doc.constraints.push({
    ...createIkConstraint(),
    name,
    order: doc.constraints.length,
    enabled: true,
    bones: chain,
    target
  })
  return { name, kind, bones: chain, target, ...(nodeBone ? { nodeBone } : {}) }
}

// ---------------- 附件（display） ----------------

export interface AddDisplayOptions {
  slot: string
  /** 图片池里的图片名，用 listImages 查 */
  image: string
  /** 附件名，默认取图片名去扩展名；重名自动加序号 */
  name?: string
  position?: Vec2
  /** 目标皮肤，默认当前皮肤 */
  skin?: string
}

/**
 * 往插槽里加一个图片附件。
 *
 * 比 `addImageDisplay` 好用的地方在于：AI 只需要给「插槽名 + 图片名」，
 * 尺寸直接从图片池里取 —— 让 AI 去记每张图的宽高既容易错也没必要。
 */
export function addDisplay(doc: EditorDocument, options: AddDisplayOptions): { slot: string; attachment: string } {
  const image = doc.images.find((item) => item.name === options.image)
  if (!image) throw new Error(`图片不存在：${options.image}（用 listImages 查图片池）`)
  const result = addImageDisplay(doc, {
    image: image.name,
    slot: options.slot,
    width: image.width,
    height: image.height,
    ...(options.position ? { position: options.position } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.skin ? { skin: options.skin } : {})
  })
  // addImageDisplay 返回 null 只有「插槽不存在」这一种可能（图片刚校验过）
  if (!result) throw new Error(`插槽不存在：${options.slot}（用 listSlots 查现有插槽名）`)
  return result
}

/** 删除附件（跨所有皮肤），并顺手清掉 setup pose 对它的引用 */
export function deleteDisplay(doc: EditorDocument, slotName: string, attachmentName: string): void {
  const exists = doc.skins.some((skin) =>
    skin.slots.some((item) => item.slot === slotName && item.attachments.some((a) => a.name === attachmentName))
  )
  if (!exists) throw new Error(`找不到附件：${slotName} / ${attachmentName}（用 listDisplays 查插槽下的附件名）`)
  deleteAttachment(doc, slotName, attachmentName)
  const slot = doc.slots.find((item) => item.name === slotName)
  // setup pose 指着一个已经不存在的附件，渲染时会查不到 —— 清空它
  if (slot && slot.attachment === attachmentName) slot.attachment = ''
}

export interface SetAttachmentTransformOptions {
  slot: string
  attachment: string
  /** 附件在骨骼局部空间的位置 */
  position?: Vec2
  /** 度 */
  rotation?: number
  scale?: Vec2
  /** Region 显示尺寸 */
  size?: Vec2
  color?: string
  /** 换图；Mesh 的顶点不会自动重算，转网格后请重新生成 */
  image?: string
}

/** 一次性写入附件的一组属性（跨所有皮肤同步改，避免同名附件在不同皮肤里不一致） */
export function setAttachmentTransform(doc: EditorDocument, options: SetAttachmentTransformOptions): void {
  if (options.image !== undefined && !doc.images.some((item) => item.name === options.image)) {
    throw new Error(`图片不存在：${options.image}（用 listImages 查图片池）`)
  }
  let hits = 0
  const apply = (attachment: AuthoringAttachment): void => {
    hits++
    if (options.position) attachment.position = { ...options.position }
    if (options.rotation !== undefined) attachment.rotation = options.rotation
    if (options.scale) attachment.scale = { ...options.scale }
    if (options.size) attachment.size = { ...options.size }
    if (options.color !== undefined) attachment.color = options.color
    if (options.image !== undefined) attachment.image = options.image
  }
  patchAttachment(doc, options.slot, options.attachment, apply)
  if (hits === 0) throw new Error(`找不到附件：${options.slot} / ${options.attachment}（用 listDisplays 查插槽下的附件名）`)
}

// ---------------- 动画 ----------------

export interface AddAnimationOptions {
  name?: string
  /** 秒；不传或非正数按 1 秒 */
  duration?: number
  /** 是否顺手切为当前编辑动画，默认 true */
  activate?: boolean
}

export function addAnimation(doc: EditorDocument, options: AddAnimationOptions = {}): { name: string; duration: number } {
  const name = uniqueName(doc.animations.map((anim) => anim.name), options.name?.trim() || 'animation')
  const duration = options.duration && options.duration > 0 ? options.duration : 1
  doc.animations.push(createAuthoringAnim(name, duration))
  if (options.activate !== false) doc.editorMeta.activeAnimation = name
  return { name, duration }
}

export function removeAnimation(doc: EditorDocument, animationName: string): void {
  const index = doc.animations.findIndex((anim) => anim.name === animationName)
  if (index < 0) throw new Error(`动画不存在：${animationName}（用 listAnimations 查现有动画名）`)
  doc.animations.splice(index, 1)
  // 删掉的正好是当前编辑动画：往后顺延一个，没有就退回空串
  if (doc.editorMeta.activeAnimation === animationName) {
    doc.editorMeta.activeAnimation = doc.animations[Math.min(index, doc.animations.length - 1)]?.name ?? ''
  }
}

export function renameAnimation(doc: EditorDocument, animationName: string, nextName: string): { name: string } {
  const anim = doc.animations.find((item) => item.name === animationName)
  if (!anim) throw new Error(`动画不存在：${animationName}（用 listAnimations 查现有动画名）`)
  const next = nextName.trim()
  if (!next) throw new Error('新动画名不能为空')
  if (next !== animationName && doc.animations.some((item) => item.name === next)) {
    throw new Error(`动画名已被占用：${next}`)
  }
  anim.name = next
  if (doc.editorMeta.activeAnimation === animationName) doc.editorMeta.activeAnimation = next
  return { name: next }
}

export function setAnimationDuration(
  doc: EditorDocument,
  animationName: string,
  duration: number
): { name: string; duration: number } {
  const name = animationName || doc.editorMeta.activeAnimation
  const anim = doc.animations.find((item) => item.name === name)
  if (!anim) throw new Error(`动画不存在：${name}（用 listAnimations 查现有动画名）`)
  if (!Number.isFinite(duration) || duration < 0) throw new Error('duration 必须是不小于 0 的数字（单位：秒）')
  anim.duration = duration
  return { name: anim.name, duration: anim.duration }
}

/** 切换当前编辑动画（时间轴与视口会跟着换） */
export function setActiveAnimation(doc: EditorDocument, animationName: string): { name: string } {
  const anim = doc.animations.find((item) => item.name === animationName)
  if (!anim) throw new Error(`动画不存在：${animationName}（用 listAnimations 查现有动画名）`)
  doc.editorMeta.activeAnimation = anim.name
  return { name: anim.name }
}

