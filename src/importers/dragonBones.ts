import { AttachmentType, AnimType, BlendMode, createAttachmentData, createBoneData } from '@core/model/types'
import type { AttachmentData, BoneData, ImageRef, SkinData, SlotData, VertexWeight } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { computeBindposes, createSetupPose } from '@core/model/setup'
import { createIkConstraint } from '@core/model/constraints'
import type { IkConstraint } from '@core/model/constraints'
import { Easing, emptyBoneAnim, emptyDeformAnim, emptySlotAnim } from '@core/model/animation'
import type { AnimData, BoneAnim, DeformAnim, DrawOrderKeyframe, EventKeyframe, IkAnim, SlotAnim } from '@core/model/animation'
import { PPU, pxToUnit } from './uv'
import { indexDbSubTextures } from './dragonBonesAtlas'
import type { DbSubTexture } from './dragonBonesAtlas'
import type {
  DbAnimationJson,
  DbArmatureJson,
  DbBoneJson,
  DbDisplayJson,
  DbFrameEasingJson,
  DbJson,
  DbSkinSlotJson,
  DbSlotJson
} from './dragonBonesTypes'

export interface DragonBonesImportInput {
  json: DbJson
  /** 合并后的所有图集 SubTexture（多张 texture_N.json） */
  subTextures: readonly DbSubTexture[]
  pageSizes: Record<string, { width: number; height: number }>
  pageImages?: Record<string, string>
}

export interface DragonBonesImportResult {
  asset: RuntimeAsset
  warnings: string[]
}

const FLIP_Y = -1

function armatureOf(json: DbJson, name?: string): DbArmatureJson | null {
  const list = json.armature ?? []
  if (list.length === 0) return null
  if (!name) return list[0]
  return list.find((a) => a.name === name) ?? list[0]
}

/** DB 骨骼命名空间用「父名/子名」，去重时保留最后一段 */
function shortName(full: string): string {
  const slash = full.lastIndexOf('/')
  return slash >= 0 ? full.slice(slash + 1) : full
}

function orderBones(bones: readonly DbBoneJson[], warnings: string[]): {
  ordered: DbBoneJson[]
  index: Map<string, number>
  origToNew: number[]
} {
  const byName = new Map<string, DbBoneJson>()
  for (const bone of bones) byName.set(bone.name, bone)

  const ordered: DbBoneJson[] = []
  const visited = new Set<string>()
  const visit = (bone: DbBoneJson, depth: number): void => {
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
  return { ordered, index, origToNew: bones.map((b) => index.get(b.name) ?? 0) }
}

function blendOf(mode: number | string | undefined): BlendMode {
  const value = typeof mode === 'number' ? mode : Number(mode ?? 0)
  switch (value) {
    case 1:
      return BlendMode.Additive
    case 2:
      return BlendMode.Multiply
    case 3:
      return BlendMode.Screen
    case 4:
      return BlendMode.Erase
    case 5:
      return BlendMode.Mask
    case 6:
      return BlendMode.Below
    case 7:
      return BlendMode.None
    default:
      return BlendMode.Normal
  }
}

/** DB 颜色：乘数（0~100）+ 偏移（-255~255），相加后 clamp01 */
function dbColor(raw: DbBoneColorJson | undefined, base = { r: 1, g: 1, b: 1, a: 1 }): {
  r: number
  g: number
  b: number
  a: number
} {
  if (!raw) return { ...base }
  const mix = (m: number | undefined, o: number | undefined, fallback: number): number => {
    const multiplier = (m ?? 100) / 100
    const offset = (o ?? 0) / 255
    return Math.max(0, Math.min(1, fallback * multiplier + offset))
  }
  return {
    r: mix(raw.rM, raw.rO, base.r),
    g: mix(raw.gM, raw.gO, base.g),
    b: mix(raw.bM, raw.bO, base.b),
    a: mix(raw.aM, raw.aO, base.a)
  }
}

interface DbBoneColorJson {
  aM?: number
  rM?: number
  gM?: number
  bM?: number
  aO?: number
  rO?: number
  gO?: number
  bO?: number
}

/** slotPose：[a,b,c,d,tx,ty] 的 y 反射矩阵（列主序 4x4 的 2x2 + 平移） */
function slotPoseMatrix(pose: readonly number[] | undefined): Float32Array {
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  if (!pose || pose.length < 6) return m
  m[0] = pose[0]
  m[1] = -pose[1]
  m[4] = -pose[2]
  m[5] = pose[3]
  m[12] = pxToUnit(pose[4])
  m[13] = -pxToUnit(pose[5])
  return m
}

function mulPoint(m: Float32Array, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[4] * y + m[12], y: m[1] * x + m[5] * y + m[13] }
}

interface AttachmentContext {
  bindposes: Float32Array
  setupWorld: Float32Array
  subTextures: Map<string, DbSubTexture>
  origToNew: number[]
  warnings: string[]
}

/** 顶点：DB 为 y-down 且以像素计，统一做 y 翻转 + ÷PPU */
function flipVertex(value: number, index: number): number {
  return index % 2 === 1 ? pxToUnit(value * FLIP_Y) : pxToUnit(value)
}

function parseDbWeights(
  weights: readonly number[],
  vertexCount: number,
  ctx: AttachmentContext,
  slotPose: Float32Array
): VertexWeight[] {
  const out: VertexWeight[] = []
  const boneCount = ctx.origToNew.length
  let cursor = 0
  for (let v = 0; v < vertexCount; v++) {
    if (cursor >= weights.length) {
      // 数据提前耗尽（导出损坏）：补空权重，保证返回值和顶点一一对应
      out.push(packWeights([], 0, ctx, slotPose, v))
      continue
    }
    // DragonBones 的 weights 结构是「[骨骼数, (骨骼下标, 权重) × 骨骼数]」逐顶点排列，
    // 每组占 1 + 2×count 个数。
    // 早先这里按「每根骨骼固定吃 3 个数」推进（cursor += 3），只在「顶点只绑 1 根骨骼」
    // 时凑巧正确；一旦出现绑 2 根以上的顶点，后面**所有**顶点的骨骼与权重就整体错位，
    // 表现为导入后网格被乱骨骼拉扯、部件散架（SkinnedMeshAnim 这类例子必错）。
    const count = Math.max(0, Math.round(weights[cursor] ?? 0))
    cursor += 1
    const entries: Array<{ bone: number; lx: number; ly: number; w: number }> = []
    for (let k = 0; k < count; k++) {
      const rawBone = weights[cursor] ?? 0
      const w = weights[cursor + 1] ?? 0
      cursor += 2
      const mapped = rawBone >= 0 && rawBone < boneCount ? ctx.origToNew[rawBone] : 0
      entries.push({ bone: mapped, lx: 0, ly: 0, w })
    }
    const sorted = entries.filter((e) => e.w > 1e-6).sort((a, b) => b.w - a.w).slice(0, 4)
    const total = sorted.reduce((sum, e) => sum + e.w, 0)
    out.push(packWeights(sorted, total, ctx, slotPose, v))
  }
  return out
}

/** 权重只给了骨骼下标与权值：局部坐标需要从「顶点在世界空间的位置」反算 */
function packWeights(
  entries: Array<{ bone: number; w: number }>,
  total: number,
  ctx: AttachmentContext,
  slotPose: Float32Array,
  vertexIndex: number
): VertexWeight {
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
  void slotPose
  void vertexIndex
  const bones = [0, 0, 0, 0]
  const ws = [0, 0, 0, 0]
  for (let k = 0; k < entries.length && k < 4; k++) {
    bones[k] = entries[k].bone
    ws[k] = total > 0 ? entries[k].w / total : 0
  }
  result.b0 = bones[0]
  result.b1 = bones[1]
  result.b2 = bones[2]
  result.b3 = bones[3]
  result.w0 = ws[0]
  result.w1 = ws[1]
  result.w2 = ws[2]
  result.w3 = ws[3]
  return result
}

function convertDisplay(
  display: DbDisplayJson,
  ctx: AttachmentContext,
  slotBoneIndex: number
): AttachmentData | null {
  const type = (display.type ?? 'image').toLowerCase()
  if (type === 'armature') return null

  const transform = display.transform ?? {}
  const base = {
    name: display.name ?? '',
    position: { x: pxToUnit(transform.x ?? 0), y: -pxToUnit(transform.y ?? 0) },
    rotation: -(transform.skX ?? 0),
    scale: { x: transform.scX ?? 1, y: transform.scY ?? 1 }
  }

  if (type === 'mesh') {
    const rawVertices = display.vertices ?? []
    const vertexCount = Math.floor(rawVertices.length / 2)
    const vertices = new Float32Array(vertexCount * 2)
    for (let i = 0; i < vertices.length; i++) vertices[i] = flipVertex(rawVertices[i], i)

    const uvs = new Float32Array(vertexCount * 2)
    const subTexture = ctx.subTextures.get(display.path ?? display.name ?? '')
    const rawUvs = display.uvs ?? []
    for (let i = 0; i < vertexCount; i++) {
      const u = rawUvs[i * 2] ?? 0
      const v = rawUvs[i * 2 + 1] ?? 0
      if (subTexture) {
        // DB 的 mesh uvs 是「区域内的相对坐标」，v=0 指向区域**顶边**（与官方 UnitySlot 一致）。
        // 映射到图集再翻成 uv 的底左原点：v 直接用，只对图集 y 做一次 1-y。
        // （早先多套了一层 (1-v)，等于把网格贴图上下翻了过来 —— 纹理会与顶点错位。）
        uvs[i * 2] = (subTexture.x + u * subTexture.width) / Math.max(1, subTexture.textureWidth)
        uvs[i * 2 + 1] = 1 - (subTexture.y + v * subTexture.height) / Math.max(1, subTexture.textureHeight)
      } else {
        uvs[i * 2] = u
        uvs[i * 2 + 1] = 1 - v
      }
    }

    // 加权网格：局部坐标 = bindpose[b] · (slotPose · vertex)
    const slotPose = slotPoseMatrix(display.slotPose)
    const rawWeights = display.weights ?? []
    let weights: VertexWeight[] = []
    if (rawWeights.length > 0) {
      const weighted = parseDbWeights(rawWeights, vertexCount, ctx, slotPose)
      for (let i = 0; i < vertexCount; i++) {
        const world = mulPoint(slotPose, vertices[i * 2], vertices[i * 2 + 1])
        const entry = weighted[i]
        fillLocal(entry, ctx.bindposes, world.x, world.y)
      }
      weights = weighted
    }

    return createAttachmentData({
      ...base,
      type: AttachmentType.Mesh,
      textureName: subTexture?.textureName ?? '',
      size: { x: pxToUnit(display.width ?? 0), y: pxToUnit(display.height ?? 0) },
      uvs,
      vertices,
      triangles: display.triangles ?? [],
      edges: display.edges ?? [],
      hull: display.hull ?? 0,
      weights,
      ffdInBoneSpace: false
    })
  }

  if (type === 'boundingbox') {
    const rawVertices = display.vertices ?? []
    const vertices = new Float32Array(rawVertices.length)
    for (let i = 0; i < vertices.length; i++) vertices[i] = flipVertex(rawVertices[i], i)
    return createAttachmentData({
      ...base,
      type: AttachmentType.BoundingBox,
      vertices,
      triangles: display.triangles ?? [],
      hull: display.hull ?? 0
    })
  }

  // image（Region）
  const subTexture = ctx.subTextures.get(display.path ?? display.name ?? '')
  if (!subTexture) ctx.warnings.push(`附件「${display.name ?? ''}」的图集区域不存在`)
  const frameWidth = subTexture ? (subTexture.frameWidth || subTexture.width) : 0
  const frameHeight = subTexture ? (subTexture.frameHeight || subTexture.height) : 0
  const packedWidth = subTexture?.width ?? 0
  const packedHeight = subTexture?.height ?? 0
  // 裁剪偏移：裁剪块中心相对原图中心（y 向上）
  const centerX = (packedWidth - frameWidth) * 0.5 - (subTexture?.frameX ?? 0)
  const centerY = (frameHeight - packedHeight) * 0.5 + (subTexture?.frameY ?? 0)
  void slotBoneIndex

  return createAttachmentData({
    ...base,
    type: AttachmentType.Region,
    textureName: subTexture?.textureName ?? '',
    position: {
      x: base.position.x + pxToUnit(centerX),
      y: base.position.y + pxToUnit(centerY)
    },
    size: { x: pxToUnit(frameWidth || packedWidth), y: pxToUnit(frameHeight || packedHeight) },
    uvs: subTexture
      ? Float32Array.from([
          subTexture.x / subTexture.textureWidth,
          1 - (subTexture.y + subTexture.height) / subTexture.textureHeight,
          (subTexture.x + subTexture.width) / subTexture.textureWidth,
          1 - (subTexture.y + subTexture.height) / subTexture.textureHeight,
          (subTexture.x + subTexture.width) / subTexture.textureWidth,
          1 - subTexture.y / subTexture.textureHeight,
          subTexture.x / subTexture.textureWidth,
          1 - subTexture.y / subTexture.textureHeight
        ])
      : Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1])
  })
}

/** 用 bindpose 把「世界/骨架空间」的顶点反算成每骨骼局部坐标 */
function fillLocal(entry: VertexWeight, bindposes: Float32Array, worldX: number, worldY: number): void {
  const count = Math.max(1, Math.floor(bindposes.length / 16))
  const localX = (bone: number): number => {
    const o = Math.max(0, Math.min(count - 1, bone)) * 16
    return bindposes[o] * worldX + bindposes[o + 4] * worldY + bindposes[o + 12]
  }
  const localY = (bone: number): number => {
    const o = Math.max(0, Math.min(count - 1, bone)) * 16
    return bindposes[o + 1] * worldX + bindposes[o + 5] * worldY + bindposes[o + 13]
  }
  entry.lx0 = localX(entry.b0)
  entry.ly0 = localY(entry.b0)
  entry.lx1 = localX(entry.b1)
  entry.ly1 = localY(entry.b1)
  entry.lx2 = localX(entry.b2)
  entry.ly2 = localY(entry.b2)
  entry.lx3 = localX(entry.b3)
  entry.ly3 = localY(entry.b3)
}

/**
 * DragonBones（骨骼 JSON + texture_N.json 图集）→ Runtime 模型。
 *
 * 要点：
 * - y-down → y-up：位置 y 取反、旋转取反、顶点与 FFD 的奇数下标取反
 * - 动画时间以帧计，统一除以 frameRate 转秒
 * - 多张图集合并成「SubTexture 名 → 页」表，附件 UV 按各自页尺寸归一化
 * - 加权网格：局部坐标 = bindpose[骨骼] · (slotPose · 顶点)
 * - playTimes == 0（无限循环）时在末尾补一帧等于首帧的关键帧
 */
export function importDragonBones(input: DragonBonesImportInput): DragonBonesImportResult {
  const warnings: string[] = []
  const armature = armatureOf(input.json, undefined)
  if (!armature) {
    warnings.push('DragonBones 数据里没有 armature 段')
    return { asset: createRuntimeAsset({ dataType: AnimType.DragonBone }), warnings }
  }

  const { ordered, index: boneIndex, origToNew } = orderBones(armature.bone ?? [], warnings)
  const boneData: BoneData[] = ordered.map((bone) => {
    const transform = bone.transform ?? {}
    const parentIndex = bone.parent ? (boneIndex.get(bone.parent) ?? -1) : -1
    return createBoneData({
      name: shortName(bone.name),
      parentIndex,
      localPosition: { x: pxToUnit(transform.x ?? 0), y: -pxToUnit(transform.y ?? 0) },
      rotation: -(transform.skX ?? 0),
      localScale: { x: transform.scX ?? 1, y: transform.scY ?? 1 },
      localShear: { x: 0, y: 0 },
      inheritRotation: bone.inheritRotation !== false,
      inheritScale: bone.inheritScale !== false,
      length: pxToUnit(bone.length ?? 0)
    })
  })

  const slotJsons = armature.slot ?? []
  const slots: SlotData[] = slotJsons.map((slot: DbSlotJson, i) => ({
    name: slot.name,
    boneIndex: boneIndex.get(slot.parent ?? '') ?? 0,
    color: dbColor(slot.color as DbBoneColorJson | undefined),
    blendMode: blendOf(slot.blendMode),
    defaultDisplayIndex: -1,
    defaultZOrder: typeof slot.z === 'number' ? slot.z : i,
    z: 0,
    setupAttachment: ''
  }))
  const slotIndexByName = new Map<string, number>()
  slots.forEach((slot, i) => slotIndexByName.set(slot.name, i))

  const skeletonOnly = createRuntimeAsset({
    dataType: AnimType.DragonBone,
    armatureName: armature.name ?? 'armature',
    frameRate: armature.frameRate ?? input.json.frameRate ?? 24,
    bones: boneData,
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
    bindposes,
    setupWorld: setup.world,
    subTextures: indexDbSubTextures(input.subTextures),
    origToNew,
    warnings
  }

  const skins: SkinData[] = (armature.skin ?? [{ name: 'default', slot: [] }]).map((skin, skinIdx) => ({
    name: skin.name ?? (skinIdx === 0 ? 'default' : `skin${skinIdx}`),
    slots: (skin.slot ?? []).map((skinSlot: DbSkinSlotJson) => {
      const slotIndex = slotIndexByName.get(skinSlot.name ?? '')
      const boneIdx = slotIndex !== undefined ? slots[slotIndex].boneIndex : 0
      return {
        slotName: skinSlot.name ?? '',
        attachments: (skinSlot.display ?? [])
          .map((display: DbDisplayJson) => convertDisplay(display, ctx, boneIdx))
          .filter((a): a is AttachmentData => a !== null)
      }
    })
  }))

  // setup 显示下标
  const defaultSkinIndex = Math.max(0, skins.findIndex((s) => s.name === 'default'))
  const defaultSkin = skins[defaultSkinIndex]
  slotJsons.forEach((slot: DbSlotJson, i) => {
    const target = slots[i]
    const skinSlot = defaultSkin?.slots.find((s) => s.slotName === slot.name)
    const displayIndex = slot.displayIndex ?? 0
    if (skinSlot && displayIndex >= 0 && displayIndex < skinSlot.attachments.length) {
      target.defaultDisplayIndex = displayIndex
      target.setupAttachment = skinSlot.attachments[displayIndex].name
    }
  })

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

  const iks: IkConstraint[] = (armature.ik ?? []).map((ik) => {
    const bone = boneIndex.get(ik.bone ?? '')
    const target = boneIndex.get(ik.target ?? '')
    return createIkConstraint({
      name: ik.name ?? 'ik',
      order: 0,
      enabled: true,
      boneIndices: bone === undefined || target === undefined ? [] : [bone],
      targetBoneIndex: target ?? -1,
      mix: ik.weight ?? 1,
      bendSign: ik.bendPositive === false ? -1 : 1,
      // DragonBones 用「根骨 length × 缩放」作为 l1
      useBoneLength: true
    })
  }).filter((ik) => ik.boneIndices.length > 0 && ik.targetBoneIndex >= 0)

  const frameRate = armature.frameRate ?? input.json.frameRate ?? 24
  const animations: AnimData[] = (armature.animation ?? []).map((animation) =>
    importDbAnimation(animation, {
      boneIndex,
      slotIndex: slotIndexByName,
      bones: boneData,
      slots,
      iks,
      textureNames,
      frameRate,
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
    dataType: AnimType.DragonBone,
    armatureName: skeletonOnly.armatureName,
    frameRate,
    bones: boneData,
    slots,
    skins,
    constraints: iks,
    animations,
    textureNames,
    defaultSkinIndex,
    runtimeIK: true,
    images
  })
  asset.bindposes = bindposes

  return { asset, warnings }
}

interface DbAnimContext {
  boneIndex: Map<string, number>
  slotIndex: Map<string, number>
  bones: readonly BoneData[]
  slots: readonly SlotData[]
  iks: readonly IkConstraint[]
  textureNames: readonly string[]
  frameRate: number
  warnings: string[]
}

/**
 * 帧缓动：DB 的 `tweenEasing` **缺省 / null 表示线性补间**（导出时"线性"常常直接省略该字段），
 * 有 `curve` 数组时用贝塞尔，数值型缓动本转换器统一按线性近似。
 *
 * 早先把 null 当成「不补间（阶跃）」是反的：每段都会瞬间跳变，循环动画在末帧↔首帧
 * 还会抖一次 —— 这是"导入后动画看着不对"的主要原因之一。
 * displayIndex 这类真正的阶跃量在各自的解析处强制 Stepped，不依赖这里。
 */
function easingOfFrame(frame: DbFrameEasingJson): { easing: Easing; curve: number[] | null } {
  const raw = Array.isArray(frame.curve) ? frame.curve : null
  if (raw && raw.length >= 4) {
    return { easing: Easing.Bezier, curve: raw.slice(0, 4).map((value) => Number(value) || 0) }
  }
  return { easing: Easing.Linear, curve: null }
}

/** DB 动画：所有时间以帧计，除以 frameRate 转秒；playTimes == 0 时补循环闭合帧 */
function importDbAnimation(animation: DbAnimationJson, ctx: DbAnimContext): AnimData {
  const fps = animation.frameRate && animation.frameRate > 0 ? animation.frameRate : ctx.frameRate
  const toSeconds = (frames: number): number => frames / Math.max(1, fps)
  const playTimes = animation.playTimes ?? 0
  const loop = playTimes === 0

  const bones: BoneAnim[] = []
  for (const track of animation.bone ?? []) {
    const index = ctx.boneIndex.get(track.name ?? '')
    if (index === undefined) continue
    const bone = ctx.bones[index]
    const anim = emptyBoneAnim(index)
    const pushTranslate = (time: number, x: number, y: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.translate.push({
        time: toSeconds(time),
        value: { x: bone.localPosition.x + pxToUnit(x), y: bone.localPosition.y - pxToUnit(y) },
        easing: e.easing,
        curve: e.curve
      })
    }
    const pushRotate = (time: number, rotate: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.rotate.push({
        time: toSeconds(time),
        value: bone.rotation - rotate,
        easing: e.easing,
        curve: e.curve
      })
    }
    const pushScale = (time: number, scX: number, scY: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.scale.push({
        time: toSeconds(time),
        value: { x: bone.localScale.x * scX, y: bone.localScale.y * scY },
        easing: e.easing,
        curve: e.curve
      })
    }

    const legacy = track.frame ?? []
    let trackDuration = 0
    if (legacy.length > 0) {
      // 5.5 之前的旧格式：每帧带完整 transform（值为相对 setup 的增量）
      let time = 0
      for (const frame of legacy) {
        const transform = frame.transform ?? {}
        pushTranslate(time, transform.x ?? 0, transform.y ?? 0, frame)
        pushRotate(time, transform.skX ?? 0, frame)
        pushScale(time, transform.scX ?? 1, transform.scY ?? 1, frame)
        time += frame.duration ?? 0
      }
      trackDuration = time
    } else {
      // 5.x 新格式：通道拆开，`duration` 是「这一帧持续多少帧」，时间逐帧累加；
      // 单帧缺省的分量表示「增量为 0」（即保持 setup），所以**每一帧都要写** ——
      // 跳过"这一帧没给值"的帧，会让那一整段被相邻关键帧插值覆盖，姿势就错了。
      //
      // 早先只认旧格式 track.frame，新格式下一条关键帧都读不到 → 整段骨骼动画被当成
      // 空轨道丢掉，表现就是「导入后动画不动、蒙皮网格塌成碎片」（SkinnedMeshAnim 这类
      // 用新格式导出的工程必错）。
      let duration = 0
      let time = 0
      for (const frame of track.translateFrame ?? []) {
        pushTranslate(time, frame.x ?? 0, frame.y ?? 0, frame)
        time += frame.duration ?? 0
      }
      duration = Math.max(duration, time)
      time = 0
      for (const frame of track.rotateFrame ?? []) {
        pushRotate(time, frame.rotate ?? 0, frame)
        time += frame.duration ?? 0
      }
      duration = Math.max(duration, time)
      time = 0
      for (const frame of track.scaleFrame ?? []) {
        pushScale(time, frame.x ?? 1, frame.y ?? 1, frame)
        time += frame.duration ?? 0
      }
      trackDuration = Math.max(duration, time)
    }
    // 三条通道全空才算空轨道（只看 rotate 会把「只动位置」的骨骼整条丢掉）
    if (anim.rotate.length > 0 || anim.translate.length > 0 || anim.scale.length > 0) {
      closeLoop(anim, loop, toSeconds(trackDuration))
      bones.push(anim)
    }
  }

  const slots: SlotAnim[] = []
  for (const track of animation.slot ?? []) {
    const index = ctx.slotIndex.get(track.name ?? '')
    if (index === undefined) continue
    const slot = ctx.slots[index]
    const anim = emptySlotAnim(index)
    let time = 0
    let hasColor = false
    for (const frame of track.frame ?? []) {
      const displayIndex = frame.displayIndex ?? 0
      anim.displayIndex.push({
        time: toSeconds(time),
        value: displayIndex,
        easing: Easing.Stepped,
        curve: null
      })
      anim.displayAttachment.push('')
      if (frame.color) {
        const e = easingOfFrame(frame)
        anim.color.push({
          time: toSeconds(time),
          value: dbColor(frame.color as DbBoneColorJson, slot.color),
          easing: e.easing,
          curve: e.curve
        })
        hasColor = true
      }
      time += frame.duration ?? 0
    }
    if (anim.displayIndex.length > 0 || hasColor) slots.push(anim)
  }

  const deforms: DeformAnim[] = []
  for (const track of animation.ffd ?? []) {
    const index = ctx.slotIndex.get(track.slot ?? '')
    if (index === undefined) continue
    const anim = emptyDeformAnim(index, track.name ?? '')
    // DB 的 FFD 帧：`offset` 是**浮点数组下标**（起始顶点 = offset/2，需向下取偶），
    // `vertices` 是相对绑定位置的位移（y-down）；区间外的顶点补 0。
    // 这里烘焙成「满顶点长度」的数组（vertexOffset 恒为 0），运行期不必再做基址换算。
    const frames = track.frame ?? []
    let need = 0
    for (const frame of frames) {
      const start = Math.round(frame.offset ?? 0) & ~1
      need = Math.max(need, start + (frame.vertices?.length ?? 0))
    }
    let time = 0
    for (const frame of frames) {
      const start = Math.max(0, Math.round(frame.offset ?? 0) & ~1)
      const vertices = frame.vertices ?? []
      const offsets = new Array<number>(need).fill(0)
      for (let i = 0; i < vertices.length; i++) {
        // 奇偶按**段内相对下标**判断 —— 早先误用绝对下标（offset + i），
        // offset 为奇数时整个 x/y 会反转，FFD 直接把网格拉变形
        offsets[start + i] = flipVertex(vertices[i], i)
      }
      const e = easingOfFrame(frame)
      anim.frames.push({
        time: toSeconds(time),
        offsets,
        vertexOffset: 0,
        easing: e.easing,
        curve: e.curve
      })
      time += frame.duration ?? 0
    }
    if (anim.frames.length > 0) {
      closeLoopDeform(anim, loop, toSeconds(time))
      deforms.push(anim)
    }
  }

  const drawOrder: DrawOrderKeyframe[] = []
  const zOrderFrames = animation.zOrder?.frame ?? []
  {
    let time = 0
    for (const frame of zOrderFrames) {
      const pairs = frame.zOrder ?? []
      const order = ctx.slots.map((_, i) => i)
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const slotIndex = pairs[i]
        const offset = pairs[i + 1]
        const from = order.indexOf(slotIndex)
        if (from < 0) continue
        order.splice(from, 1)
        order.splice(Math.max(0, Math.min(order.length, from + offset)), 0, slotIndex)
      }
      drawOrder.push({ time: toSeconds(time), order })
      time += frame.duration ?? 0
    }
  }

  const events: EventKeyframe[] = []
  {
    let time = 0
    for (const frame of animation.frame ?? []) {
      const event = frame.event ?? frame.action
      if (event && typeof event.name === 'string' && event.name.length > 0) {
        events.push({
          time: toSeconds(time),
          name: event.name,
          stringParam: '',
          intParam: Math.round(event.data?.int ?? 0),
          floatParam: event.data?.float ?? 0
        })
      }
      time += frame.duration ?? 0
    }
  }

  const iks: IkAnim[] = []
  {
    let time = 0
    for (const frame of animation.ik ?? []) {
      const index = ctx.iks.findIndex((ik) => ik.name === frame.name)
      if (index < 0) continue
      const existing = iks.find((track) => track.ikIndex === index)
      const target = existing ?? { ikIndex: index, mix: [] }
      target.mix.push({
        time: toSeconds(time),
        value: frame.frame?.[0]?.weight ?? 1,
        easing: Easing.Linear,
        curve: null
      })
      if (!existing) iks.push(target)
      time += 0
    }
  }

  let duration = Math.max(toSeconds(animation.duration ?? 0), 0)
  for (const track of bones) {
    duration = Math.max(duration, track.rotate[track.rotate.length - 1]?.time ?? 0)
    duration = Math.max(duration, track.translate[track.translate.length - 1]?.time ?? 0)
  }
  for (const track of deforms) duration = Math.max(duration, track.frames[track.frames.length - 1]?.time ?? 0)
  for (const event of events) duration = Math.max(duration, event.time)

  return {
    name: animation.name ?? 'animation',
    duration: duration > 0 ? duration : 1,
    bones,
    slots,
    deforms,
    drawOrder,
    events,
    iks,
    constraints: []
  }
}

/** FFD 轨道的循环闭合：末尾补一帧「等于首帧偏移」，让末帧→回绕处连续 */
function closeLoopDeform(anim: DeformAnim, loop: boolean, duration: number): void {
  if (!loop || duration <= 0 || anim.frames.length === 0) return
  const first = anim.frames[0]
  const last = anim.frames[anim.frames.length - 1]
  if (last.time >= duration - 1e-6) return
  const same =
    first.offsets.length === last.offsets.length &&
    first.offsets.every((value, i) => Math.abs(value - last.offsets[i]) < 1e-5)
  if (same) return
  anim.frames.push({
    time: duration,
    offsets: first.offsets.slice(),
    vertexOffset: 0,
    easing: Easing.Linear,
    curve: null
  })
}

/** playTimes == 0（无限循环）时在末尾补一帧等于首帧的关键帧，角度走最短弧 */
function closeLoop(anim: BoneAnim, loop: boolean, duration: number): void {
  if (!loop || duration <= 0) return
  const firstRotate = anim.rotate[0]
  if (firstRotate && anim.rotate[anim.rotate.length - 1]?.time < duration) {
    let target = firstRotate.value
    const last = anim.rotate[anim.rotate.length - 1].value
    while (target - last > 180) target -= 360
    while (last - target > 180) target += 360
    anim.rotate.push({ time: duration, value: target, easing: Easing.Linear, curve: null })
  }
  for (const track of [anim.translate, anim.scale] as const) {
    const first = track[0]
    if (first && track[track.length - 1]?.time < duration) {
      track.push({ time: duration, value: { ...first.value }, easing: Easing.Linear, curve: null })
    }
  }
}

export { PPU }
