import { ByteWriter } from './binary'
import { AnimType, AttachmentType } from '../model/types'
import type { AttachmentData, BoneData, SkinData, SlotData, VertexWeight } from '../model/types'
import type { RuntimeAsset } from '../model/asset'
import type {
  AnimData,
  BoneAnim,
  ConstraintAnim,
  DeformAnim,
  DeformKeyframe,
  DrawOrderKeyframe,
  ColorKeyframe,
  EventKeyframe,
  Float2Keyframe,
  FloatKeyframe,
  IkAnim,
  IntKeyframe,
  SlotAnim
} from '../model/animation'
import type { IkConstraint } from '../model/constraints'

export const HAO2D_MAGIC = 0x44324f48
/**
 * 数据版本。
 *
 * - **5**：初始版本；
 * - **6**：附件段补 `contentOffset`（内容中心相对原图中心的位移，**附件自身坐标轴**）。
 *   被裁剪的图（DragonBones 的 trim / Spine 的 offset）必须靠它才能落在正确位置：偏移不能加进
 *   `position` —— 那是骨骼坐标系，会被骨骼旋转带偏。未裁剪时为 0，与 v5 数据等价（读端兼容 v5）。
 * - **7**：附件段末尾补遮罩三项 `clipEndSlot / clipInverse / clipConvex`；
 *   同时 `BlendMode` 移除 Mask 并重排（Below 6→5、None 7→6），读端对旧版本做迁移。
 *
 * ⚠️ 附件段**只写 C# 参考库 `Hao2DCodec` 认识的字段**。编辑器内部还有 `frameSize`
 * （未裁剪原图尺寸，只用于检查器显示与选中框），它**不进二进制**：写进去会让 Unity 读端
 * 从附件段开始整体错位（EndOfStreamException）。展示用的 frameSize 请放工程 JSON。
 */
export const HAO2D_VERSION = 7

export interface Hao2dInspectResult {
  magic: number
  version: number
  armatureName: string
  dataType: AnimType
}

/**
 * 序列化为 `.hao2d`（Version = 6；读端兼容 5）。
 * 字段顺序、类型宽度、字符串编码与参考库 `Hao2DCodec.Write` 逐字节一致。
 *
 * 结构：MAGIC(u32) | VERSION(u16) | armatureName | frameRate | bones | slots | skins |
 *       iks | animations | bindposes | textureNames | dataType(i32) | defaultSkinIndex
 *
 * 注意：v5 的 iks 段只能表达 IK 约束（name/boneIndices/targetBoneIndex/mix/bendSign/useBoneLength），
 * 变换 / 路径 / 物理约束无法写入，调用方应先取出 `collectHao2dWarnings` 的结果做提示。
 */
export function writeHao2d(asset: RuntimeAsset): Uint8Array {
  const writer = new ByteWriter(1024 + asset.bones.length * 64)

  writer.writeUint32(HAO2D_MAGIC)
  writer.writeUint16(HAO2D_VERSION)
  writer.writeString(asset.armatureName)
  writer.writeFloat32(asset.frameRate)

  writeBones(writer, asset.bones)
  writeSlots(writer, asset.slots)
  writeSkins(writer, asset.skins)
  writeIks(writer, asset)
  writeAnimations(writer, asset)
  writeBindposes(writer, asset.bindposes)
  writer.writeStringArray(asset.textureNames)
  writer.writeInt32(asset.dataType)
  writer.writeInt32(asset.defaultSkinIndex)

  return writer.toUint8Array()
}

function writeBones(writer: ByteWriter, bones: readonly BoneData[]): void {
  writer.writeInt32(bones.length)
  for (const bone of bones) {
    writer.writeString(bone.name)
    writer.writeInt32(bone.parentIndex)
    writer.writeFloat32(bone.localPosition.x)
    writer.writeFloat32(bone.localPosition.y)
    writer.writeFloat32(bone.rotation)
    writer.writeFloat32(bone.localScale.x)
    writer.writeFloat32(bone.localScale.y)
    writer.writeFloat32(bone.localShear.x)
    writer.writeFloat32(bone.localShear.y)
    writer.writeBool(bone.inheritRotation)
    writer.writeBool(bone.inheritScale)
    writer.writeFloat32(bone.length)
  }
}

function writeSlots(writer: ByteWriter, slots: readonly SlotData[]): void {
  writer.writeInt32(slots.length)
  for (const slot of slots) {
    writer.writeString(slot.name)
    writer.writeString(slot.setupAttachment)
    writer.writeInt32(slot.boneIndex)
    writer.writeFloat32(slot.color.r)
    writer.writeFloat32(slot.color.g)
    writer.writeFloat32(slot.color.b)
    writer.writeFloat32(slot.color.a)
    writer.writeInt32(slot.blendMode)
    writer.writeInt32(slot.defaultDisplayIndex)
    writer.writeInt32(slot.defaultZOrder)
    writer.writeFloat32(slot.z)
  }
}

function writeSkins(writer: ByteWriter, skins: readonly SkinData[]): void {
  writer.writeInt32(skins.length)
  for (const skin of skins) {
    writer.writeString(skin.name)
    writer.writeInt32(skin.slots.length)
    for (const slot of skin.slots) {
      writer.writeString(slot.slotName)
      writer.writeInt32(slot.attachments.length)
      for (const attachment of slot.attachments) writeAttachment(writer, attachment)
    }
  }
}

function writeAttachment(writer: ByteWriter, a: AttachmentData): void {
  writer.writeString(a.name)
  writer.writeInt32(a.type)
  writer.writeFloat32(a.position.x)
  writer.writeFloat32(a.position.y)
  writer.writeFloat32(a.rotation)
  writer.writeFloat32(a.scale.x)
  writer.writeFloat32(a.scale.y)
  writer.writeFloat32(a.size.x)
  writer.writeFloat32(a.size.y)
  /*
   * v6 新增：contentOffset —— 内容中心相对原图中心的位移，写在**附件自身坐标轴**里，
   * 渲染四边形时按它做局部偏移（`meshBuilder.emitRegion`）。不能并进 position：
   * position 在骨骼坐标系，会被骨骼旋转带着转。
   *
   * v7 起附件末尾再补遮罩三项（clipEndSlot / clipInverse / clipConvex），与 C# Hao2DCodec v7 一致；
   * 编辑器内部的 frameSize 不落盘。
   */
  writer.writeFloat32(a.contentOffset.x)
  writer.writeFloat32(a.contentOffset.y)
  writer.writeFloat32(a.color.r)
  writer.writeFloat32(a.color.g)
  writer.writeFloat32(a.color.b)
  writer.writeFloat32(a.color.a)
  writer.writeString(a.textureName)

  writer.writeInt32(a.uvs.length / 2)
  for (let i = 0; i < a.uvs.length; i += 2) {
    writer.writeFloat32(a.uvs[i])
    writer.writeFloat32(a.uvs[i + 1])
  }

  // vertices：写「float2 元素个数」，与 uvs 及参考库的 ReadFloat2Array 语义一致。
  // 写成 writeFloatArray 的「float 总数」会让 Unity 按元素个数多读一倍，
  // 之后 triangles / edges / weights 全部错位（读取直接抛 EndOfStreamException）。
  writer.writeInt32(a.vertices.length / 2)
  for (let i = 0; i < a.vertices.length; i += 2) {
    writer.writeFloat32(a.vertices[i])
    writer.writeFloat32(a.vertices[i + 1])
  }
  writer.writeIntArray(a.triangles)
  writer.writeIntArray(a.edges)
  writer.writeInt32(a.hull)
  writeWeights(writer, a.weights)
  writer.writeString(a.linkedMeshSkin)
  writer.writeString(a.linkedMeshAttachment)
  writer.writeBool(a.ffdInBoneSpace)
  // v7：遮罩信息。只有 Clipping 附件会用，但所有附件都写，保持记录定长好读
  writer.writeString(a.clipEndSlot)
  writer.writeBool(a.clipInverse)
  writer.writeBool(a.clipConvex)
}

function writeWeights(writer: ByteWriter, weights: readonly VertexWeight[]): void {
  writer.writeInt32(weights.length)
  for (const w of weights) {
    writer.writeInt32(w.b0)
    writer.writeInt32(w.b1)
    writer.writeInt32(w.b2)
    writer.writeInt32(w.b3)
    writer.writeFloat32(w.lx0)
    writer.writeFloat32(w.ly0)
    writer.writeFloat32(w.lx1)
    writer.writeFloat32(w.ly1)
    writer.writeFloat32(w.lx2)
    writer.writeFloat32(w.ly2)
    writer.writeFloat32(w.lx3)
    writer.writeFloat32(w.ly3)
    writer.writeFloat32(w.w0)
    writer.writeFloat32(w.w1)
    writer.writeFloat32(w.w2)
    writer.writeFloat32(w.w3)
  }
}

function writeIks(writer: ByteWriter, asset: RuntimeAsset): void {
  const iks = asset.constraints.filter((c): c is IkConstraint => c.type === 'ik')
  writer.writeInt32(iks.length)
  for (const ik of iks) {
    writer.writeString(ik.name)
    writer.writeIntArray(ik.boneIndices)
    writer.writeInt32(ik.targetBoneIndex)
    writer.writeFloat32(ik.mix)
    writer.writeInt8(ik.bendSign >= 0 ? 1 : -1)
    writer.writeBool(ik.useBoneLength)
  }
}

function writeAnimations(writer: ByteWriter, asset: RuntimeAsset): void {
  writer.writeInt32(asset.animations.length)
  for (const anim of asset.animations) {
    writer.writeString(anim.name)
    writer.writeFloat32(anim.duration)
    writeBoneAnims(writer, anim.bones)
    writeSlotAnims(writer, anim.slots)
    writeDeformAnims(writer, anim.deforms)
    writeDrawOrder(writer, anim.drawOrder)
    writeEvents(writer, anim.events)
    writeIkAnims(writer, anim.iks)
    void anim.constraints
  }
}

function writeBoneAnims(writer: ByteWriter, arr: readonly BoneAnim[]): void {
  writer.writeInt32(arr.length)
  for (const anim of arr) {
    writer.writeInt32(anim.boneIndex)
    writeFloat2Keyframes(writer, anim.translate)
    writeFloatKeyframes(writer, anim.rotate)
    writeFloat2Keyframes(writer, anim.scale)
    writeFloat2Keyframes(writer, anim.shear)
  }
}

function writeSlotAnims(writer: ByteWriter, arr: readonly SlotAnim[]): void {
  writer.writeInt32(arr.length)
  for (const anim of arr) {
    writer.writeInt32(anim.slotIndex)
    writeColorKeyframes(writer, anim.color)
    writeIntKeyframes(writer, anim.displayIndex)
    writer.writeStringArray(anim.displayAttachment)
    writeIntKeyframes(writer, anim.visible)
  }
}

function writeDeformAnims(writer: ByteWriter, arr: readonly DeformAnim[]): void {
  writer.writeInt32(arr.length)
  for (const anim of arr) {
    writer.writeInt32(anim.slotIndex)
    writer.writeString(anim.attachmentName)
    writer.writeInt32(anim.frames.length)
    for (const frame of anim.frames) writeDeformKeyframe(writer, frame)
  }
}

function writeDeformKeyframe(writer: ByteWriter, key: DeformKeyframe): void {
  writer.writeFloat32(key.time)
  writer.writeFloatArray(key.offsets)
  writer.writeInt32(key.vertexOffset)
  writer.writeInt32(key.easing)
  writer.writeFloatArray(key.curve ?? [])
}

function writeDrawOrder(writer: ByteWriter, arr: readonly DrawOrderKeyframe[]): void {
  writer.writeInt32(arr.length)
  for (const key of arr) {
    writer.writeFloat32(key.time)
    writer.writeIntArray(key.order)
  }
}

function writeEvents(writer: ByteWriter, arr: readonly EventKeyframe[]): void {
  writer.writeInt32(arr.length)
  for (const event of arr) {
    writer.writeFloat32(event.time)
    writer.writeString(event.name)
    writer.writeString(event.stringParam)
    writer.writeInt32(event.intParam)
    writer.writeFloat32(event.floatParam)
  }
}

function writeIkAnims(writer: ByteWriter, arr: readonly IkAnim[]): void {
  writer.writeInt32(arr.length)
  for (const anim of arr) {
    writer.writeInt32(anim.ikIndex)
    writeFloatKeyframes(writer, anim.mix)
  }
}

function writeFloatKeyframes(writer: ByteWriter, arr: readonly FloatKeyframe[]): void {
  writer.writeInt32(arr.length)
  for (const key of arr) {
    writer.writeFloat32(key.time)
    writer.writeFloat32(key.value)
    writer.writeInt32(key.easing)
    writer.writeFloatArray(key.curve ?? [])
  }
}

function writeFloat2Keyframes(writer: ByteWriter, arr: readonly Float2Keyframe[]): void {
  writer.writeInt32(arr.length)
  for (const key of arr) {
    writer.writeFloat32(key.time)
    writer.writeFloat32(key.value.x)
    writer.writeFloat32(key.value.y)
    writer.writeInt32(key.easing)
    writer.writeFloatArray(key.curve ?? [])
  }
}

function writeColorKeyframes(writer: ByteWriter, arr: readonly ColorKeyframe[]): void {
  writer.writeInt32(arr.length)
  for (const key of arr) {
    writer.writeFloat32(key.time)
    writer.writeFloat32(key.value.r)
    writer.writeFloat32(key.value.g)
    writer.writeFloat32(key.value.b)
    writer.writeFloat32(key.value.a)
    writer.writeInt32(key.easing)
    writer.writeFloatArray(key.curve ?? [])
  }
}

function writeIntKeyframes(writer: ByteWriter, arr: readonly IntKeyframe[]): void {
  writer.writeInt32(arr.length)
  for (const key of arr) {
    writer.writeFloat32(key.time)
    writer.writeInt32(key.value)
    writer.writeInt32(key.easing)
    writer.writeFloatArray(key.curve ?? [])
  }
}

function writeBindposes(writer: ByteWriter, bindposes: Float32Array): void {
  const count = Math.floor(bindposes.length / 16)
  writer.writeInt32(count)
  for (let i = 0; i < count; i++) {
    writer.writeMatrix(bindposes.subarray(i * 16, i * 16 + 16))
  }
}

/**
 * 导出 .hao2d 的差异告警：v5 格式无法表达的能力项。
 * 参考库运行期对这些项的行为与编辑器不同，必须提示给用户。
 */
export function collectHao2dWarnings(asset: RuntimeAsset): string[] {
  const warnings: string[] = []
  const dropped = asset.constraints.filter((c) => c.type !== 'ik')
  if (dropped.length > 0) {
    warnings.push(
      `.hao2d v5 的 iks 段只能表达 IK 约束：已丢弃 ${dropped.length} 个非 IK 约束（${dropped
        .map((c) => `${c.name}(${c.type})`)
        .join('、')}），Unity 侧不会有这些约束`
    )
  }
  if (!asset.runtimeIK) {
    warnings.push('该资源 runtimeIK = false：Unity 运行期不会再解算 IK（IK 已烘焙进骨骼轨道）')
  }
  // 插槽 setup 可见性（层级树眼睛）不在 .hao2d 二进制里：格式与 Unity 参考库
  // Hao2DCodec 逐字节一致，加字段会让读端从插槽段开始整体错位。隐藏状态只存工程 JSON
  const hiddenSlots = asset.slots.filter((slot) => !slot.visible)
  if (hiddenSlots.length > 0) {
    warnings.push(
      `有 ${hiddenSlots.length} 个插槽被眼睛隐藏（${hiddenSlots
        .map((slot) => slot.name)
        .join('、')}）：.hao2d 二进制不携带该状态，Unity 侧这些插槽仍会显示`
    )
  }

  const weightedWithFfd = asset.animations.some((anim) =>
    anim.deforms.some((deform) => {
      const slot = asset.slots[deform.slotIndex]
      if (!slot) return false
      for (const skin of asset.skins) {
        for (const skinSlot of skin.slots) {
          if (skinSlot.slotName !== slot.name) continue
          for (const attachment of skinSlot.attachments) {
            if (attachment.weights.length > 0 && attachment.ffdInBoneSpace) return true
          }
        }
      }
      return false
    })
  )
  if (weightedWithFfd) {
    warnings.push('存在「加权网格 + 骨内 FFD」的组合：参考库运行期会跳过该 FFD，编辑器会正常应用')
  }

  const hasConstraintAnim = asset.animations.some((anim) => anim.constraints.length > 0)
  const hasNonIkTrack = asset.animations.some((anim) =>
    anim.constraints.some((track) => asset.constraints[track.constraintIndex]?.type !== 'ik')
  )
  if (hasNonIkTrack) {
    warnings.push('动画包含非 IK 约束的关键帧轨道，这些轨道无法写入 .hao2d')
  } else if (hasConstraintAnim) {
    warnings.push('约束关键帧会写入 iks 段（仅 mix 生效），其余约束参数不会被导出')
  }

  const visibleTracks = asset.animations.some((anim) =>
    anim.slots.some((slotAnim) => slotAnim.visible.length > 0)
  )
  if (visibleTracks) {
    warnings.push('存在插槽可见性轨道：参考库运行期不采样该轨道（编辑器会采样）')
  }

  return warnings
}

/** 供 UI 显示的 AnimType 文案 */
export function animTypeLabel(type: AnimType): string {
  return type === AnimType.Spine ? 'Spine' : 'DragonBones'
}

export type { ConstraintAnim, AttachmentType }
