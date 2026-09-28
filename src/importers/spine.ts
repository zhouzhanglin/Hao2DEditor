import { createAttachmentData, createBoneData, AttachmentType, AnimType, BlendMode } from '@core/model/types'
import type { AttachmentData, BoneData, ImageRef, SkinData, SkinSlotData, SlotData, VertexWeight } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { computeBindposes, createSetupPose } from '@core/model/setup'
import {
  createIkConstraint,
  createPathConstraint,
  createPhysicsConstraint,
  createTransformConstraint
} from '@core/model/constraints'
import type { Constraint } from '@core/model/constraints'
import { emptyIkAnim } from '@core/model/animation'
import type { AnimData } from '@core/model/animation'
import type { AtlasRegion, PageSizes } from './uv'
import { mapRegionRelativeUvs, parseHexColor, pxToUnit, regionGeometry, regionUvs } from './uv'
import { indexRegions } from './atlasSpine'
import { importSpineAnimations } from './spineAnims'
import type {
  SpineAttachmentJson,
  SpineBoneJson,
  SpineIkJson,
  SpineJson,
  SpineSlotJson
} from './spineTypes'

export interface SpineImportInput {
  json: SpineJson
  regions: readonly AtlasRegion[]
  pageSizes: PageSizes
  /** 图集页名 → 图片绝对路径 */
  pageImages?: Record<string, string>
}

export interface SpineImportResult {
  asset: RuntimeAsset
  warnings: string[]
}

interface AttachmentContext {
  /** 原始骨骼下标 → 新下标（权重里的骨骼下标用它重映射） */
  origToNew: number[]
  bindposes: Float32Array
  setupWorld: Float32Array
  regions: Map<string, AtlasRegion>
  pageSizes: PageSizes
  warnings: string[]
}

/** 拓扑排序骨骼（父在前），产出新序、名字映射与「原始下标 → 新下标」表 */
function orderBones(bones: readonly SpineBoneJson[], warnings: string[]): {
  ordered: SpineBoneJson[]
  index: Map<string, number>
  origToNew: number[]
} {
  const byName = new Map<string, SpineBoneJson>()
  for (const bone of bones) {
    if (byName.has(bone.name)) warnings.push(`存在重名骨骼「${bone.name}」，仅保留第一个`)
    else byName.set(bone.name, bone)
  }

  const ordered: SpineBoneJson[] = []
  const visited = new Set<string>()
  const visit = (bone: SpineBoneJson, depth: number): void => {
    if (visited.has(bone.name)) return
    if (depth > 512) {
      warnings.push(`骨骼「${bone.name}」父链过深或存在环，已截断`)
      return
    }
    if (bone.parent) {
      const parent = byName.get(bone.parent)
      if (!parent) warnings.push(`骨骼「${bone.name}」的父骨骼「${bone.parent}」不存在，已作为根骨骼`)
      else visit(parent, depth + 1)
    }
    if (!visited.has(bone.name)) {
      visited.add(bone.name)
      ordered.push(bone)
    }
  }
  for (const bone of bones) visit(bone, 0)

  const index = new Map<string, number>()
  ordered.forEach((bone, i) => index.set(bone.name, i))

  const origToNew = bones.map((bone) => index.get(bone.name) ?? 0)
  return { ordered, index, origToNew }
}

/** Spine 的 inherit 语义：4.x 用 transform 枚举，3.3/3.4 用两个布尔 */
function inheritOf(bone: SpineBoneJson): { rotation: boolean; scale: boolean } {
  const transform = (bone.transform ?? '').toLowerCase()
  if (transform === 'onlytranslation') return { rotation: false, scale: false }
  if (transform === 'norotationorreflection') return { rotation: false, scale: true }
  if (transform === 'noscale') return { rotation: true, scale: false }
  if (transform === 'noscalereflection') return { rotation: true, scale: false }
  if (transform === 'normal') return { rotation: true, scale: true }
  return {
    rotation: bone.inheritRotation !== false,
    scale: bone.inheritScale !== false
  }
}

function toBoneData(ordered: readonly SpineBoneJson[], index: Map<string, number>): BoneData[] {
  return ordered.map((bone) => {
    const inherit = inheritOf(bone)
    return createBoneData({
      name: bone.name,
      parentIndex: bone.parent ? (index.get(bone.parent) ?? -1) : -1,
      localPosition: { x: pxToUnit(bone.x ?? 0), y: pxToUnit(bone.y ?? 0) },
      rotation: bone.rotation ?? 0,
      localScale: { x: bone.scaleX ?? 1, y: bone.scaleY ?? 1 },
      localShear: { x: bone.shearX ?? 0, y: bone.shearY ?? 0 },
      inheritRotation: inherit.rotation,
      inheritScale: inherit.scale,
      length: pxToUnit(bone.length ?? 0)
    })
  })
}

/** 统一 3.3/3.4（对象）与 3.8+（数组带 name）两代皮肤格式 */
function normalizeSkins(json: SpineJson): Array<{ name: string; attachments: Record<string, Record<string, SpineAttachmentJson>> }> {
  const skins = json.skins
  if (!skins) return []
  if (Array.isArray(skins)) {
    return skins.map((skin, i) => ({
      name: skin.name ?? `skin${i}`,
      attachments: skin.attachments ?? {}
    }))
  }
  return Object.entries(skins).map(([name, attachments]) => ({ name, attachments }))
}

function blendOf(blend: string | undefined): BlendMode {
  switch ((blend ?? '').toLowerCase()) {
    case 'add':
    case 'additive':
      return BlendMode.Additive
    case 'multiply':
      return BlendMode.Multiply
    case 'screen':
      return BlendMode.Screen
    case 'erase':
      return BlendMode.Erase
    case 'mask':
      return BlendMode.Mask
    case 'below':
      return BlendMode.Below
    case 'none':
      return BlendMode.None
    default:
      return BlendMode.Normal
  }
}

/**
 * 权重数组：[boneCount, (boneIdx, vx, vy, w) × n] × 顶点数
 * → 骨骼下标重映射 + top-4 归并 + 归一化。
 * lx/ly 是 Spine 给出的**骨骼局部坐标**，直接使用（仅做像素 → 世界单位换算）。
 */
function parseWeights(weights: readonly number[], vertexCount: number, ctx: AttachmentContext): VertexWeight[] {
  const out: VertexWeight[] = []
  const boneCount = ctx.origToNew.length
  let cursor = 0
  for (let v = 0; v < vertexCount; v++) {
    const count = weights[cursor] ?? 0
    cursor += 1
    const entries: Array<{ bone: number; lx: number; ly: number; w: number }> = []
    for (let k = 0; k < count; k++) {
      const rawBone = weights[cursor] ?? 0
      const lx = weights[cursor + 1] ?? 0
      const ly = weights[cursor + 2] ?? 0
      const w = weights[cursor + 3] ?? 0
      cursor += 4
      const mapped = rawBone >= 0 && rawBone < boneCount ? ctx.origToNew[rawBone] : 0
      entries.push({ bone: mapped, lx, ly, w })
    }
    const sorted = entries
      .filter((e) => e.w > 1e-6)
      .sort((a, b) => b.w - a.w)
      .slice(0, 4)
    const total = sorted.reduce((sum, e) => sum + e.w, 0)
    out.push(packVertexWeight(sorted.map((e) => ({ ...e, w: total > 0 ? e.w / total : 0 }))))
  }
  return out
}

function packVertexWeight(entries: Array<{ bone: number; lx: number; ly: number; w: number }>): VertexWeight {
  const result: VertexWeight = {
    b0: 0,
    b1: 0,
    b2: 0,
    b3: 0,
    lx0: 0,
    ly0: 0,
    lx1: 0,
    ly1: 0,
    lx2: 0,
    ly2: 0,
    lx3: 0,
    ly3: 0,
    w0: 0,
    w1: 0,
    w2: 0,
    w3: 0
  }
  const bones = [0, 0, 0, 0]
  const lxs = [0, 0, 0, 0]
  const lys = [0, 0, 0, 0]
  const ws = [0, 0, 0, 0]
  for (let k = 0; k < entries.length && k < 4; k++) {
    bones[k] = entries[k].bone
    lxs[k] = pxToUnit(entries[k].lx)
    lys[k] = pxToUnit(entries[k].ly)
    ws[k] = entries[k].w
  }
  result.b0 = bones[0]
  result.b1 = bones[1]
  result.b2 = bones[2]
  result.b3 = bones[3]
  result.lx0 = lxs[0]
  result.ly0 = lys[0]
  result.lx1 = lxs[1]
  result.ly1 = lys[1]
  result.lx2 = lxs[2]
  result.ly2 = lys[2]
  result.lx3 = lxs[3]
  result.ly3 = lys[3]
  result.w0 = ws[0]
  result.w1 = ws[1]
  result.w2 = ws[2]
  result.w3 = ws[3]
  return result
}

function resolveRegion(
  attachment: SpineAttachmentJson,
  ctx: AttachmentContext
): AtlasRegion | null {
  const key = attachment.path ?? attachment.name ?? ''
  const region = ctx.regions.get(key)
  if (!region) {
    ctx.warnings.push(`附件的图集区域「${key}」不存在，贴图可能显示异常`)
    return null
  }
  return region
}

function convertAttachment(attachment: SpineAttachmentJson, ctx: AttachmentContext): AttachmentData {
  const type = (attachment.type ?? '').toLowerCase()
  const base = {
    name: attachment.name ?? '',
    position: { x: pxToUnit(attachment.x ?? 0), y: pxToUnit(attachment.y ?? 0) },
    rotation: attachment.rotation ?? 0,
    scale: { x: attachment.scaleX ?? 1, y: attachment.scaleY ?? 1 },
    color: parseHexColor(attachment.color)
  }

  if (type === 'linkedmesh') {
    const region = resolveRegion(attachment, ctx)
    return createAttachmentData({
      ...base,
      type: AttachmentType.LinkedMesh,
      textureName: region ? region.page : '',
      size: { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
      linkedMeshSkin: (attachment as { skin?: string }).skin ?? '',
      linkedMeshAttachment: (attachment as { parent?: string }).parent ?? ''
    })
  }

  if (type === 'mesh') {
    const region = resolveRegion(attachment, ctx)
    const meshUvs = attachment.uvs ?? []
    const uvCount = Math.floor(meshUvs.length / 2)
    const rawVertices = attachment.vertices ?? []
    const vertexCount = uvCount > 0 ? uvCount : Math.floor(rawVertices.length / 2)
    const vertices = new Float32Array(vertexCount * 2)
    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 2] = pxToUnit(rawVertices[i * 2] ?? 0)
      vertices[i * 2 + 1] = pxToUnit(rawVertices[i * 2 + 1] ?? 0)
    }
    const uvs = region ? mapRegionRelativeUvs(meshUvs, region, ctx.pageSizes) : Float32Array.from(meshUvs)
    const rawWeights = attachment.weights ?? []
    const weights = rawWeights.length > 0 ? parseWeights(rawWeights, vertexCount, ctx) : []
    return createAttachmentData({
      ...base,
      type: AttachmentType.Mesh,
      textureName: region ? region.page : '',
      size: { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
      uvs,
      vertices,
      triangles: attachment.triangles ?? [],
      edges: attachment.edges ?? [],
      hull: attachment.hull ?? 0,
      weights,
      // FFD 偏移与网格顶点同空间（附件显示空间），加权蒙皮时由运行期按 bindpose 转到骨内
      ffdInBoneSpace: false
    })
  }

  if (type === 'boundingbox' || type === 'clipping' || type === 'point' || type === 'path') {
    const rawVertices = attachment.vertices ?? []
    const vertices = new Float32Array(rawVertices.length)
    for (let i = 0; i < rawVertices.length; i++) vertices[i] = pxToUnit(rawVertices[i])
    return createAttachmentData({
      ...base,
      type: AttachmentType.BoundingBox,
      vertices,
      triangles: attachment.polygons ?? [],
      hull: attachment.hull ?? 0
    })
  }

  // region
  const region = resolveRegion(attachment, ctx)
  const geometry = region ? regionGeometry(region, attachment.width, attachment.height) : null
  return createAttachmentData({
    ...base,
    type: AttachmentType.Region,
    textureName: region ? region.page : '',
    position: {
      x: base.position.x + (geometry ? geometry.offsetX : 0),
      y: base.position.y + (geometry ? geometry.offsetY : 0)
    },
    size: geometry
      ? { x: geometry.width, y: geometry.height }
      : { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
    uvs: region ? regionUvs(region, ctx.pageSizes) : Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1])
  })
}

/**
 * Spine（骨骼 JSON + .atlas）→ Runtime 模型。
 *
 * 要点：
 * - 骨骼拓扑排序后重映射下标（权重里的骨骼下标也一并重映射）
 * - 动画关键帧是**相对 setup 的增量**，转换期叠加成绝对值
 * - mesh 的 uvs 是区域相对坐标，按图集页归一化并 v 翻转
 * - bindposes 由 setup pose 的矩阵式 FK（含 shear）求逆得到
 */
export function importSpine(input: SpineImportInput): SpineImportResult {
  const warnings: string[] = []
  const json = input.json
  const { ordered, index: boneIndex, origToNew } = orderBones(json.bones ?? [], warnings)
  const bones = toBoneData(ordered, boneIndex)

  const slotJsons = json.slots ?? []
  const slots: SlotData[] = []
  const slotIndexByName = new Map<string, number>()
  slotJsons.forEach((slot: SpineSlotJson, i) => {
    const bone = boneIndex.get(slot.bone)
    if (bone === undefined) warnings.push(`插槽「${slot.name}」挂载的骨骼「${slot.bone}」不存在，已挂到根骨骼`)
    slotIndexByName.set(slot.name, i)
    slots.push({
      name: slot.name,
      boneIndex: bone ?? 0,
      color: parseHexColor(slot.color),
      blendMode: blendOf(slot.blend),
      defaultDisplayIndex: -1,
      defaultZOrder: i,
      z: 0,
      setupAttachment: slot.attachment ?? ''
    })
  })

  const skeletonOnly = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: json.skeleton?.spine ? 'spine' : 'spine',
    frameRate: json.skeleton?.fps && json.skeleton.fps > 0 ? json.skeleton.fps : 30,
    bones,
    slots,
    skins: [],
    constraints: [],
    animations: [],
    textureNames: [],
    defaultSkinIndex: 0,
    runtimeIK: true,
    images: []
  })
  const setup = createSetupPose(skeletonOnly)
  const bindposes = computeBindposes(skeletonOnly)

  const ctx: AttachmentContext = {
    origToNew,
    bindposes,
    setupWorld: setup.world,
    regions: indexRegions(input.regions),
    pageSizes: input.pageSizes,
    warnings
  }

  const skins: SkinData[] = normalizeSkins(json).map((skin) => ({
    name: skin.name,
    slots: Object.entries(skin.attachments).map<SkinSlotData>(([slotName, attachments]) => ({
      slotName,
      attachments: Object.entries(attachments).map(([name, attachment]) =>
        convertAttachment({ ...attachment, name: attachment.name ?? name }, ctx)
      )
    }))
  }))

  // setup 显示的附件：在默认皮肤里按名解析出真正的显示下标
  const defaultSkinIndex = Math.max(0, skins.findIndex((s) => s.name === 'default'))
  const defaultSkin = skins[defaultSkinIndex]
  for (const slot of slots) {
    if (!slot.setupAttachment) continue
    const skinSlot = defaultSkin?.slots.find((s) => s.slotName === slot.name)
    if (!skinSlot) continue
    const found = skinSlot.attachments.findIndex((a) => a.name === slot.setupAttachment)
    if (found >= 0) slot.defaultDisplayIndex = found
  }

  const textureNames: string[] = []
  for (const skin of skins) {
    for (const slot of skin.slots) {
      for (const attachment of slot.attachments) {
        if (attachment.textureName && !textureNames.includes(attachment.textureName)) {
          textureNames.push(attachment.textureName)
        }
      }
    }
  }

  const constraints = buildConstraints(json, boneIndex, warnings)

  // 默认皮肤下「插槽 → 附件名 → 下标」，供 attachment 轨道把名字解析成烘焙下标
  const attIndexBySlot = new Map<string, Map<string, number>>()
  for (const skinSlot of defaultSkin?.slots ?? []) {
    const map = new Map<string, number>()
    skinSlot.attachments.forEach((attachment, i) => map.set(attachment.name, i))
    attIndexBySlot.set(skinSlot.slotName, map)
  }

  const animations: AnimData[] = Object.entries(json.animations ?? {}).map(([name, animation]) =>
    importSpineAnimations(name, animation, {
      boneIndex,
      slotIndex: slotIndexByName,
      bones,
      constraints,
      attIndexBySlot,
      regions: ctx.regions,
      pageSizes: ctx.pageSizes,
      warnings
    })
  )

  const images: ImageRef[] = textureNames.map((name) => ({
    name,
    path: input.pageImages?.[name] ?? name,
    width: input.pageSizes[name]?.width ?? 0,
    height: input.pageSizes[name]?.height ?? 0
  }))

  const asset = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: 'armature',
    frameRate: skeletonOnly.frameRate,
    bones,
    slots,
    skins,
    constraints,
    animations,
    textureNames,
    defaultSkinIndex,
    runtimeIK: true,
    images
  })
  asset.bindposes = bindposes

  return { asset, warnings }
}

function buildConstraints(
  json: SpineJson,
  boneIndex: Map<string, number>,
  warnings: string[]
): Constraint[] {
  const constraints: Constraint[] = []

  for (const ik of json.ik ?? []) {
    const bones = remapBones(ik.bones, boneIndex)
    const target = boneIndex.get(ik.target)
    if (bones.length === 0 || target === undefined) {
      warnings.push(`IK「${ik.name}」的目标或骨骼链无效，已跳过`)
      continue
    }
    constraints.push(
      createIkConstraint({
        name: ik.name,
        order: ik.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: target,
        mix: ik.mix ?? 1,
        bendSign: ik.bendPositive === false ? -1 : 1,
        useBoneLength: false,
        compress: ik.compress ?? false,
        stretch: ik.stretch ?? false,
        softness: ik.softness ?? 0
      })
    )
  }

  for (const transform of json.transform ?? []) {
    const bones = remapBones(transform.bones, boneIndex)
    const target = boneIndex.get(transform.target)
    if (bones.length === 0 || target === undefined) {
      warnings.push(`变换约束「${transform.name}」的目标或骨骼链无效，已跳过`)
      continue
    }
    constraints.push(
      createTransformConstraint({
        name: transform.name,
        order: transform.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: target,
        mixRotate: transform.mixRotate ?? 1,
        mixX: transform.mixX ?? 1,
        mixY: transform.mixY ?? 1,
        mixScaleX: transform.mixScaleX ?? 1,
        mixScaleY: transform.mixScaleY ?? 1,
        mixShearY: transform.mixShearY ?? 1,
        offsetRotate: transform.rotate ?? 0,
        offsetX: pxToUnit(transform.x ?? 0),
        offsetY: pxToUnit(transform.y ?? 0),
        offsetScaleX: transform.scaleX ?? 0,
        offsetScaleY: transform.scaleY ?? 0,
        offsetShearY: transform.shearY ?? 0,
        relative: transform.relative ?? false,
        local: transform.local ?? false,
        inherit: 'normal'
      })
    )
  }

  for (const path of json.path ?? []) {
    const bones = remapBones(path.bones, boneIndex)
    if (bones.length === 0 || path.target === undefined) {
      warnings.push(`路径约束「${path.name}」信息不完整，已跳过`)
      continue
    }
    constraints.push(
      createPathConstraint({
        name: path.name,
        order: path.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: boneIndex.get(path.target) ?? -1,
        position: path.position ?? 0,
        spacing: path.spacing ?? 0,
        rotateMix: path.rotateMix ?? 1,
        translateMix: path.translateMix ?? 1,
        positionMode: path.positionMode === 'fixed' ? 'fixed' : 'percent',
        spacingMode:
          path.spacingMode === 'fixed' || path.spacingMode === 'percent' ? path.spacingMode : 'length',
        rotateMode:
          path.rotateMode === 'chainScale' || path.rotateMode === 'tangent' ? path.rotateMode : 'chain'
      })
    )
  }

  for (const physics of json.physics ?? []) {
    constraints.push(
      createPhysicsConstraint({
        name: physics.name,
        order: physics.order ?? 0,
        enabled: true,
        boneIndices: Array.isArray(physics.bones) ? remapBones(physics.bones as string[], boneIndex) : [],
        targetBoneIndex: -1,
        raw: { ...physics }
      })
    )
  }

  return constraints
}

function remapBones(names: readonly string[], boneIndex: Map<string, number>): number[] {
  return names.map((name) => boneIndex.get(name)).filter((v): v is number => v !== undefined)
}

export { emptyIkAnim }
export type { SpineJson }
