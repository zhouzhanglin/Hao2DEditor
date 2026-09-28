import { ByteReader } from './binary'
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
  SlotAnim
} from '../model/animation'
import { Easing as EasingEnum } from '../model/animation'

export interface Hao2dReadResult {
  asset: RuntimeAsset
  warnings: string[]
}

/** 解析 `.hao2d`（Version 必须等于 5）。magic / version 不匹配时抛出可读错误。 */
export function readHao2d(bytes: Uint8Array): Hao2dReadResult {
  const reader = new ByteReader(bytes)
  const magic = reader.readUint32()
  if (magic !== HAO2D_MAGIC) {
    throw new Error(`Hao2D: 文件头不匹配（0x${magic.toString(16)}），不是 .hao2d 资源`)
  }
  const version = reader.readUint16()
  if (version !== HAO2D_VERSION) {
    throw new Error(`Hao2D: 不支持的数据版本 ${version}（需要 ${HAO2D_VERSION}），请重新导出`)
  }

  const armatureName = reader.readString()
  const frameRate = reader.readFloat32()
  const bones = readBones(reader)
  const slots = readSlots(reader)
  const skins = readSkins(reader)
  const constraints = readIks(reader)
  const animations = readAnimations(reader)
  const bindposes = readBindposes(reader)
  const textureNames = reader.readStringArray()
  const dataType = reader.readInt32() as AnimType
  const defaultSkinIndex = reader.readInt32()

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
    runtimeIK: true,
    images: textureNames.map((name) => ({ name, path: name, width: 0, height: 0 }))
  })

  const warnings: string[] = []
  if (constraints.length === 0 && animations.some((anim) => anim.iks.length > 0)) {
    warnings.push('动画包含 iks 轨道但资源没有 IK 约束，这些轨道会被忽略')
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

function readSlots(reader: ByteReader): SlotData[] {
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
    const blendMode = reader.readInt32() as BlendMode
    const defaultDisplayIndex = reader.readInt32()
    const defaultZOrder = reader.readInt32()
    const z = reader.readFloat32()
    slots.push({ name, setupAttachment, boneIndex, color, blendMode, defaultDisplayIndex, defaultZOrder, z })
  }
  return slots
}

function readSkins(reader: ByteReader): SkinData[] {
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
      for (let k = 0; k < attachmentCount; k++) attachments.push(readAttachment(reader))
      slots.push({ slotName, attachments })
    }
    skins.push({ name, slots })
  }
  return skins
}

function readAttachment(reader: ByteReader): AttachmentData {
  const name = reader.readString()
  const type = reader.readInt32() as AttachmentType
  const position = { x: reader.readFloat32(), y: reader.readFloat32() }
  const rotation = reader.readFloat32()
  const scale = { x: reader.readFloat32(), y: reader.readFloat32() }
  const size = { x: reader.readFloat32(), y: reader.readFloat32() }
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

  const vertices = Float32Array.from(reader.readFloatArray())
  const triangles = reader.readIntArray()
  const edges = reader.readIntArray()
  const hull = reader.readInt32()
  const weights = readWeights(reader)
  const linkedMeshSkin = reader.readString()
  const linkedMeshAttachment = reader.readString()
  const ffdInBoneSpace = reader.readBool()

  return createAttachmentData({
    name,
    type,
    position,
    rotation,
    scale,
    size,
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
    linkedMeshAttachment
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

function readAnimations(reader: ByteReader): AnimData[] {
  const count = reader.readInt32()
  const animations: AnimData[] = []
  for (let i = 0; i < count; i++) {
    const name = reader.readString()
    const duration = reader.readFloat32()
    const bones = readBoneAnims(reader)
    const slots = readSlotAnims(reader)
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

function readSlotAnims(reader: ByteReader): SlotAnim[] {
  const count = reader.readInt32()
  const out: SlotAnim[] = []
  for (let i = 0; i < count; i++) {
    const slotIndex = reader.readInt32()
    const color = readColorKeyframes(reader)
    const displayIndex = readIntKeyframes(reader)
    const displayAttachment = reader.readStringArray()
    const visible = readIntKeyframes(reader)
    out.push({ slotIndex, color, displayIndex, displayAttachment, visible })
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

/** 参考库以「长度 0 的 float[]」表示无曲线，这里统一成 null */
function normalizeCurve(curve: number[]): number[] | null {
  return curve.length === 0 ? null : curve
}

export { EasingEnum }
