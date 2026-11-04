import { invertInto, mulInto, mulPointX, mulPointY, trsInto } from '../math/matrix'
import { AttachmentType } from '../model/types'
import type { AttachmentData, VertexWeight } from '../model/types'
import type { RuntimeAsset } from '../model/asset'
import { setupPoseOf } from '../model/setup'
import type { AnimData, ConstraintAnim } from '../model/animation'
import { emptyConstraintAnim, emptyFloatKeyframe } from '../model/animation'
import type { Constraint } from '../model/constraints'
import { rgbaToHex } from '../util/color'
import type {
  AuthoringAnimData,
  AuthoringAttachment,
  AuthoringAttachmentType,
  AuthoringBone,
  AuthoringConstraint,
  AuthoringSkin,
  AuthoringSlot,
  AuthoringVertex,
  EditorDocument
} from '../model/authoring'
import { CURRENT_SCHEMA_VERSION, createDefaultMeta } from '../model/authoring'

const LOCAL_M = new Float32Array(16)
const ATTA_M = new Float32Array(16)
const INV_M = new Float32Array(16)

function attachmentTypeOf(type: AttachmentType): AuthoringAttachmentType {
  if (type === AttachmentType.Mesh) return 'mesh'
  if (type === AttachmentType.LinkedMesh) return 'linkedmesh'
  if (type === AttachmentType.BoundingBox) return 'boundingbox'
  if (type === AttachmentType.Clipping) return 'clipping'
  if (type === AttachmentType.Armature) return 'armature'
  return 'region'
}

/**
 * 附件反编译：把 top-4 打包权重还原成「显示空间顶点 + 名字引用的稀疏权重」。
 *   vBind = Σ w_k · setupWorld[b_k] · L_k
 *   v     = inverse(setupWorld[slotBone] · TRS(att)) · vBind
 */
function decompileAttachment(
  attachment: AttachmentData,
  slotBoneIndex: number,
  asset: RuntimeAsset
): AuthoringAttachment {
  const setup = setupPoseOf(asset)
  const count = Math.floor(attachment.vertices.length / 2)
  const weighted = attachment.weights.length === count && count > 0

  const vertices: AuthoringVertex[] = []
  if (weighted) {
    trsInto(ATTA_M, attachment.position.x, attachment.position.y, attachment.rotation, attachment.scale.x, attachment.scale.y)
    if (slotBoneIndex >= 0) {
      mulInto(LOCAL_M, setup.world.subarray(slotBoneIndex * 16, slotBoneIndex * 16 + 16), ATTA_M)
    } else {
      LOCAL_M.set(ATTA_M)
    }
    invertInto(INV_M, LOCAL_M)

    for (let i = 0; i < count; i++) {
      const w = attachment.weights[i]
      // 绑定空间位置
      let bindX = 0
      let bindY = 0
      const contributions: Array<{ bone: number; weight: number; lx: number; ly: number }> = [
        { bone: w.b0, weight: w.w0, lx: w.lx0, ly: w.ly0 },
        { bone: w.b1, weight: w.w1, lx: w.lx1, ly: w.ly1 },
        { bone: w.b2, weight: w.w2, lx: w.lx2, ly: w.ly2 },
        { bone: w.b3, weight: w.w3, lx: w.lx3, ly: w.ly3 }
      ]
      for (const entry of contributions) {
        if (entry.weight === 0) continue
        const o = entry.bone * 16
        bindX += entry.weight * (setup.world[o] * entry.lx + setup.world[o + 4] * entry.ly + setup.world[o + 12])
        bindY += entry.weight * (setup.world[o + 1] * entry.lx + setup.world[o + 5] * entry.ly + setup.world[o + 13])
      }
      vertices.push({
        x: mulPointX(INV_M, bindX, bindY),
        y: mulPointY(INV_M, bindX, bindY),
        weights: contributions
          .filter((entry) => entry.weight > 1e-6)
          .map((entry) => ({
            bone: asset.bones[entry.bone]?.name ?? '',
            weight: entry.weight
          }))
          .filter((entry) => entry.bone !== '')
      })
    }
  } else {
    for (let i = 0; i < count; i++) {
      vertices.push({ x: attachment.vertices[i * 2], y: attachment.vertices[i * 2 + 1], weights: [] })
    }
  }

  return {
    name: attachment.name,
    type: attachmentTypeOf(attachment.type),
    image: attachment.textureName,
    regionName: attachment.regionName,
    position: { ...attachment.position },
    rotation: attachment.rotation,
    scale: { ...attachment.scale },
    size: { ...attachment.size },
    // 原图（含裁剪留白）尺寸与内容偏移：编辑器画框 / 渲染局部偏移都要
    frameSize: { ...attachment.frameSize },
    contentOffset: { ...attachment.contentOffset },
    color: rgbaToHex(attachment.color),
    vertices,
    uvs: Array.from(attachment.uvs),
    triangles: [...attachment.triangles],
    edges: [...attachment.edges],
    hull: attachment.hull,
    ffdInBoneSpace: attachment.ffdInBoneSpace,
    linkedMeshSkin: attachment.linkedMeshSkin,
    linkedMeshAttachment: attachment.linkedMeshAttachment,
    clipEndSlot: attachment.clipEndSlot,
    clipInverse: attachment.clipInverse,
    clipConvex: attachment.clipConvex,
    // 嵌套骨架：DB 导入后必须原样带回，否则重新打开工程就丢了引用
    subArmature: attachment.subArmature,
    subAnimation: attachment.subAnimation,
    subPlayTimes: attachment.subPlayTimes,
    subOffset: attachment.subOffset,
    subSpeed: attachment.subSpeed
  }
}

function decompileConstraint(constraint: Constraint, asset: RuntimeAsset): AuthoringConstraint {
  const bones = constraint.boneIndices.map((index) => asset.bones[index]?.name ?? '').filter((name) => name !== '')
  const target = constraint.targetBoneIndex >= 0 ? asset.bones[constraint.targetBoneIndex]?.name ?? '' : ''
  return { ...constraint, bones, target } as AuthoringConstraint
}

function decompileAnim(anim: AnimData, asset: RuntimeAsset, constraints: Constraint[]): AuthoringAnimData {
  const boneName = (index: number): string => asset.bones[index]?.name ?? ''
  const slotName = (index: number): string => asset.slots[index]?.name ?? ''

  const constraintTracks: ConstraintAnim[] = [...anim.constraints]
  // Unity 端 Hao2D 运行时风格的 iks 轨道：若没有对应的约束轨道则合成一条
  const ikIndices = constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.type === 'ik')
    .map((entry) => entry.i)
  for (const ik of anim.iks) {
    const index = ikIndices[ik.ikIndex]
    if (index === undefined) continue
    if (constraintTracks.some((track) => track.constraintIndex === index)) continue
    constraintTracks.push({ ...emptyConstraintAnim(index), mix: ik.mix })
  }

  // 物理 / 滑块轨道：运行期是独立段，作者态合并回同一条「约束轨道」列表
  const physicsIndices = constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.type === 'physics')
    .map((entry) => entry.i)

  for (const track of anim.physics ?? []) {
    const index = physicsIndices[track.physicsIndex]
    if (index === undefined) continue
    constraintTracks.push({
      ...emptyConstraintAnim(index),
      constraintIndex: index,
      reset: track.reset.map((time) => emptyFloatKeyframe(time, 1)),
      inertia: track.inertia,
      strength: track.strength,
      damping: track.damping,
      mass: track.mass,
      wind: track.wind,
      gravity: track.gravity,
      mix: track.mix
    })
  }


  return {
    name: anim.name,
    duration: anim.duration,
    bones: anim.bones.map((track) => ({
      bone: boneName(track.boneIndex),
      translate: track.translate,
      rotate: track.rotate,
      scale: track.scale,
      shear: track.shear
    })),
    slots: anim.slots.map((track) => ({
      slot: slotName(track.slotIndex),
      color: track.color,
      displayIndex: track.displayIndex,
      displayAttachment: track.displayAttachment,
      visible: track.visible,
      subArmature: track.subArmature ?? []
    })),
    deforms: anim.deforms.map((track) => ({
      slot: slotName(track.slotIndex),
      attachment: track.attachmentName,
      // 皮肤归属：只在有值时写出，避免给旧工程凭空加字段
      ...(track.skin ? { skin: track.skin } : {}),
      frames: track.frames
    })),
    drawOrder: anim.drawOrder.map((key) => ({
      time: key.time,
      order: key.order.map((index) => slotName(index))
    })),
    events: anim.events,
    constraints: constraintTracks.map((track) => ({
      ...track,
      constraint: constraints[track.constraintIndex]?.name ?? ''
    })),
    // 全局物理轨道：运行期是独立结构，作者态原样带回
    ...(anim.physicsGlobal ? { physicsGlobal: { ...anim.physicsGlobal } } : {})
  }
}

/** Runtime 模型 → Authoring 工程模型（导入后转为可编辑形态） */
export function decompileAsset(asset: RuntimeAsset, activeSkin = ''): EditorDocument {
  const bones: AuthoringBone[] = asset.bones.map((bone) => ({
    name: bone.name,
    parent: bone.parentIndex >= 0 ? asset.bones[bone.parentIndex]?.name ?? '' : '',
    localPosition: { ...bone.localPosition },
    rotation: bone.rotation,
    localScale: { ...bone.localScale },
    localShear: { ...bone.localShear },
    inheritRotation: bone.inheritRotation,
    inheritScale: bone.inheritScale,
    length: bone.length,
    color: '#F97316',
    locked: false
  }))

  const skins: AuthoringSkin[] = asset.skins.map((skin) => ({
    name: skin.name,
    slots: skin.slots.map((slot) => ({
      slot: slot.slotName,
      attachments: slot.attachments.map((attachment) =>
        decompileAttachment(attachment, asset.slots.find((s) => s.name === slot.slotName)?.boneIndex ?? -1, asset)
      )
    }))
  }))

  const slots: AuthoringSlot[] = asset.slots.map((slot) => ({
    name: slot.name,
    bone: asset.bones[slot.boneIndex]?.name ?? '',
    color: rgbaToHex(slot.color),
    blendMode: slot.blendMode,
    // 用运行时里保存的 defaultZOrder（导入时来自 DB 的 slot[].z / Spine 的声明下标），
    // 而不是数组下标：compile 侧按它排序固化层序，写死下标等于把 DB 的层级信息丢掉。
    zOrder: slot.defaultZOrder,
    z: slot.z,
    attachment: slot.setupAttachment,
    // 还原插槽隐藏状态（层级树眼睛）；资产上没有该字段时（旧格式）按可见处理
    visible: slot.visible !== false,
    locked: false
  }))

  const constraints = asset.constraints.map((constraint) => decompileConstraint(constraint, asset))

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    armatureName: asset.armatureName,
    frameRate: asset.frameRate,
    runtimeIK: asset.runtimeIK,
    bones,
    slots,
    skins,
    constraints,
    animations: asset.animations.map((anim) => decompileAnim(anim, asset, asset.constraints)),
    images: asset.images.map((image) => ({
      name: image.name,
      path: image.path,
      width: image.width,
      height: image.height,
      loose: image.loose ?? false,
      regions: image.regions
    })),
    editorMeta: {
      ...createDefaultMeta(),
      // 导出时编辑器正在编辑的皮肤（叠加皮肤）：重新导入时回到同一个皮肤
      activeSkin: asset.defaultSkin ?? ''
    }
  }
}

export type { VertexWeight }
