import { AnimType, AttachmentType, BlendMode, createAttachmentData, createBoneData } from '@core/model/types'
import type { AttachmentData, BoneData, RGBA, SkinData, SlotData, VertexWeight } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { computeBindposes } from '@core/model/setup'
import { emptyAnimData } from '@core/model/animation'
import type { AnimData } from '@core/model/animation'

export function bone(
  name: string,
  parentIndex: number,
  x = 0,
  y = 0,
  rotation = 0,
  length = 0
): BoneData {
  return createBoneData({
    name,
    parentIndex,
    localPosition: { x, y },
    rotation,
    length
  })
}

export function slot(
  name: string,
  boneIndex: number,
  options?: {
    setupAttachment?: string
    displayIndex?: number
    color?: RGBA
    blendMode?: BlendMode
  }
): SlotData {
  return {
    name,
    boneIndex,
    color: options?.color ?? { r: 1, g: 1, b: 1, a: 1 },
    blendMode: options?.blendMode ?? BlendMode.Normal,
    defaultDisplayIndex: options?.displayIndex ?? 0,
    defaultZOrder: 0,
    z: 0,
    visible: true,
    setupAttachment: options?.setupAttachment ?? ''
  }
}

/** 标准 Region 四角 UV：左下(0,0) 右下(1,0) 右上(1,1) 左上(0,1) */
export const REGION_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])

export function region(
  name: string,
  textureName: string,
  width: number,
  height: number,
  position: { x: number; y: number } = { x: 0, y: 0 }
): AttachmentData {
  return createAttachmentData({
    name,
    type: AttachmentType.Region,
    textureName,
    size: { x: width, y: height },
    position,
    uvs: REGION_UVS
  })
}

export function weight(
  bone: number,
  w: number,
  lx: number,
  ly: number
): VertexWeight {
  return {
    b0: bone,
    b1: 0,
    b2: 0,
    b3: 0,
    lx0: lx,
    ly0: ly,
    lx1: 0,
    ly1: 0,
    lx2: 0,
    ly2: 0,
    lx3: 0,
    ly3: 0,
    w0: w,
    w1: 0,
    w2: 0,
    w3: 0
  }
}

export function mesh(
  name: string,
  textureName: string,
  vertices: number[],
  triangles: number[],
  weights: VertexWeight[],
  options?: { ffdInBoneSpace?: boolean }
): AttachmentData {
  const uvs = new Float32Array(vertices.length)
  for (let i = 0; i < uvs.length; i++) uvs[i] = i % 2
  return createAttachmentData({
    name,
    type: AttachmentType.Mesh,
    textureName,
    vertices: new Float32Array(vertices),
    triangles,
    weights,
    uvs,
    ffdInBoneSpace: options?.ffdInBoneSpace ?? true
  })
}

export function skin(name: string, slots: Array<{ slotName: string; attachments: AttachmentData[] }>): SkinData {
  return { name, slots }
}

export interface AssetOptions {
  animations?: AnimData[]
  textures?: string[]
  defaultSkinIndex?: number
  runtimeIK?: boolean
}

export function asset(
  bones: BoneData[],
  slots: SlotData[],
  skins: SkinData[],
  options?: AssetOptions
): RuntimeAsset {
  const result = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: 'test',
    frameRate: 30,
    bones,
    slots,
    skins,
    animations: options?.animations ?? [],
    textureNames: options?.textures ?? collectTextures(skins),
    defaultSkinIndex: options?.defaultSkinIndex ?? 0,
    runtimeIK: options?.runtimeIK ?? true,
    images: (options?.textures ?? collectTextures(skins)).map((name) => ({
      name,
      path: name,
      width: 0,
      height: 0
    }))
  })
  result.bindposes = computeBindposes(result)
  return result
}

function collectTextures(skins: SkinData[]): string[] {
  const names: string[] = []
  for (const s of skins) {
    for (const slot of s.slots) {
      for (const attachment of slot.attachments) {
        if (attachment.textureName && !names.includes(attachment.textureName)) names.push(attachment.textureName)
      }
    }
  }
  return names
}

export function anim(name: string, duration: number): AnimData {
  const data = emptyAnimData(name)
  data.duration = duration
  return data
}
