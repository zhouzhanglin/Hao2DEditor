import { AttachmentType, BlendMode, createAttachmentData, createBoneData } from '../model/types'
import type { AttachmentData, BoneData, SkinData, SlotData, VertexWeight } from '../model/types'
import { createRuntimeAsset } from '../model/asset'
import type { RuntimeAsset } from '../model/asset'
import { createIkConstraint, createPathConstraint, createPhysicsConstraint, createTransformConstraint } from '../model/constraints'
import type { Constraint } from '../model/constraints'
import type { AnimData } from '../model/animation'
import type { RuntimeAtlasJson, RuntimeSkeJson } from '../codec/runtimeSkeJson'
import { parseRuntimeAtlas, parseRuntimeSke } from '../codec/runtimeSkeJson'

export interface LoadedRuntime {
  asset: RuntimeAsset
  atlas: RuntimeAtlasJson
}

type JsonRecord = Record<string, unknown>

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function pair(value: unknown, fallback = 0): [number, number] {
  if (Array.isArray(value)) return [num(value[0], fallback), num(value[1], fallback)]
  return [fallback, fallback]
}

function quad(value: unknown): [number, number, number, number] {
  if (Array.isArray(value)) return [num(value[0]), num(value[1]), num(value[2]), num(value[3], 1)]
  return [1, 1, 1, 1]
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : []
}

function weightsOf(value: unknown): VertexWeight[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const raw = (typeof item === 'object' && item !== null ? item : {}) as JsonRecord
    return {
      b0: num(raw.b0),
      b1: num(raw.b1),
      b2: num(raw.b2),
      b3: num(raw.b3),
      lx0: num(raw.lx0),
      ly0: num(raw.ly0),
      lx1: num(raw.lx1),
      ly1: num(raw.ly1),
      lx2: num(raw.lx2),
      ly2: num(raw.ly2),
      lx3: num(raw.lx3),
      ly3: num(raw.ly3),
      w0: num(raw.w0),
      w1: num(raw.w1),
      w2: num(raw.w2),
      w3: num(raw.w3)
    }
  })
}

function bonesOf(json: RuntimeSkeJson): BoneData[] {
  return (json.bones as JsonRecord[]).map((raw) => {
    const position = pair(raw.localPosition)
    const scale = pair(raw.localScale, 1)
    const shear = pair(raw.localShear)
    return createBoneData({
      name: str(raw.name),
      parentIndex: num(raw.parentIndex, -1),
      localPosition: { x: position[0], y: position[1] },
      rotation: num(raw.rotation),
      localScale: { x: scale[0], y: scale[1] },
      localShear: { x: shear[0], y: shear[1] },
      inheritRotation: bool(raw.inheritRotation, true),
      inheritScale: bool(raw.inheritScale, true),
      length: num(raw.length)
    })
  })
}

function slotsOf(json: RuntimeSkeJson): SlotData[] {
  return (json.slots as JsonRecord[]).map((raw) => {
    const color = quad(raw.color)
    return {
      name: str(raw.name),
      boneIndex: num(raw.boneIndex, -1),
      color: { r: color[0], g: color[1], b: color[2], a: color[3] },
      blendMode: num(raw.blendMode) as BlendMode,
      defaultDisplayIndex: num(raw.defaultDisplayIndex, -1),
      defaultZOrder: num(raw.defaultZOrder),
      z: num(raw.z),
      setupAttachment: str(raw.setupAttachment)
    }
  })
}

function attachmentsOf(value: unknown): AttachmentData[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const raw = (typeof item === 'object' && item !== null ? item : {}) as JsonRecord
    const position = pair(raw.position)
    const scale = pair(raw.scale, 1)
    const size = pair(raw.size)
    const color = quad(raw.color)
    return createAttachmentData({
      name: str(raw.name),
      type: num(raw.type) as AttachmentType,
      position: { x: position[0], y: position[1] },
      rotation: num(raw.rotation),
      scale: { x: scale[0], y: scale[1] },
      size: { x: size[0], y: size[1] },
      color: { r: color[0], g: color[1], b: color[2], a: color[3] },
      textureName: str(raw.textureName),
      uvs: Float32Array.from(numberArray(raw.uvs)),
      vertices: Float32Array.from(numberArray(raw.vertices)),
      triangles: numberArray(raw.triangles),
      edges: numberArray(raw.edges),
      hull: num(raw.hull),
      weights: weightsOf(raw.weights),
      ffdInBoneSpace: bool(raw.ffdInBoneSpace),
      linkedMeshSkin: str(raw.linkedMeshSkin),
      linkedMeshAttachment: str(raw.linkedMeshAttachment)
    })
  })
}

function skinsOf(json: RuntimeSkeJson): SkinData[] {
  return (json.skins as JsonRecord[]).map((raw) => ({
    name: str(raw.name),
    slots: (Array.isArray(raw.slots) ? (raw.slots as JsonRecord[]) : []).map((slot) => ({
      slotName: str(slot.slotName),
      attachments: attachmentsOf(slot.attachments)
    }))
  }))
}

function constraintsOf(json: RuntimeSkeJson): Constraint[] {
  return (json.constraints as JsonRecord[]).map((raw) => {
    const bones = numberArray(raw.boneIndices)
    const target = num(raw.targetBoneIndex, -1)
    const common = {
      name: str(raw.name),
      order: num(raw.order),
      enabled: bool(raw.enabled, true),
      boneIndices: bones,
      targetBoneIndex: target
    }
    if (raw.type === 'transform') {
      return createTransformConstraint({ ...raw, ...common, type: 'transform' } as never)
    }
    if (raw.type === 'path') return createPathConstraint({ ...raw, ...common, type: 'path' } as never)
    if (raw.type === 'physics') return createPhysicsConstraint({ ...raw, ...common, type: 'physics' } as never)
    return createIkConstraint({ ...raw, ...common, type: 'ik' } as never)
  })
}

/** hao2d-ske / hao2d-atlas → Runtime 模型（可直接驱动 Skeleton / AnimationPlayer / MeshBuilder） */
export function assetFromJson(ske: RuntimeSkeJson, atlas: RuntimeAtlasJson | null): RuntimeAsset {
  const asset = createRuntimeAsset({
    dataType: ske.dataType,
    armatureName: ske.armatureName,
    frameRate: ske.frameRate,
    bones: bonesOf(ske),
    slots: slotsOf(ske),
    skins: skinsOf(ske),
    constraints: constraintsOf(ske),
    animations: (ske.animations ?? []) as AnimData[],
    bindposes: Float32Array.from(ske.bindposes ?? []),
    textureNames: [...(ske.textureNames ?? [])],
    defaultSkinIndex: 0,
    runtimeIK: true,
    images: (atlas?.pages ?? []).map((page) => ({
      name: page.image,
      path: page.image,
      width: page.width,
      height: page.height,
      loose: false
    }))
  })
  asset.defaultSkinIndex = Math.max(0, asset.skins.findIndex((skin) => skin.name === 'default'))
  return asset
}

/** 从文本加载（游戏侧 / 编辑器校验导出产物时使用） */
export function loadRuntime(skeText: string, atlasText?: string): LoadedRuntime {
  const ske = parseRuntimeSke(skeText)
  const atlas = atlasText
    ? parseRuntimeAtlas(atlasText)
    : { format: 'hao2d-atlas' as const, version: 1 as const, pages: [], regions: [] }
  return { asset: assetFromJson(ske, atlas), atlas }
}

/** 图集区域 → 页面索引（导出后用 UV 反查时使用） */
export function regionPageIndex(atlas: RuntimeAtlasJson, name: string): number {
  const found = atlas.regions.find((region) => region.name === name)
  return found ? found.page : -1
}
