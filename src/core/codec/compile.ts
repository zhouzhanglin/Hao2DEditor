import { mulInto, mulPointX, mulPointY, trsInto } from '../math/matrix'
import { createBoneData, createAttachmentData, AttachmentType, AnimType } from '../model/types'
import type { BoneData, ImageRef, SkinData, SlotData, VertexWeight } from '../model/types'
import { createRuntimeAsset } from '../model/asset'
import type { RuntimeAsset } from '../model/asset'
import { computeBindposes, createSetupPose } from '../model/setup'
import type { AnimData, BoneAnim, ConstraintAnim, DeformAnim, DrawOrderKeyframe, IkAnim, SlotAnim } from '../model/animation'
import { emptyConstraintAnim } from '../model/animation'
import type { Constraint, IkConstraint } from '../model/constraints'
import {
  createIkConstraint,
  createPathConstraint,
  createPhysicsConstraint,
  createTransformConstraint
} from '../model/constraints'
import { hexToRgba } from '../util/color'
import { lastKeyTime } from '../model/authoring'
import type { AuthoringAnimData, AuthoringAttachment, AuthoringBone, AuthoringConstraint, EditorDocument } from '../model/authoring'

export interface CompileResult {
  asset: RuntimeAsset
  warnings: string[]
  boneIndex: Record<string, number>
  slotIndex: Record<string, number>
  constraintIndex: Record<string, number>
}

const LOCAL_M = new Float32Array(16)
const ATTA_M = new Float32Array(16)

/** 默认 Region 四角 UV：左下(0,0) 右下(1,0) 右上(1,1) 左上(0,1) */
const DEFAULT_UVS = [0, 0, 1, 0, 1, 1, 0, 1]

/**
 * 按父链拓扑排序骨骼（父在子之前）。
 * 出现环或父骨骼缺失时给出告警并把剩余骨骼按原顺序追加，保证不丢数据。
 */
export function topologicalBones(doc: EditorDocument): {
  ordered: AuthoringBone[]
  index: Map<string, number>
  warnings: string[]
} {
  const warnings: string[] = []
  const byName = new Map<string, AuthoringBone>()
  for (const bone of doc.bones) {
    if (byName.has(bone.name)) warnings.push(`存在重名骨骼「${bone.name}」，仅保留第一个`)
    else byName.set(bone.name, bone)
  }

  const ordered: AuthoringBone[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (bone: AuthoringBone): void => {
    if (visited.has(bone.name)) return
    if (visiting.has(bone.name)) {
      warnings.push(`骨骼「${bone.name}」的父链存在环，已按原顺序处理`)
      return
    }
    visiting.add(bone.name)
    if (bone.parent) {
      const parent = byName.get(bone.parent)
      if (!parent) warnings.push(`骨骼「${bone.name}」的父骨骼「${bone.parent}」不存在，已作为根骨骼`)
      else visit(parent)
    }
    visiting.delete(bone.name)
    if (!visited.has(bone.name)) {
      visited.add(bone.name)
      ordered.push(bone)
    }
  }

  for (const bone of doc.bones) visit(bone)

  const index = new Map<string, number>()
  ordered.forEach((bone, i) => index.set(bone.name, i))
  return { ordered, index, warnings }
}

function toBoneData(bones: AuthoringBone[], index: Map<string, number>): BoneData[] {
  return bones.map((bone) =>
    createBoneData({
      name: bone.name,
      parentIndex: bone.parent ? (index.get(bone.parent) ?? -1) : -1,
      localPosition: { ...bone.localPosition },
      rotation: bone.rotation,
      localScale: { ...bone.localScale },
      localShear: { ...bone.localShear },
      inheritRotation: bone.inheritRotation,
      inheritScale: bone.inheritScale,
      length: bone.length
    })
  )
}

/**
 * 插槽按 zOrder 排序后写进 Runtime：参考库的 drawOrder 默认就是插槽数组顺序
 * （SetToSetupPose 里 drawOrder[i] = i），因此层序必须在编译期固化。
 */
function toSlotData(
  doc: EditorDocument,
  boneIndex: Map<string, number>
): { slots: SlotData[]; index: Record<string, number>; warnings: string[] } {
  const warnings: string[] = []
  const sorted = doc.slots
    .map((slot, order) => ({ slot, order }))
    .sort((a, b) => a.slot.zOrder - b.slot.zOrder || a.order - b.order)

  const slots: SlotData[] = []
  const index: Record<string, number> = {}
  sorted.forEach(({ slot }, i) => {
    const bone = boneIndex.get(slot.bone)
    if (bone === undefined) warnings.push(`插槽「${slot.name}」挂载的骨骼「${slot.bone}」不存在，已挂到根骨骼`)
    index[slot.name] = i
    slots.push({
      name: slot.name,
      boneIndex: bone ?? 0,
      color: hexToRgba(slot.color),
      blendMode: slot.blendMode,
      defaultDisplayIndex: -1,
      defaultZOrder: i,
      z: slot.z,
      setupAttachment: slot.attachment,
      // 层级树眼睛的开关值：骨架的 setup 可见性从这里来（见 Skeleton.setupVisibleAt）
      visible: slot.visible
    })
  })
  return { slots, index, warnings }
}

/** 权重按 top-4 归并并归一化 */
function normalizeWeights(
  weights: Array<{ bone: string; weight: number }>,
  boneIndex: Map<string, number>
): Array<{ index: number; weight: number }> {
  const merged = new Map<number, number>()
  for (const entry of weights) {
    const index = boneIndex.get(entry.bone)
    if (index === undefined) continue
    merged.set(index, (merged.get(index) ?? 0) + entry.weight)
  }
  const list = [...merged.entries()]
    .map(([index, weight]) => ({ index, weight }))
    .filter((entry) => entry.weight > 1e-6)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
  const total = list.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 1e-8) return []
  return list.map((entry) => ({ index: entry.index, weight: entry.weight / total }))
}

interface AttachmentContext {
  slotBoneIndex: number
  bindposes: Float32Array
  /** 骨骼 setup 世界矩阵（长度 16n，列主序） */
  setupWorld: Float32Array
  boneIndex: Map<string, number>
  warnings: string[]
}

/**
 * 附件编译。加权网格的每骨骼局部坐标由「绑定空间顶点」反算：
 *   vBind = setupWorld[slotBone] · TRS(att) · v
 *   L_k   = inverse(setupWorld[b_k]) · vBind = bindposes[b_k] · vBind
 * 运行期再按 Σ w_k · worldMatrices[b_k] · L_k 还原，与参考库 skinned 路径一致。
 * 无权重（刚体 / Region）的顶点直接存附件显示空间。
 */
function convertAttachment(att: AuthoringAttachment, ctx: AttachmentContext): ReturnType<typeof createAttachmentData> {
  const type =
    att.type === 'mesh'
      ? AttachmentType.Mesh
      : att.type === 'linkedmesh'
        ? AttachmentType.LinkedMesh
        : att.type === 'boundingbox'
          ? AttachmentType.BoundingBox
          : att.type === 'clipping'
            ? AttachmentType.Clipping
            : AttachmentType.Region

  const isClipping = att.type === 'clipping'
  const uvs = att.uvs.length > 0 ? Float32Array.from(att.uvs) : Float32Array.from(DEFAULT_UVS)
  const hasWeights = att.vertices.some((v) => v.weights.length > 0)
  const vertices = new Float32Array(att.vertices.length * 2)
  const weights: VertexWeight[] = []

  for (let i = 0; i < att.vertices.length; i++) {
    vertices[i * 2] = att.vertices[i].x
    vertices[i * 2 + 1] = att.vertices[i].y
  }

  if (hasWeights && att.vertices.length > 0) {
    trsInto(ATTA_M, att.position.x, att.position.y, att.rotation, att.scale.x, att.scale.y)
    const slotBone = ctx.slotBoneIndex
    if (slotBone >= 0) {
      mulInto(LOCAL_M, ctx.setupWorld.subarray(slotBone * 16, slotBone * 16 + 16), ATTA_M)
    } else {
      LOCAL_M.set(ATTA_M)
    }
    for (let i = 0; i < att.vertices.length; i++) {
      const vertex = att.vertices[i]
      const packed = normalizeWeights(vertex.weights, ctx.boneIndex)
      const use = packed.length > 0 ? packed : [{ index: slotBone >= 0 ? slotBone : 0, weight: 1 }]
      const bindX = mulPointX(LOCAL_M, vertex.x, vertex.y)
      const bindY = mulPointY(LOCAL_M, vertex.x, vertex.y)
      weights.push(packVertex(use, ctx.bindposes, bindX, bindY))
    }
  }

  return createAttachmentData({
    name: att.name,
    type,
    // 遮罩顶点是插槽骨骼局部坐标（与 Spine 一致），附件自身 TRS 必须保持单位阵
    position: isClipping ? { x: 0, y: 0 } : { ...att.position },
    rotation: isClipping ? 0 : att.rotation,
    scale: isClipping ? { x: 1, y: 1 } : { ...att.scale },
    size: { ...att.size },
    // 原图信息给编辑器画框用；内容偏移给渲染在附件局部坐标里叠加
    frameSize: { ...(att.frameSize ?? { x: 0, y: 0 }) },
    contentOffset: { ...(att.contentOffset ?? { x: 0, y: 0 }) },
    color: hexToRgba(att.color),
    textureName: att.image,
    regionName: att.regionName,
    uvs,
    vertices,
    triangles: [...att.triangles],
    edges: [...att.edges],
    hull: att.hull,
    weights,
    ffdInBoneSpace: att.ffdInBoneSpace,
    linkedMeshSkin: att.linkedMeshSkin,
    linkedMeshAttachment: att.linkedMeshAttachment,
    clipEndSlot: att.clipEndSlot ?? '',
    clipInverse: att.clipInverse ?? false,
    clipConvex: att.clipConvex ?? false
  })
}

function packVertex(
  packed: Array<{ index: number; weight: number }>,
  bindposes: Float32Array,
  bindX: number,
  bindY: number
): VertexWeight {
  const bones = [0, 0, 0, 0]
  const lx = [0, 0, 0, 0]
  const ly = [0, 0, 0, 0]
  const ws = [0, 0, 0, 0]
  const boneCount = Math.max(1, Math.floor(bindposes.length / 16))

  for (let k = 0; k < packed.length && k < 4; k++) {
    const raw = packed[k].index
    const bone = raw < 0 ? 0 : raw >= boneCount ? boneCount - 1 : raw
    const o = bone * 16
    bones[k] = bone
    lx[k] = bindposes[o] * bindX + bindposes[o + 4] * bindY + bindposes[o + 12]
    ly[k] = bindposes[o + 1] * bindX + bindposes[o + 5] * bindY + bindposes[o + 13]
    ws[k] = packed[k].weight
  }

  return {
    b0: bones[0],
    b1: bones[1],
    b2: bones[2],
    b3: bones[3],
    lx0: lx[0],
    ly0: ly[0],
    lx1: lx[1],
    ly1: ly[1],
    lx2: lx[2],
    ly2: ly[2],
    lx3: lx[3],
    ly3: ly[3],
    w0: ws[0],
    w1: ws[1],
    w2: ws[2],
    w3: ws[3]
  }
}

function buildSkins(
  doc: EditorDocument,
  boneIndex: Map<string, number>,
  slotBoneOfName: Map<string, number>,
  bindposes: Float32Array,
  setupWorld: Float32Array,
  warnings: string[]
): SkinData[] {
  return doc.skins.map((skin) => ({
    name: skin.name,
    slots: skin.slots.map((skinSlot) => ({
      slotName: skinSlot.slot,
      attachments: skinSlot.attachments.map((attachment) =>
        convertAttachment(attachment, {
          slotBoneIndex: slotBoneOfName.get(skinSlot.slot) ?? -1,
          bindposes,
          setupWorld,
          boneIndex,
          warnings
        })
      )
    }))
  }))
}

/**
 * 遮罩数据校验：结束插槽必须存在、多边形至少 3 点、反向必须按凸形处理。
 * 这些错误不会让编译失败（宁可少裁也不要整只角色消失），但必须让用户看见。
 */
function validateClipping(skins: SkinData[], slotIndex: Record<string, number>, warnings: string[]): void {
  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.Clipping) continue
        if (attachment.clipInverse && !attachment.clipConvex) {
          // Spine 的反向裁剪只支持凸形；直接在编译产物里改正，渲染/导出用同一份数据
          attachment.clipConvex = true
        }
        if (attachment.clipEndSlot && slotIndex[attachment.clipEndSlot] === undefined) {
          warnings.push(`遮罩「${attachment.name}」的结束插槽「${attachment.clipEndSlot}」不存在，已改为裁到末尾`)
          attachment.clipEndSlot = ''
        }
        if (attachment.vertices.length < 6) {
          warnings.push(`遮罩「${attachment.name}」少于 3 个控制点，不会生效`)
        }
      }
    }
  }
}

function collectTextures(doc: EditorDocument, skins: SkinData[]): string[] {
  const used: string[] = []
  for (const skin of skins) {
    for (const slot of skin.slots) {
      for (const attachment of slot.attachments) {
        if (attachment.textureName && !used.includes(attachment.textureName)) {
          used.push(attachment.textureName)
        }
      }
    }
  }
  const ordered = doc.images.map((image) => image.name).filter((name) => used.includes(name))
  for (const name of used) if (!ordered.includes(name)) ordered.push(name)
  return ordered
}

/** 名字引用 → 下标引用；无效骨骼被丢弃并记录告警 */
function compileConstraints(
  doc: EditorDocument,
  boneIndex: Map<string, number>
): { constraints: Constraint[]; index: Record<string, number>; warnings: string[] } {
  const warnings: string[] = []
  const index: Record<string, number> = {}
  const constraints: Constraint[] = []

  for (const item of doc.constraints) {
    const bones = item.bones.map((name) => boneIndex.get(name)).filter((v): v is number => v !== undefined)
    if (bones.length !== item.bones.length) warnings.push(`约束「${item.name}」引用了不存在的骨骼，已忽略`)
    if (bones.length === 0) {
      warnings.push(`约束「${item.name}」没有有效骨骼链，已跳过`)
      continue
    }
    const target = item.target ? (boneIndex.get(item.target) ?? -1) : -1
    /*
     * IK 求解必须有目标（求解器拿到 -1 会直接返回，约束等于不存在），
     * 而「配好链、忘了选目标」正是最容易踩的一步：这里明确告警，别让它静默失效。
     */
    if (item.type === 'ik') {
      if (item.target && target === -1) warnings.push(`IK 约束「${item.name}」的目标骨骼不存在，不会生效`)
      else if (!item.target) warnings.push(`IK 约束「${item.name}」没有目标骨骼，不会生效`)
    }
    index[item.name] = constraints.length

    if (item.type === 'ik') {
      constraints.push(createIkConstraint({ ...item, boneIndices: bones, targetBoneIndex: target }))
    } else if (item.type === 'transform') {
      constraints.push(createTransformConstraint({ ...item, boneIndices: bones, targetBoneIndex: target }))
    } else if (item.type === 'path') {
      constraints.push(createPathConstraint({ ...item, boneIndices: bones, targetBoneIndex: target }))
    } else {
      constraints.push(createPhysicsConstraint({ ...item, boneIndices: bones, targetBoneIndex: target }))
    }
  }
  return { constraints, index, warnings }
}

function compileAnimations(
  anim: AuthoringAnimData,
  boneIndex: Map<string, number>,
  slotIndex: Record<string, number>,
  /** 实际插槽数量（不能用 slotIndex 的 key 数：重名插槽会被覆盖，导致数量偏小） */
  slotCount: number,
  constraintIndex: Record<string, number>,
  constraints: Constraint[],
  ikIndices: number[],
  warnings: string[]
): AnimData {
  const bones = anim.bones
    .filter((track) => {
      const ok = boneIndex.has(track.bone)
      if (!ok) warnings.push(`动画「${anim.name}」的骨骼轨道「${track.bone}」不存在，已忽略`)
      return ok
    })
    .map<BoneAnim>((track) => ({
      boneIndex: boneIndex.get(track.bone) as number,
      translate: track.translate,
      rotate: track.rotate,
      scale: track.scale,
      shear: track.shear
    }))

  const slots = anim.slots
    .filter((track) => {
      const ok = slotIndex[track.slot] !== undefined
      if (!ok) warnings.push(`动画「${anim.name}」的插槽轨道「${track.slot}」不存在，已忽略`)
      return ok
    })
    .map<SlotAnim>((track) => ({
      slotIndex: slotIndex[track.slot],
      color: track.color,
      displayIndex: track.displayIndex,
      displayAttachment: track.displayAttachment,
      visible: track.visible
    }))

  const deforms = anim.deforms
    .filter((track) => {
      const ok = slotIndex[track.slot] !== undefined
      if (!ok) warnings.push(`动画「${anim.name}」的 FFD 轨道「${track.slot}」不存在，已忽略`)
      return ok
    })
    .map<DeformAnim>((track) => ({
      slotIndex: slotIndex[track.slot],
      attachmentName: track.attachment,
      // 深拷贝帧与 offsets：编译期要把「骨内 FFD」换算成显示空间（normalizeBoneSpaceFfd），
      // 若直接引用工程数据会**原地改到 document**——每次重建都再换算一次，偏移被反复
      // 变换而彻底错乱。compile 必须是纯的。
      frames: track.frames.map((frame) => ({ ...frame, offsets: [...frame.offsets] }))
    }))

  // 绘制顺序帧必须是**完整排列**。曾经直接 map + filter 丢掉解析不到的名字，
  // 数组一旦变短，运行期就只覆盖前 N 个槽、尾部留着上一次的顺序 ——
  // 表现为「动画走到层级变化处，有的图被画两次、有的图直接不显示」。
  // 这里统一归一化：帧里有的顺序优先，重复的丢掉，缺的按 setup 顺序补到末尾。
  const drawOrder = anim.drawOrder.map<DrawOrderKeyframe>((key) => ({
    time: key.time,
    order: normalizeDrawOrder(key.order, slotIndex, slotCount)
  }))

  const constraintTracks: ConstraintAnim[] = []
  const iks: IkAnim[] = []
  for (const track of anim.constraints) {
    const index = constraintIndex[track.constraint]
    if (index === undefined) {
      warnings.push(`动画「${anim.name}」的约束轨道「${track.constraint}」不存在，已忽略`)
      continue
    }
    constraintTracks.push({ ...emptyConstraintAnim(index), ...track, constraintIndex: index })
    // 同步产出参考库风格的 iks 轨道（.hao2d v5 只认这一份）
    if (constraints[index]?.type === 'ik' && track.mix.length > 0) {
      const ikOrder = ikIndices.indexOf(index)
      if (ikOrder >= 0) iks.push({ ikIndex: ikOrder, mix: track.mix })
    }
  }

  // 运行时 / 导出的长度按最后一个关键帧算：duration 字段是编辑期的「可编辑范围」，
  // 可能被用户留得更长（方便往后加帧），不应带进播放与导出
  const keyTime = lastKeyTime(anim)
  return {
    name: anim.name,
    duration: keyTime > 0 ? keyTime : anim.duration,
    bones,
    slots,
    deforms,
    drawOrder,
    events: anim.events,
    iks,
    constraints: constraintTracks
  }
}

/**
 * Authoring 工程模型 → Runtime 模型。
 * 骨骼做拓扑排序、插槽按 zOrder 排序，动画与约束的名字引用换算成下标。
 */
/**
 * 绘制顺序帧归一化：补成**完整排列**。
 *
 * 帧里已写下的顺序优先（重复的丢掉），解析不到的名字忽略，
 * 缺失的槽按 setup 顺序补到末尾 —— 运行期要求 order 覆盖全部槽位。
 */
function normalizeDrawOrder(
  order: readonly string[],
  slotIndex: Record<string, number>,
  total: number
): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const name of order) {
    const index = slotIndex[name]
    if (index === undefined || index < 0 || index >= total || seen.has(index)) continue
    seen.add(index)
    out.push(index)
  }
  for (let i = 0; i < total; i++) if (!seen.has(i)) out.push(i)
  return out
}

export function compileDocument(doc: EditorDocument): CompileResult {
  const warnings: string[] = []
  const { ordered, index, warnings: boneWarnings } = topologicalBones(doc)
  warnings.push(...boneWarnings)

  const bones = toBoneData(ordered, index)
  const { slots, index: slotIndex, warnings: slotWarnings } = toSlotData(doc, index)
  warnings.push(...slotWarnings)

  const slotBoneOfName = new Map<string, number>()
  for (const slot of doc.slots) {
    const bone = index.get(slot.bone)
    if (bone !== undefined) slotBoneOfName.set(slot.name, bone)
  }

  const { constraints, index: constraintIndex, warnings: constraintWarnings } = compileConstraints(doc, index)
  warnings.push(...constraintWarnings)
  const ikIndices = constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.type === 'ik')
    .map((entry) => entry.i)

  // 先算 setup pose，再据此推导 bindposes，最后编译附件权重
  const skeletonOnly = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: doc.armatureName,
    frameRate: doc.frameRate,
    bones,
    slots,
    skins: [],
    constraints,
    animations: [],
    textureNames: [],
    defaultSkinIndex: 0,
    runtimeIK: doc.runtimeIK,
    images: []
  })
  const setup = createSetupPose(skeletonOnly)
  const bindposes = computeBindposes(skeletonOnly)

  const skins = buildSkins(doc, index, slotBoneOfName, bindposes, setup.world, warnings)
  validateClipping(skins, slotIndex, warnings)
  const textureNames = collectTextures(doc, skins)
  const images: ImageRef[] = doc.images.map((image) => ({
    name: image.name,
    path: image.path,
    width: image.width,
    height: image.height
  }))

  const animations = doc.animations.map((anim) =>
    compileAnimations(anim, index, slotIndex, slots.length, constraintIndex, constraints, ikIndices, warnings)
  )

  const defaultSkinIndex = Math.max(
    0,
    skins.findIndex((s) => s.name === 'default')
  )

  const asset = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: doc.armatureName,
    frameRate: doc.frameRate,
    bones,
    slots,
    skins,
    constraints,
    animations,
    textureNames,
    defaultSkinIndex,
    runtimeIK: doc.runtimeIK,
    images
  })
  asset.bindposes = bindposes
  // Unity 侧对「骨内 FFD」没有一致行为（跳过 / 多乘一次 bindpose），统一换算成显示空间
  normalizeBoneSpaceFfd(asset, bindposes, slotIndex, warnings)

  return {
    asset,
    warnings,
    boneIndex: Object.fromEntries(index),
    slotIndex,
    constraintIndex
  }
}

/**
 * 归一化「骨内 FFD」：把 offsets 换算成**显示空间**，并清掉 `ffdInBoneSpace` 标记。
 *
 * 标记为骨内空间时参考库（Unity）没有一致行为 —— 纯 C# 路径**直接跳过**该 FFD，
 * Burst 路径**忽略标记**再多乘一次 bindpose，偏移被多旋转 / 缩放一次（网格被拉飞）。
 * 编辑器自己的 FFD 工具写的本来就是显示空间，只有导入数据或手动开关会标成 true。
 *
 * 换算取每个顶点**权重最大的骨骼**的 bindpose 线性部分求逆：
 *   ffd_new = inv(linear(bindpose[b0])) · ffd_old
 * 于是编辑器（`local += bindpose · ffd_new`）与 Unity 各路径算出的位移都等于原来的
 * `ffd_old`，表现完全一致（单骨骼权重时精确）。
 */
function normalizeBoneSpaceFfd(
  asset: RuntimeAsset,
  bindposes: Float32Array,
  slotIndex: Record<string, number>,
  warnings: string[]
): void {
  type Mat2 = { a: number; b: number; c: number; d: number }
  const inverseOf = new Map<string, Array<Mat2 | null>>()
  const keyOf = (index: number, name: string): string => `${index}|${name}`

  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      const index = slotIndex[skinSlot.slotName]
      if (index === undefined) continue
      for (const attachment of skinSlot.attachments) {
        if (!attachment.ffdInBoneSpace) continue
        if (attachment.type !== AttachmentType.Mesh || attachment.vertices.length === 0) continue

        const count = Math.floor(attachment.vertices.length / 2)
        const list: Array<Mat2 | null> = []
        let degenerate = false
        for (let i = 0; i < count; i++) {
          const bone = attachment.weights[i]?.b0 ?? 0
          const o = bone * 16
          // bindpose 是列主序 4×4：线性部分为 [0],[1] 与 [4],[5]
          const a = bindposes[o] ?? 1
          const c = bindposes[o + 1] ?? 0
          const b = bindposes[o + 4] ?? 0
          const d = bindposes[o + 5] ?? 1
          const det = a * d - b * c
          if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
            list.push(null)
            degenerate = true
            continue
          }
          list.push({ a: d / det, b: -b / det, c: -c / det, d: a / det })
        }
        inverseOf.set(keyOf(index, attachment.name), list)
        attachment.ffdInBoneSpace = false
        if (degenerate) {
          warnings.push(`网格「${attachment.name}」有顶点的 bindpose 退化，这部分 FFD 偏移按原值导出`)
        }
      }
    }
  }

  if (inverseOf.size === 0) return

  for (const anim of asset.animations) {
    for (const track of anim.deforms) {
      const list = inverseOf.get(keyOf(track.slotIndex, track.attachmentName))
      if (!list) continue
      for (const frame of track.frames) {
        // 只处理整段偏移（vertexOffset = 0，编辑器恒为 0）
        if (frame.vertexOffset !== 0) continue
        const offsets = frame.offsets
        const count = Math.min(list.length, Math.floor(offsets.length / 2))
        for (let i = 0; i < count; i++) {
          const inv = list[i]
          if (!inv) continue
          const x = offsets[i * 2]
          const y = offsets[i * 2 + 1]
          offsets[i * 2] = inv.a * x + inv.b * y
          offsets[i * 2 + 1] = inv.c * x + inv.d * y
        }
      }
    }
  }
}

export type { IkConstraint }
