import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import { useProjectStore } from '../store/projectStore'
import type { RuntimeExportPlan } from './exportService'
import { readPageBytes } from './exportService'
import { encodeAtlasPages, loadImageBitmap } from './pngEncoder'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import type { RuntimeAsset } from '@core/model/asset'
import type { BoneData, AttachmentData, RGBA, VertexWeight } from '@core/model/types'
import { AttachmentType, BlendMode } from '@core/model/types'
import { Easing } from '@core/model/animation'
import type { AnimData, BoneAnim, SlotAnim, DeformAnim, ConstraintAnim, DrawOrderKeyframe } from '@core/model/animation'
import { sortConstraints } from '@core/model/constraints'
import type { SpineJson, SpineSlotJson, SpineSkinJson, SpineAttachmentJson, SpineAnimationJson, SpineCurveKeyframe, SpineTransformConstraintJson, SpinePathConstraintJson } from '@importers/spineTypes'
import type { RuntimeAtlasJson } from '@core/codec/runtimeSkeJson'
import type { ExportResult } from './exportService'

/** Spine 4.3 数据格式版本号（与示例资源对齐） */
const SPINE_VERSION = '4.3.74-beta'

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'armature'
}

/** RGBA(0..1) → Spine 颜色串 `rrggbbaa`（4.x 用 `rgba` 通道，注意不带 `#`，运行期 ToColor32 直接按 hex 解析） */
function rgbaToHex(color: RGBA): string {
  const h = (v: number): string => {
    const c = Math.max(0, Math.min(1, v))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `${h(color.r)}${h(color.g)}${h(color.b)}${h(color.a)}`
}

/** 骨骼继承模式：编辑器用两个布尔，Spine 4.2+ 用 `inherit` 枚举 */
function inheritMode(bone: BoneData): string {
  if (bone.inheritRotation && bone.inheritScale) return 'normal'
  if (!bone.inheritRotation && !bone.inheritScale) return 'onlyTranslation'
  if (!bone.inheritRotation && bone.inheritScale) return 'noRotationOrReflection'
  return 'noScale'
}

function blendName(mode: BlendMode): string {
  switch (mode) {
    case BlendMode.Additive:
      return 'additive'
    case BlendMode.Multiply:
      return 'multiply'
    case BlendMode.Screen:
      return 'screen'
    case BlendMode.Normal:
    default:
      return 'normal'
  }
}

/**
 * 把编辑器存的**归一化 0..1** 贝塞尔控制点转成 Spine 4.2+ 的**绝对 (时间, 值) 坐标**。
 * `t1/v1` 为当前帧、`t2/v2` 为下一帧（同一值空间），与 Spine 的 curve-on-frame = 本帧→下一帧一致。
 */
function absoluteCurve(
  norm: number[],
  t1: number,
  t2: number,
  v1: number,
  v2: number
): number[] {
  const dt = t2 - t1
  if (Math.abs(dt) < 1e-9) return [0, v1, 1, v1]
  const dv = v2 - v1
  return [
    t1 + norm[0] * dt,
    v1 + norm[1] * dv,
    t1 + norm[2] * dt,
    v1 + norm[3] * dv
  ]
}

/**
 * 为某条轨道的某帧生成 Spine 曲线：
 * - Stepped → 字符串 `"stepped"`
 * - Bezier  → 绝对坐标；多通道轨道展开成 8 个数（x 通道的归一化控制点复用到 y）
 * - Linear  → 省略
 */
function spineCurve(
  easing: Easing,
  curve: number[] | null,
  t1: number,
  t2: number,
  v1x: number,
  v2x: number,
  v1y?: number,
  v2y?: number
): number[] | string | undefined {
  if (easing === Easing.Stepped) return 'stepped'
  if (easing !== Easing.Bezier || !curve || curve.length < 4) return undefined
  const x = absoluteCurve(curve, t1, t2, v1x, v2x)
  if (v1y === undefined || v2y === undefined) return x
  const y = absoluteCurve(curve, t1, t2, v1y, v2y)
  return [...x, ...y]
}

// ---------------- 骨骼 / 插槽 / 皮肤 ----------------

function buildBones(asset: RuntimeAsset): SpineBoneJson[] {
  const byIndex = asset.bones
  return byIndex.map((bone) => {
    const json: SpineBoneJson = {
      name: bone.name,
      x: bone.localPosition.x * RUNTIME_PPU,
      y: bone.localPosition.y * RUNTIME_PPU,
      rotation: bone.rotation,
      scaleX: bone.localScale.x,
      scaleY: bone.localScale.y,
      shearX: bone.localShear.x,
      shearY: bone.localShear.y,
      inherit: inheritMode(bone)
    }
    if (bone.parentIndex >= 0 && bone.parentIndex < byIndex.length) {
      json.parent = byIndex[bone.parentIndex].name
    }
    if (bone.length > 0) json.length = bone.length * RUNTIME_PPU
    return json
  })
}

function buildSlots(asset: RuntimeAsset): SpineSlotJson[] {
  return asset.slots.map((slot) => {
    const json: SpineSlotJson = {
      name: slot.name,
      bone: asset.bones[slot.boneIndex]?.name ?? '',
      color: rgbaToHex(slot.color),
      blend: blendName(slot.blendMode)
    }
    if (slot.setupAttachment) json.attachment = slot.setupAttachment
    return json
  })
}

function spineAttachment(att: AttachmentData): SpineAttachmentJson {
  const path = att.regionName ?? att.textureName
  const base: SpineAttachmentJson = {
    name: att.name,
    path,
    x: att.position.x * RUNTIME_PPU,
    y: att.position.y * RUNTIME_PPU,
    rotation: att.rotation,
    scaleX: att.scale.x,
    scaleY: att.scale.y,
    color: rgbaToHex(att.color)
  }
  if (att.type === AttachmentType.Region) {
    base.type = 'region'
    base.width = att.size.x * RUNTIME_PPU
    base.height = att.size.y * RUNTIME_PPU
    return base
  }
  if (att.type === AttachmentType.BoundingBox) {
    base.type = 'boundingbox'
    base.vertices = Array.from(att.vertices).map((v) => v * RUNTIME_PPU)
    return base
  }
  if (att.type === AttachmentType.LinkedMesh) {
    base.type = 'linkedmesh'
    base.skin = att.linkedMeshSkin || undefined
    base.parent = att.linkedMeshAttachment || undefined
    base.width = att.size.x * RUNTIME_PPU
    base.height = att.size.y * RUNTIME_PPU
    return base
  }
  // Mesh
  base.type = 'mesh'
  base.uvs = Array.from(att.uvs)
  base.triangles = [...att.triangles]
  base.hull = att.hull
  if (att.edges && att.edges.length > 0) base.edges = [...att.edges]
  // 包围盒尺寸（像素）
  const verts = att.vertices
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < verts.length; i += 2) {
    minX = Math.min(minX, verts[i])
    maxX = Math.max(maxX, verts[i])
    minY = Math.min(minY, verts[i + 1])
    maxY = Math.max(maxY, verts[i + 1])
  }
  if (Number.isFinite(minX)) {
    base.width = (maxX - minX) * RUNTIME_PPU
    base.height = (maxY - minY) * RUNTIME_PPU
  }
  if (att.weights && att.weights.length > 0) {
    base.vertices = meshWeightedVertices(att)
  } else {
    base.vertices = Array.from(att.vertices).map((v) => v * RUNTIME_PPU)
  }
  return base
}

/** 加权网格顶点：Spine 格式 `[count, boneIdx, lx, ly, w, ...] × 顶点`（lx/ly 为骨骼局部像素坐标） */
function meshWeightedVertices(att: AttachmentData): number[] {
  const out: number[] = []
  const weights: VertexWeight[] = att.weights
  for (let v = 0; v < weights.length; v++) {
    const w = weights[v]
    const entries: Array<[number, number, number, number]> = []
    if (w.w0 > 0) entries.push([w.b0, w.lx0, w.ly0, w.w0])
    if (w.w1 > 0) entries.push([w.b1, w.lx1, w.ly1, w.w1])
    if (w.w2 > 0) entries.push([w.b2, w.lx2, w.ly2, w.w2])
    if (w.w3 > 0) entries.push([w.b3, w.lx3, w.ly3, w.w3])
    out.push(entries.length)
    for (const [bone, lx, ly, weight] of entries) {
      out.push(bone, lx * RUNTIME_PPU, ly * RUNTIME_PPU, weight)
    }
  }
  return out
}

function buildSkins(asset: RuntimeAsset): SpineSkinJson[] {
  return asset.skins.map((skin) => {
    const attachments: Record<string, Record<string, SpineAttachmentJson>> = {}
    for (const slot of skin.slots) {
      const slotEntries: Record<string, SpineAttachmentJson> = {}
      for (const att of slot.attachments) {
        slotEntries[att.name] = spineAttachment(att)
      }
      attachments[slot.slotName] = slotEntries
    }
    return { name: skin.name || 'default', attachments }
  })
}

// ---------------- 约束 ----------------

function boneNames(asset: RuntimeAsset, indices: number[]): string[] {
  return indices.map((i) => asset.bones[i]?.name ?? '').filter((n) => n.length > 0)
}

function buildConstraints(asset: RuntimeAsset): SpineJson['constraints'] {
  const out: Array<Record<string, unknown>> = []
  const sorted = sortConstraints(asset.constraints)
  for (const c of sorted) {
    const order = c.order
    if (c.type === 'ik') {
      out.push({
        type: 'ik',
        name: c.name,
        order,
        bones: boneNames(asset, (c as { boneIndices: number[] }).boneIndices),
        target: asset.bones[(c as { targetBoneIndex: number }).targetBoneIndex]?.name ?? '',
        mix: (c as { mix: number }).mix,
        bendPositive: (c as { bendSign: number }).bendSign > 0,
        softness: (c as { softness: number }).softness,
        compress: (c as { compress: boolean }).compress,
        stretch: (c as { stretch: boolean }).stretch
      })
    } else if (c.type === 'transform') {
      const t = c as unknown as SpineTransformConstraintJson
      out.push({
        type: 'transform',
        name: c.name,
        order,
        bones: boneNames(asset, (c as { boneIndices: number[] }).boneIndices),
        target: asset.bones[(c as { targetBoneIndex: number }).targetBoneIndex]?.name ?? '',
        mixRotate: t.mixRotate,
        mixX: t.mixX,
        mixY: t.mixY,
        mixScaleX: t.mixScaleX,
        mixScaleY: t.mixScaleY,
        mixShearY: t.mixShearY,
        offsetRotation: t.offsetRotate,
        offsetX: t.offsetX * RUNTIME_PPU,
        offsetY: t.offsetY * RUNTIME_PPU,
        offsetScaleX: t.offsetScaleX,
        offsetScaleY: t.offsetScaleY,
        offsetShearY: t.offsetShearY,
        relative: t.relative,
        local: t.local
      })
    } else if (c.type === 'path') {
      const p = c as unknown as SpinePathConstraintJson
      out.push({
        type: 'path',
        name: c.name,
        order,
        bones: boneNames(asset, (c as { boneIndices: number[] }).boneIndices),
        target: asset.bones[(c as { targetBoneIndex: number }).targetBoneIndex]?.name ?? '',
        position: p.position,
        spacing: p.spacing,
        rotateMix: p.rotateMix,
        translateMix: p.translateMix,
        positionMode: p.positionMode,
        spacingMode: p.spacingMode,
        rotateMode: p.rotateMode === 'chainScale' ? 'chainscale' : p.rotateMode
      })
    } else if (c.type === 'physics') {
      const raw = (c as { raw: Record<string, unknown> }).raw ?? {}
      const bones = (c as { boneIndices: number[] }).boneIndices
      out.push({
        type: 'physics',
        name: c.name,
        order,
        bone: asset.bones[bones[0]]?.name ?? '',
        ...(raw as Record<string, unknown>)
      })
    }
  }
  return out as SpineJson['constraints']
}

// ---------------- 动画 ----------------

function buildBoneTimeline(track: BoneAnim, bone: BoneData): SpineAnimationJson['bones'] {
  const json: SpineAnimationJson['bones'] = {}
  const tl: Record<string, SpineCurveKeyframe[]> = {}
  const setupPos = bone.localPosition
  const setupRot = bone.rotation
  const setupScale = bone.localScale
  const setupShear = bone.localShear

  const emit = (channel: 'rotate' | 'translate' | 'scale' | 'shear', keys: { time: number; value: number | { x: number; y: number }; easing: Easing; curve: number[] | null }[]): void => {
    if (keys.length === 0) return
    const frames: SpineCurveKeyframe[] = []
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      const next = keys[i + 1]
      const t1 = k.time
      const t2 = next ? next.time : k.time
      let frame: SpineCurveKeyframe
      if (channel === 'rotate') {
        const v1 = (k.value as number) - setupRot
        const v2 = next ? (next.value as number) - setupRot : v1
        frame = { time: t1, value: v1 }
        const curve = spineCurve(k.easing, k.curve, t1, t2, v1, v2)
        if (curve !== undefined) frame.curve = curve
      } else if (channel === 'shear') {
        const v1 = k.value as { x: number; y: number }
        const v2 = next ? (next.value as { x: number; y: number }) : v1
        frame = { time: t1, x: v1.x, y: v1.y }
        const curve = spineCurve(k.easing, k.curve, t1, t2, v1.x, v2.x, v1.y, v2.y)
        if (curve !== undefined) frame.curve = curve
      } else {
        const v1 = k.value as { x: number; y: number }
        const v2 = next ? (next.value as { x: number; y: number }) : v1
        if (channel === 'translate') {
          const dx1 = (v1.x - setupPos.x) * RUNTIME_PPU
          const dy1 = (v1.y - setupPos.y) * RUNTIME_PPU
          const dx2 = (v2.x - setupPos.x) * RUNTIME_PPU
          const dy2 = (v2.y - setupPos.y) * RUNTIME_PPU
          frame = { time: t1, x: dx1, y: dy1 }
          const curve = spineCurve(k.easing, k.curve, t1, t2, dx1, dx2, dy1, dy2)
          if (curve !== undefined) frame.curve = curve
        } else {
          const sx1 = setupScale.x !== 0 ? v1.x / setupScale.x : v1.x
          const sy1 = setupScale.y !== 0 ? v1.y / setupScale.y : v1.y
          const sx2 = next && setupScale.x !== 0 ? (next.value as { x: number }).x / setupScale.x : sx1
          const sy2 = next && setupScale.y !== 0 ? (next.value as { x: number }).y / setupScale.y : sy1
          void setupShear
          frame = { time: t1, x: sx1, y: sy1 }
          const curve = spineCurve(k.easing, k.curve, t1, t2, sx1, sx2, sy1, sy2)
          if (curve !== undefined) frame.curve = curve
        }
      }
      frames.push(frame)
    }
    tl[channel] = frames
  }

  emit('rotate', track.rotate as never)
  emit('translate', track.translate as never)
  emit('scale', track.scale as never)
  emit('shear', track.shear as never)
  if (Object.keys(tl).length > 0) {
    json[bone.name] = tl as SpineAnimationJson['bones'][string]
  }
  return json
}

function buildSlotTimeline(track: SlotAnim, asset: RuntimeAsset): SpineAnimationJson['slots'] {
  const name = asset.slots[track.slotIndex]?.name ?? ''
  if (name.length === 0) return {}
  const tl: SpineAnimationJson['slots'] = {}
  const rgba: SpineCurveKeyframe[] = track.color.map((k) => ({ time: k.time, color: rgbaToHex(k.value) }))
  const attachment: SpineCurveKeyframe[] = track.displayIndex.map((k, i) => ({
    time: k.time,
    name: track.displayAttachment[i] ?? ''
  }))
  if (rgba.length > 0) tl[name] = { rgba }
  if (attachment.length > 0) tl[name] = { ...(tl[name] as object), attachment }
  return tl
}

function skinOfAttachment(asset: RuntimeAsset, slotName: string, attachmentName: string): string {
  for (const skin of asset.skins) {
    const slot = skin.slots.find((s) => s.slotName === slotName)
    if (slot && slot.attachments.some((a) => a.name === attachmentName)) return skin.name || 'default'
  }
  return asset.skins[0]?.name || 'default'
}

function buildDeforms(asset: RuntimeAsset, animation: AnimData): SpineAnimationJson['deform'] {
  const deform: Record<string, Record<string, Record<string, SpineCurveKeyframe[]>>> = {}
  for (const track of animation.deforms) {
    const slotName = asset.slots.find((s) => s.name === track.slot)?.name ?? track.slot
    const skinName = skinOfAttachment(asset, slotName, track.attachment)
    const frames: SpineCurveKeyframe[] = track.frames.map((f) => ({
      time: f.time,
      offset: f.vertexOffset,
      vertices: f.offsets.map((o) => o * RUNTIME_PPU)
    }))
    if (frames.length === 0) continue
    deform[skinName] = deform[skinName] ?? {}
    deform[skinName][slotName] = deform[skinName][slotName] ?? {}
    deform[skinName][slotName][track.attachment] = frames
  }
  return deform
}

function buildDrawOrder(asset: RuntimeAsset, animation: AnimData): SpineCurveKeyframe[] {
  if (animation.drawOrder.length === 0) return []
  const setupOrder = asset.slots.map((s) => s.name)
  let current = [...setupOrder]
  const frames: SpineCurveKeyframe[] = []
  for (const key of animation.drawOrder) {
    const target = key.order
    const offsets: Array<{ slot: string; offset: number }> = []
    // 计算每个插槽相对「当前顺序」的位移，顺序模拟 Spine 的逐条 offset 应用
    let working = [...current]
    for (let pos = 0; pos < target.length; pos++) {
      const slot = target[pos]
      const curPos = working.indexOf(slot)
      if (curPos === pos) continue
      const offset = pos - curPos
      offsets.push({ slot, offset })
      if (curPos >= 0) working.splice(curPos, 1)
      working.splice(pos, 0, slot)
    }
    if (offsets.length > 0) frames.push({ time: key.time, offsets } as unknown as SpineCurveKeyframe)
    current = [...target]
  }
  return frames
}

function buildConstraintTimelines(asset: RuntimeAsset, animation: AnimData): Pick<SpineAnimationJson, 'ik' | 'transform' | 'path'> {
  const ik: SpineAnimationJson['ik'] = {}
  const transform: SpineAnimationJson['transform'] = {}
  const path: SpineAnimationJson['path'] = {}
  for (const track of animation.constraints) {
    const c = asset.constraints[track.constraintIndex]
    if (!c) continue
    const name = c.name
    if (c.type === 'ik') {
      ik[name] = track.mix.map((k) => ({ time: k.time, mix: k.value }))
    } else if (c.type === 'transform') {
      transform[name] = track.mixRotate.map((k, i) => ({
        time: k.time,
        mixRotate: k.value,
        mixX: track.mixX[i]?.value ?? 1,
        mixY: track.mixY[i]?.value ?? 1,
        mixScaleX: track.mixScaleX[i]?.value ?? 1,
        mixScaleY: track.mixScaleY[i]?.value ?? 1,
        mixShearY: track.mixShearY[i]?.value ?? 1,
        rotate: track.offsetRotate[i]?.value ?? 0,
        x: (track.offsetX[i]?.value ?? 0) * RUNTIME_PPU,
        y: (track.offsetY[i]?.value ?? 0) * RUNTIME_PPU
      }))
    } else if (c.type === 'path') {
      path[name] = track.position.map((k, i) => ({
        time: k.time,
        position: k.value,
        spacing: track.spacing[i]?.value ?? 0,
        rotateMix: track.rotateMix[i]?.value ?? 1,
        translateMix: track.translateMix[i]?.value ?? 1
      }))
    }
  }
  return { ik, transform, path }
}

function buildAnimations(asset: RuntimeAsset): SpineJson['animations'] {
  const out: SpineJson['animations'] = {}
  for (const animation of asset.animations) {
    const bones: SpineAnimationJson['bones'] = {}
    for (const track of animation.bones) {
      const bone = asset.bones[track.boneIndex]
      if (!bone) continue
      const tl = buildBoneTimeline(track, bone)
      Object.assign(bones, tl)
    }
    const slots: SpineAnimationJson['slots'] = {}
    for (const track of animation.slots) {
      Object.assign(slots, buildSlotTimeline(track, asset))
    }
    const { ik, transform, path } = buildConstraintTimelines(asset, animation)
    const anim: SpineAnimationJson = { bones, slots }
    const deform = buildDeforms(asset, animation)
    if (Object.keys(deform).length > 0) anim.deform = deform
    const drawOrder = buildDrawOrder(asset, animation)
    if (drawOrder.length > 0) anim.drawOrder = drawOrder
    if (animation.events.length > 0) {
      anim.events = animation.events.map((e) => ({
        time: e.time,
        name: e.name,
        string: e.stringParam,
        int: e.intParam,
        float: e.floatParam
      }))
    }
    if (Object.keys(ik).length > 0) anim.ik = ik
    if (Object.keys(transform).length > 0) anim.transform = transform
    if (Object.keys(path).length > 0) anim.path = path
    out[animation.name] = anim
  }
  return out
}

// ---------------- 包围盒 ----------------

/** 用骨骼 setup 世界坐标估算骨架包围盒（仅用于 skeleton.x/y/width/height 元数据） */
function computeBounds(asset: RuntimeAsset): { x: number; y: number; width: number; height: number } {
  const world: Array<{ x: number; y: number }> = []
  const resolve = (index: number, parentX: number, parentY: number, acc: Array<{ x: number; y: number }>): void => {
    const bone = asset.bones[index]
    if (!bone) return
    const cos = Math.cos((bone.rotation * Math.PI) / 180)
    const sin = Math.sin((bone.rotation * Math.PI) / 180)
    const lx = bone.localPosition.x * RUNTIME_PPU
    const ly = bone.localPosition.y * RUNTIME_PPU
    const x = parentX + lx * cos - ly * sin
    const y = parentY + lx * sin + ly * cos
    acc.push({ x, y })
    if (bone.length > 0) {
      acc.push({ x: x + bone.length * RUNTIME_PPU * cos, y: y + bone.length * RUNTIME_PPU * sin })
    }
    if (bone.parentIndex >= 0) resolve(bone.parentIndex, x, y, acc)
  }
  for (let i = 0; i < asset.bones.length; i++) resolve(i, 0, 0, world)
  if (world.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of world) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// ---------------- 顶层组装 ----------------

export function buildSpineJson(asset: RuntimeAsset): SpineJson {
  const bounds = computeBounds(asset)
  const skeleton = {
    spine: SPINE_VERSION,
    fps: asset.frameRate,
    ...bounds
  }
  const json: SpineJson = {
    skeleton,
    bones: buildBones(asset),
    slots: buildSlots(asset),
    constraints: buildConstraints(asset),
    skins: buildSkins(asset),
    animations: buildAnimations(asset)
  }
  // Spine 运行期（spine-csharp SkeletonJson.cs:124）直接按 `skeletonMap["hash"]` 取值，
  // 该 key 缺失会抛 KeyNotFoundException，因此必须写出 hash（任意非空字符串即可）。
  skeleton.hash = computeHash(JSON.stringify(json))
  return json
}

/** 简单稳定的 32 位 FNV-1a 哈希，转成 8 位十六进制串作为 skeleton.hash */
function computeHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 把运行期图集（页 + 区域）写成 Spine `.atlas` 文本。
 *  - 每个图集页照原样落盘（区域里的子 sprite 也一并写出，而不是把整页当一块）；
 *  - 区域带旋转 / 原图尺寸 / 裁剪偏移，Spine 运行库据此还原每个 sprite 的取图矩形。 */
export function serializeSpineAtlas(atlas: RuntimeAtlasJson): string {
  const lines: string[] = ['scale: 1']
  for (const page of atlas.pages) {
    lines.push(page.image)
    lines.push(`size: ${page.width}, ${page.height}`)
    lines.push('filter: Linear,Linear')
    lines.push('repeat: none')
  }
  const byPage = new Map<number, RuntimeAtlasJson['regions']>()
  for (const region of atlas.regions) {
    const list = byPage.get(region.page) ?? []
    list.push(region)
    byPage.set(region.page, list)
  }
  for (const page of atlas.pages) {
    const regions = byPage.get(atlas.pages.indexOf(page)) ?? []
    for (const region of regions) {
      const rotate = region.rotate === 90 || region.rotate === 270 || region.rotate === true
      const ow = region.origWidth ?? region.width
      const oh = region.origHeight ?? region.height
      const ox = region.offsetX ?? 0
      const oy = region.offsetY ?? 0
      lines.push(region.name)
      lines.push(`\trotate: ${rotate ? 'true' : 'false'}`)
      lines.push(`\txy: ${Math.round(region.x)}, ${Math.round(region.y)}`)
      lines.push(`\tsize: ${Math.round(region.width)}, ${Math.round(region.height)}`)
      lines.push(`\torig: ${Math.round(ow)}, ${Math.round(oh)}`)
      lines.push(`\toffset: ${Math.round(ox)}, ${Math.round(oy)}`)
      lines.push('\tindex: -1')
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 把准备好的产物写成 Spine 数据：`<骨架名>.json` + `<骨架名>.atlas` + `<骨架名>_<序号>.<扩展名>` 图集页。
 * 复用运行期图集的打包结果（只重命名页文件，使 Spine 加载器按 `<json 同名>.atlas` 找到配套资源）。
 */
export async function writeSpineExport(dir: string, plan: RuntimeExportPlan): Promise<ExportResult> {
  const platform = getPlatform()
  const skeleton = plan.skeletons[0]
  if (!skeleton) return { ok: false, message: '没有可导出的骨架', warnings: [], files: [] }
  const base = sanitize(stripExtension(skeleton.name) || skeleton.armatureName || 'skeleton')
  const warnings = [...plan.warnings]
  const outDir = joinPath(dir, base)
  const doc = useProjectStore.getState().document

  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }

  // 把页文件名改成 `<base>_<序号>.<原扩展名>`，同时改写 atlas 页名，保证 Spine 同名配对
  const newPageFiles: string[] = []
  const atlasPages = plan.atlas.pages.map((page, i) => {
    const oldFile = page.image
    const dot = oldFile.lastIndexOf('.')
    const ext = dot > 0 ? oldFile.slice(dot) : '.png'
    const newFile = `${base}_${i}${ext}`
    newPageFiles.push(newFile)
    return { ...page, image: newFile }
  })
  const atlas = { ...plan.atlas, pages: atlasPages }
  const atlasText = serializeSpineAtlas(atlas)

  // 编码图集页（与运行期导出同一套）
  const pngs = await encodeAtlasPages(
    plan.pageSources.map((source) => (source.kind === 'packed' ? source.plan : null)),
    async (name) => {
      const image = doc.images.find((entry) => entry.name === name)
      const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
      return bitmap
    }
  )
  const pageBytes = await readPageBytes(plan, pngs)
  if (pageBytes.failed.length > 0) {
    warnings.push(`图集页 ${pageBytes.failed.join(' / ')} 读不出内容（源图缺失或无法读取）`)
  }

  const skeletonJson = buildSpineJson(skeleton.asset)
  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = [
    { path: joinPath(outDir, `${base}.json`), text: `${JSON.stringify(skeletonJson, null, 2)}\n` },
    { path: joinPath(outDir, `${base}.atlas`), text: atlasText }
  ]
  newPageFiles.forEach((file, index) => {
    const bytes = pageBytes.bytes[index]
    if (!bytes || bytes.length === 0) return
    files.push({ path: joinPath(outDir, file), bytes })
  })

  await platform.writeBatch(files)
  await platform.revealInFolder(joinPath(outDir, `${base}.json`))
  useProjectStore.getState().setWarnings(warnings)

  return {
    ok: true,
    message: `已导出到 ${base}/：${base}.json / ${base}.atlas / ${newPageFiles.length} 张图集页`,
    warnings,
    files: files.map((file) => baseName(file.path))
  }
}
