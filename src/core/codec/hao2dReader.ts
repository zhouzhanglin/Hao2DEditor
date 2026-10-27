import { ByteReader } from './binary'
import { t } from '@i18n'
import { HAO2D_MAGIC, HAO2D_VERSION } from './hao2dWriter'
import { AnimType, AttachmentType, BlendMode, createAttachmentData, createBoneData } from '../model/types'
import type { AttachmentData, BoneData, SkinData, SkinSlotData, SlotData, VertexWeight } from '../model/types'
import { createRuntimeAsset } from '../model/asset'
import type { RuntimeAsset } from '../model/asset'
import { createIkConstraint } from '../model/constraints'
import type { IkConstraint } from '../model/constraints'
import type {
  AnimData,
  BoneAnim,
  ColorKeyframe,
  DeformAnim,
  DeformKeyframe,
  DrawOrderKeyframe,
  Easing,
  EventKeyframe,
  Float2Keyframe,
  FloatKeyframe,
  IkAnim,
  IntKeyframe,
  SlotAnim,
  SubArmatureKeyframe
} from '../model/animation'
import { Easing as EasingEnum } from '../model/animation'

export interface Hao2dReadResult {
  asset: RuntimeAsset
  warnings: string[]
}

/** 解析 `.hao2d`（支持 Version 5 / 6 / 7 / 8 / 9）。magic / version 不匹配时抛出可读错误。 */
export function readHao2d(bytes: Uint8Array): Hao2dReadResult {
  const warnings: string[] = []
  const reader = new ByteReader(bytes)
  const magic = reader.readUint32()
  if (magic !== HAO2D_MAGIC) {
    throw new Error(t('Hao2D: 文件头不匹配（0x{0}），不是 .hao2d 资源', magic.toString(16)))
  }
  const version = reader.readUint16()
  // v5 的附件段没有 contentOffset，按 0 读 —— 等价于「没被裁剪过」
  // 5 / 6 / 7 是历史格式（字段更少，按默认值补齐）；8 = 当前格式（含骨架嵌套）
  const supported = version === 5 || version === 6 || version === 7 || version === 8 || version === HAO2D_VERSION
  if (!supported) {
    throw new Error(
      t('Hao2D: 不支持的数据版本 {0}（支持 5 / 6 / 7 / 8 / {1}），请重新导出', [version, HAO2D_VERSION])
    )
  }

  const armatureName = reader.readString()
  const frameRate = reader.readFloat32()
  const bones = readBones(reader)
  const slots = readSlots(reader, version, warnings)
  const skins = readSkins(reader, version)
  const constraints = readIks(reader)
  const animations = readAnimations(reader, version)
  const bindposes = readBindposes(reader)
  const textureNames = reader.readStringArray()
  const dataType = reader.readInt32() as AnimType
  const defaultSkinIndex = reader.readInt32()
  // v9：叠加皮肤（编辑器当前皮肤）；旧文件没有 → 只显示基底皮肤
  const defaultSkin = version >= 9 ? reader.readString() : ''

  const asset = createRuntimeAsset({
    dataType,
    armatureName,
    frameRate,
    bones,
    slots,
    skins,
    constraints,
    animations,
    bindposes,
    textureNames,
    defaultSkinIndex,
    defaultSkin,
    runtimeIK: true,
    images: textureNames.map((name) => ({ name, path: name, width: 0, height: 0 }))
  })

  if (constraints.length === 0 && animations.some((anim) => anim.iks.length > 0)) {
    warnings.push(t('动画包含 iks 轨道但资源没有 IK 约束，这些轨道会被忽略'))
  }
  return { asset, warnings }
}

function readBones(reader: ByteReader): BoneData[] {
  const count = reader.readInt32()
  const bones: BoneData[] = []
  for (let i = 0; i < count; i++) {
    bones.push(
      createBoneData({
        name: reader.readString(),
        parentIndex: reader.readInt32(),
        localPosition: { x: reader.readFloat32(), y: reader.readFloat32() },
        rotation: reader.readFloat32(),
        localScale: { x: reader.readFloat32(), y: reader.readFloat32() },
        localShear: { x: reader.readFloat32(), y: reader.readFloat32() },
        inheritRotation: reader.readBool(),
        inheritScale: reader.readBool(),
        length: reader.readFloat32()
      })
    )
  }
  return bones
}

/**
 * v6 及更早的 BlendMode：Normal 0 / Additive 1 / Multiply 2 / Screen 3 /
 * Erase 4 / Mask 5 / Below 6 / None 7。v7 移除 Mask，Below / None 各前移一位。
 */
function migrateLegacyBlend(value: number, name: string, warnings: string[]): BlendMode {
  if (value === 5) {
    warnings.push(t('插槽「{0}」使用了已移除的混合模式 Mask，已迁移为 Normal', name))
    return BlendMode.Normal
  }
  if (value === 6) return BlendMode.Below
  if (value === 7) return BlendMode.None
  return value >= BlendMode.Normal && value <= BlendMode.None ? (value as BlendMode) : BlendMode.Normal
}

function readSlots(reader: ByteReader, version: number, warnings: string[]): SlotData[] {
  const count = reader.readInt32()
  const slots: SlotData[] = []
  for (let i = 0; i < count; i++) {
    const name = reader.readString()
    const setupAttachment = reader.readString()
    const boneIndex = reader.readInt32()
    const color = {
      r: reader.readFloat32(),
      g: reader.readFloat32(),
      b: reader.readFloat32(),
      a: reader.readFloat32()
    }
    const rawBlend = reader.readInt32()
    const blendMode = version < 7 ? migrateLegacyBlend(rawBlend, name, warnings) : (rawBlend as BlendMode)
    const defaultDisplayIndex = reader.readInt32()
    const defaultZOrder = reader.readInt32()
    const z = reader.readFloat32()
    slots.push({
      name,
      setupAttachment,
      boneIndex,
      color,
      blendMode,
      defaultDisplayIndex,
      defaultZOrder,
      z,
      // .hao2d 二进制不携带插槽级可见性（只在工程 JSON 里），读回来一律按可见
      visible: true
    })
  }
  return slots
}

function readSkins(reader: ByteReader, version: number): SkinData[] {
  const count = reader.readInt32()
  const skins: SkinData[] = []
  for (let i = 0; i < count; i++) {
    const name = reader.readString()
    const slotCount = reader.readInt32()
    const slots: SkinSlotData[] = []
    for (let j = 0; j < slotCount; j++) {
      const slotName = reader.readString()
      const attachmentCount = reader.readInt32()
      const attachments: AttachmentData[] = []
      for (let k = 0; k < attachmentCount; k++) attachments.push(readAttachment(reader, version))
      slots.push({ slotName, attachments })
    }
    skins.push({ name, slots })
  }
  return skins
}

function readAttachment(reader: ByteReader, version: number): AttachmentData {
  const name = reader.readString()
  const type = reader.readInt32() as AttachmentType
  const position = { x: reader.readFloat32(), y: reader.readFloat32() }
  const rotation = reader.readFloat32()
  const scale = { x: reader.readFloat32(), y: reader.readFloat32() }
  const size = { x: reader.readFloat32(), y: reader.readFloat32() }
  /*
   * v6 起附件段带裁剪信息：只有 contentOffset（与 C# Hao2DCodec 一致）。
   * v5 没有这个字段，按 0 读 —— 等价于「没被裁剪过」。
   * frameSize（未裁剪原图尺寸）不落盘，仅编辑器内部使用，读回时为 0。
   */
  const frameSize = { x: 0, y: 0 }
  const contentOffset =
    version >= 6 ? { x: reader.readFloat32(), y: reader.readFloat32() } : { x: 0, y: 0 }
  const color = {
    r: reader.readFloat32(),
    g: reader.readFloat32(),
    b: reader.readFloat32(),
    a: reader.readFloat32()
  }
  const textureName = reader.readString()

  const uvCount = reader.readInt32()
  const uvs = new Float32Array(uvCount * 2)
  for (let i = 0; i < uvCount; i++) {
    uvs[i * 2] = reader.readFloat32()
    uvs[i * 2 + 1] = reader.readFloat32()
  }

  // vertices：按「float2 元素个数」读（与 writer 及 Unity 端 Hao2D 运行时 ReadFloat2Array 对齐）
  const vertexCount = reader.readInt32()
  const vertices = new Float32Array(vertexCount * 2)
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 2] = reader.readFloat32()
    vertices[i * 2 + 1] = reader.readFloat32()
  }
  const triangles = reader.readIntArray()
  const edges = reader.readIntArray()
  const hull = reader.readInt32()
  const weights = readWeights(reader)
  const linkedMeshSkin = reader.readString()
  const linkedMeshAttachment = reader.readString()
  const ffdInBoneSpace = reader.readBool()
  // v7：遮罩信息。旧版本没有这三项，按「不是遮罩」读
  const clipEndSlot = version >= 7 ? reader.readString() : ''
  const clipInverse = version >= 7 ? reader.readBool() : false
  const clipConvex = version >= 7 ? reader.readBool() : false
  // v8：嵌套骨架（旧版本没有这些字段，按「不是嵌套」补齐）
  const subArmature = version >= 8 ? reader.readString() : ''
  const subAnimation = version >= 8 ? reader.readString() : ''
  const subPlayTimes = version >= 8 ? reader.readInt32() : 0
  const subOffset = version >= 8 ? reader.readFloat32() : 0
  const subSpeed = version >= 8 ? reader.readFloat32() : 1

  return createAttachmentData({
    name,
    type,
    position,
    rotation,
    scale,
    size,
    frameSize,
    contentOffset,
    color,
    textureName,
    uvs,
    vertices,
    triangles,
    edges,
    hull,
    weights,
    ffdInBoneSpace,
    linkedMeshSkin,
    linkedMeshAttachment,
    clipEndSlot,
    clipInverse,
    clipConvex,
    subArmature,
    subAnimation,
    subPlayTimes,
    subOffset,
    subSpeed
  })
}

function readWeights(reader: ByteReader): VertexWeight[] {
  const count = reader.readInt32()
  const weights: VertexWeight[] = []
  for (let i = 0; i < count; i++) {
    weights.push({
      b0: reader.readInt32(),
      b1: reader.readInt32(),
      b2: reader.readInt32(),
      b3: reader.readInt32(),
      lx0: reader.readFloat32(),
      ly0: reader.readFloat32(),
      lx1: reader.readFloat32(),
      ly1: reader.readFloat32(),
      lx2: reader.readFloat32(),
      ly2: reader.readFloat32(),
      lx3: reader.readFloat32(),
      ly3: reader.readFloat32(),
      w0: reader.readFloat32(),
      w1: reader.readFloat32(),
      w2: reader.readFloat32(),
      w3: reader.readFloat32()
    })
  }
  return weights
}

function readIks(reader: ByteReader): IkConstraint[] {
  const count = reader.readInt32()
  const iks: IkConstraint[] = []
  for (let i = 0; i < count; i++) {
    const name = reader.readString()
    const boneIndices = reader.readIntArray()
    const targetBoneIndex = reader.readInt32()
    const mix = reader.readFloat32()
    const bendSign = reader.readInt8()
    const useBoneLength = reader.readBool()
    iks.push(createIkConstraint({ name, boneIndices, targetBoneIndex, mix, bendSign, useBoneLength }))
  }
  return iks
}

function readAnimations(reader: ByteReader, version: number): AnimData[] {
  const count = reader.readInt32()
  const animations: AnimData[] = []
  for (let i = 0; i < count; i++) {
    const name = reader.readString()
    const duration = reader.readFloat32()
    const bones = readBoneAnims(reader)
    const slots = readSlotAnims(reader, version)
    const deforms = readDeformAnims(reader)
    const drawOrder = readDrawOrder(reader)
    const events = readEvents(reader)
    const iks = readIkAnims(reader)
    animations.push({
      name,
      duration,
      bones,
      slots,
      deforms,
      drawOrder,
      events,
      iks,
      constraints: []
    })
  }
  return animations
}

function readFloatKeyframes(reader: ByteReader): FloatKeyframe[] {
  const count = reader.readInt32()
  const keys: FloatKeyframe[] = []
  for (let i = 0; i < count; i++) {
    keys.push({
      time: reader.readFloat32(),
      value: reader.readFloat32(),
      easing: reader.readInt32() as Easing,
      curve: normalizeCurve(reader.readFloatArray())
    })
  }
  return keys
}

function readFloat2Keyframes(reader: ByteReader): Float2Keyframe[] {
  const count = reader.readInt32()
  const keys: Float2Keyframe[] = []
  for (let i = 0; i < count; i++) {
    keys.push({
      time: reader.readFloat32(),
      value: { x: reader.readFloat32(), y: reader.readFloat32() },
      easing: reader.readInt32() as Easing,
      curve: normalizeCurve(reader.readFloatArray())
    })
  }
  return keys
}

function readColorKeyframes(reader: ByteReader): ColorKeyframe[] {
  const count = reader.readInt32()
  const keys: ColorKeyframe[] = []
  for (let i = 0; i < count; i++) {
    keys.push({
      time: reader.readFloat32(),
      value: {
        r: reader.readFloat32(),
        g: reader.readFloat32(),
        b: reader.readFloat32(),
        a: reader.readFloat32()
      },
      easing: reader.readInt32() as Easing,
      curve: normalizeCurve(reader.readFloatArray())
    })
  }
  return keys
}

function readIntKeyframes(reader: ByteReader): IntKeyframe[] {
  const count = reader.readInt32()
  const keys: IntKeyframe[] = []
  for (let i = 0; i < count; i++) {
    keys.push({
      time: reader.readFloat32(),
      value: reader.readInt32(),
      easing: reader.readInt32() as Easing,
      curve: normalizeCurve(reader.readFloatArray())
    })
  }
  return keys
}

function readDeformKeyframes(reader: ByteReader): DeformKeyframe[] {
  const count = reader.readInt32()
  const keys: DeformKeyframe[] = []
  for (let i = 0; i < count; i++) {
    keys.push({
      time: reader.readFloat32(),
      offsets: reader.readFloatArray(),
      vertexOffset: reader.readInt32(),
      easing: reader.readInt32() as Easing,
      curve: normalizeCurve(reader.readFloatArray())
    })
  }
  return keys
}

function readBoneAnims(reader: ByteReader): BoneAnim[] {
  const count = reader.readInt32()
  const out: BoneAnim[] = []
  for (let i = 0; i < count; i++) {
    const boneIndex = reader.readInt32()
    const translate = readFloat2Keyframes(reader)
    const rotate = readFloatKeyframes(reader)
    const scale = readFloat2Keyframes(reader)
    const shear = readFloat2Keyframes(reader)
    out.push({ boneIndex, translate, rotate, scale, shear })
  }
  return out
}

function readSlotAnims(reader: ByteReader, version: number): SlotAnim[] {
  const count = reader.readInt32()
  const out: SlotAnim[] = []
  for (let i = 0; i < count; i++) {
    const slotIndex = reader.readInt32()
    const color = readColorKeyframes(reader)
    const displayIndex = readIntKeyframes(reader)
    const displayAttachment = reader.readStringArray()
    const visible = readIntKeyframes(reader)
    // v8：「子骨架」控制帧（旧版本没有，读成空轨道）。离散量按阶跃处理
    const subArmature: SubArmatureKeyframe[] = []
    if (version >= 8) {
      const keyCount = reader.readInt32()
      for (let k = 0; k < keyCount; k++) {
        subArmature.push({
          time: reader.readFloat32(),
          animation: reader.readString(),
          playTimes: reader.readInt32(),
          offset: reader.readFloat32(),
          speed: reader.readFloat32(),
          easing: EasingEnum.Stepped,
          curve: null
        })
      }
    }
    out.push({ slotIndex, color, displayIndex, displayAttachment, visible, subArmature })
  }
  return out
}

function readDeformAnims(reader: ByteReader): DeformAnim[] {
  const count = reader.readInt32()
  const out: DeformAnim[] = []
  for (let i = 0; i < count; i++) {
    const slotIndex = reader.readInt32()
    const attachmentName = reader.readString()
    const frames = readDeformKeyframes(reader)
    // v9 二进制没有皮肤归属，`skin` 保持缺省（运行期退回附件名过滤）
    out.push({ slotIndex, attachmentName, frames })
  }
  return out
}

function readDrawOrder(reader: ByteReader): DrawOrderKeyframe[] {
  const count = reader.readInt32()
  const out: DrawOrderKeyframe[] = []
  for (let i = 0; i < count; i++) {
    out.push({ time: reader.readFloat32(), order: reader.readIntArray() })
  }
  return out
}

function readEvents(reader: ByteReader): EventKeyframe[] {
  const count = reader.readInt32()
  const out: EventKeyframe[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      time: reader.readFloat32(),
      name: reader.readString(),
      stringParam: reader.readString(),
      intParam: reader.readInt32(),
      floatParam: reader.readFloat32()
    })
  }
  return out
}

function readIkAnims(reader: ByteReader): IkAnim[] {
  const count = reader.readInt32()
  const out: IkAnim[] = []
  for (let i = 0; i < count; i++) {
    const ikIndex = reader.readInt32()
    const mix = readFloatKeyframes(reader)
    out.push({ ikIndex, mix })
  }
  return out
}

function readBindposes(reader: ByteReader): Float32Array {
  const count = reader.readInt32()
  const out = new Float32Array(count * 16)
  for (let i = 0; i < count; i++) out.set(reader.readMatrix(), i * 16)
  return out
}

/** Unity 端 Hao2D 运行时以「长度 0 的 float[]」表示无曲线，这里统一成 null */
function normalizeCurve(curve: number[]): number[] | null {
  return curve.length === 0 ? null : curve
}

export { EasingEnum }
