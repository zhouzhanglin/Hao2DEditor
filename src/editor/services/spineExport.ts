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
import type { AnimData, BoneAnim, FloatKeyframe, SlotAnim, DeformAnim, ConstraintAnim, DrawOrderKeyframe } from '@core/model/animation'
import { angleDiff } from '@core/math/utils'
import { sortConstraints } from '@core/model/constraints'
import { triangulateFromHull } from '@core/mesh/triangulate'
import type { SpineJson, SpineSlotJson, SpineSkinJson, SpineAttachmentJson, SpineAnimationJson, SpineCurveKeyframe, SpineTransformConstraintJson, SpinePathConstraintJson } from '@importers/spineTypes'
import { pageUvsToRegionRelative } from '@importers/uv'
import type { AtlasRegion, PageSizes } from '@importers/uv'
import type { RuntimeAtlasJson } from '@core/codec/runtimeSkeJson'
import type { ExportResult } from './exportService'

/** Spine 4.3 数据格式版本号（与示例资源对齐） */
const SPINE_VERSION = '4.3.74-beta'

/** 文件名清洗：把非法字符换成下划线 */
export function sanitize(name: string): string {
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

/** 图集区域表：附件按区域名取回自己那块贴图在页里的矩形（导出 uv 换算用） */
export interface SpineRegionLookup {
  regions: Map<string, AtlasRegion>
  pageSizes: PageSizes
  /**
   * 区域改名表（原名 → 写进 `.atlas` 的名字），由 `spineAtlasRegionNames` 给出。
   * 附件查表仍用**原名**，但写进 json 的 `path` 必须用新名，两边不一致 Spine 就找不到区域。
   */
  names?: Map<string, string>
}

/** 附件在图集里的区域名（原名，查表用） */
function regionSource(att: AttachmentData): string | undefined {
  return att.regionName ?? att.textureName
}

/** 附件写进 json 的 `path`：区域改过名时跟着改（见 `SpineRegionLookup.names`） */
function regionPath(att: AttachmentData, lookup?: SpineRegionLookup): string | undefined {
  const source = regionSource(att)
  if (!source) return source
  return lookup?.names?.get(source) ?? source
}

/** 把运行期图集（页 + 区域）转成导出侧查表用的区域表 */
export function buildRegionLookup(atlas: RuntimeAtlasJson): SpineRegionLookup {
  return {
    regions: new Map(
      atlas.regions.map((region) => [
        region.name,
        {
          name: region.name,
          page: atlas.pages[region.page]?.image ?? '',
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          rotate: region.rotate ?? 0,
          origWidth: region.origWidth ?? region.width,
          origHeight: region.origHeight ?? region.height,
          offsetX: region.offsetX ?? 0,
          offsetY: region.offsetY ?? 0
        }
      ])
    ),
    pageSizes: Object.fromEntries(
      atlas.pages.map((page) => [page.image, { width: page.width, height: page.height }])
    )
  }
}

/** 单位 → 像素，顺手抹平浮点噪声（`frameSize` 是 px/100 存下来的，0.73×100 = 72.999…） */
function toPixels(units: number): number {
  const px = units * RUNTIME_PPU
  const rounded = Math.round(px)
  return Math.abs(px - rounded) < 1e-6 ? rounded : px
}

function spineAttachment(att: AttachmentData, lookup?: SpineRegionLookup): SpineAttachmentJson {
  const source = regionSource(att)
  const path = regionPath(att, lookup)
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
    /*
     * 这里写**原图（未裁剪）尺寸**，不是图集区域尺寸。
     *
     * Spine 官方 `RegionAttachment.ComputeUVs` 用 `regionScale = width / originalWidth` 把
     * json 宽高换算回图集区域尺寸，再按区域的 offsets 把内容摆回原图里：
     *   localX  = -width/2 + offsetX * regionScale
     *   localX2 = localX + regionWidth * regionScale
     * 只有 `width` == `originalWidth` 时 regionScale 才是 1、四边形才正好等于区域尺寸。
     * 裁剪过的附件若仍写区域尺寸，Unity 端会被 regionScale 缩小一圈（DB 的 Rooster 下嘴
     * 区域 39×14 挤在 73×53 的帧里，就只剩一半大小）。
     * 未裁剪时 frameSize == size（老工程/手工附件是 0），取 max 即原行为。
     */
    base.width = toPixels(Math.max(att.size.x, att.frameSize.x))
    base.height = toPixels(Math.max(att.size.y, att.frameSize.y))
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
  // Spine 的 mesh uvs 是**区域相对**坐标（v=0 指向区域顶边，官方 MeshAttachment.ComputeUVs 会
  // 再乘上区域尺寸），编辑器运行期存的是整页归一化 UV，这里必须换回去，否则 Unity 端取图整体错位。
  // 查表用区域**原名**：区域改名只影响 .atlas 里的名字，UV 换算要的是那块矩形本身。
  const region = lookup && source ? lookup.regions.get(source) : undefined
  base.uvs =
    region && lookup
      ? Array.from(pageUvsToRegionRelative(att.uvs, region, lookup.pageSizes))
      : Array.from(att.uvs)
  let triangles = [...att.triangles]
  if (triangles.length % 3 !== 0) triangles = []
  // 老工程或导入阶段没生成 triangles 的网格，导出前用 hull 耳切兜底，
  // 否则 Unity/Spine 只有 hull 会退化成凸包填充。
  if (triangles.length === 0 && att.hull >= 3 && att.vertices.length >= 6) {
    triangles = triangulateFromHull(att.vertices, att.hull, att.edges)
  }
  base.triangles = triangles
  base.hull = att.hull
  if (att.edges && att.edges.length > 0) base.edges = [...att.edges]
  // 包围盒尺寸（像素）。未加权网格的顶点会先烘上附件 TRS，宽高要按烘完的算才自洽；
  // 加权网格的 `vertices` 是「骨骼影响列表」而非 xy 对，仍按建模顶点算。
  const weightedMesh = !!att.weights && att.weights.length > 0
  const bakedVerts = weightedMesh ? null : bakeMeshTransform(att)
  const verts = bakedVerts ?? att.vertices
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
  if (weightedMesh) {
    base.vertices = meshWeightedVertices(att)
  } else {
    base.vertices = bakedVerts!.map((v) => v * RUNTIME_PPU)
  }
  /*
   * mesh 的 x/y/rotation/scale 一律写 0/1。
   *
   * Spine 4.x 读 `"mesh"` 分支时**只**取 path/uvs/vertices/triangles/edges/hull 与宽高，
   * 根本不会读这四个字段（见 spine-core `SkeletonJson`），网格顶点只受骨骼矩阵变换；
   * 而编辑器渲染未加权网格时走 `MeshBuilder.attachmentWorld`，会叠加附件自身的 TRS。
   * 两边要对上，只能把 TRS 烘进顶点（加权网格两边都不叠加附件 TRS，保持原样）。
   * 之前没烘：Dora 的 mouth_d 平移 15px、旋转 -3°，Ubbie 的 leg_l 旋转 91.6° 全丢，
   * 表现就是「位置整体错位 + 贴图对不上」。
   */
  base.x = 0
  base.y = 0
  base.rotation = 0
  base.scaleX = 1
  base.scaleY = 1
  return base
}

/**
 * 未加权网格：把附件自身的 TRS 烘进顶点（与 `MeshBuilder.attachmentWorld` 的 `trsInto` 同构：
 * x' = cos·sx·vx − sin·sy·vy + px，y' = sin·sx·vx + cos·sy·vy + py）。
 */
function bakeMeshTransform(att: AttachmentData): number[] {
  const rad = (att.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = att.scale.x
  const sy = att.scale.y
  const px = att.position.x
  const py = att.position.y
  const src = att.vertices
  const out: number[] = new Array(src.length)
  for (let i = 0; i + 1 < src.length; i += 2) {
    const vx = src[i]
    const vy = src[i + 1]
    out[i] = cos * sx * vx - sin * sy * vy + px
    out[i + 1] = sin * sx * vx + cos * sy * vy + py
  }
  return out
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

function buildSkins(asset: RuntimeAsset, lookup?: SpineRegionLookup): SpineSkinJson[] {
  return asset.skins.map((skin) => {
    const attachments: Record<string, Record<string, SpineAttachmentJson>> = {}
    for (const slot of skin.slots) {
      const slotEntries: Record<string, SpineAttachmentJson> = {}
      for (const att of slot.attachments) {
        slotEntries[att.name] = spineAttachment(att, lookup)
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
        // 与 importer/spine.ts 的读入映射互逆：Spine 的 bendPositive(true) → bendSign=-1
        // （其膝弯在 (根→目标) 的负叉积一侧），反之 bendSign=-1 必须写回 true。
        // 这里若写成 bendSign > 0，四条腿的膝盖会全部朝反方向弯。
        bendPositive: (c as { bendSign: number }).bendSign < 0,
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

/**
 * rotate 通道写 json 前的**连续化**：每一键换成与前一键同方向、跨度落在 (-180°, 180°] 内的等价角。
 *
 * 编辑器/参考库的采样走最短弧（`sampleAngle → lerpAngle`），而官方运行库对 rotate 是
 * **按取值直接线性插值**（`RotateTimeline.apply → getCurveValue`，没有任何环绕处理）。
 * DragonBones 的旋转帧是作者拖出来的**未归一化**值 —— 例如 hair3 的 `-358.05`（≡ +1.95，
 * 本意只是根头发轻轻摆一下）、forearm_r 的 `-186.79`；照字面写进 json，官方库会在两键之间
 * **朝反方向绕一整圈**（实测 hair3 中途 180.91°、forearm_r 偏差 348°，整个角色翻过来）。
 *
 * 逐键按最短弧累积成等价角后，官方库的直线插值与编辑器逐帧严格一致
 * （相邻键差正好是 `angleDiff`，与 `lerpAngle` 同一条曲线）；差 360° 是同一个姿态，
 * 这一步只改数值表示，不改任何一帧的样子。跨度本来就 ≤180° 的轨道一字不动。
 */
function continuousRotate(keys: readonly FloatKeyframe[], setupRot: number): number[] {
  const out: number[] = new Array(keys.length)
  if (keys.length === 0) return out
  out[0] = keys[0].value - setupRot
  for (let i = 1; i < keys.length; i++) {
    out[i] = out[i - 1] + angleDiff(keys[i - 1].value, keys[i].value)
  }
  return out
}

function buildBoneTimeline(track: BoneAnim, bone: BoneData): SpineAnimationJson['bones'] {
  const json: SpineAnimationJson['bones'] = {}
  const tl: Record<string, SpineCurveKeyframe[]> = {}
  const setupPos = bone.localPosition
  const setupRot = bone.rotation
  const setupScale = bone.localScale
  const setupShear = bone.localShear
  const rotateWrite = continuousRotate(track.rotate, setupRot)

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
        const v1 = rotateWrite[i]
        const v2 = next ? rotateWrite[i + 1] : v1
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
  const attachment: SpineCurveKeyframe[] = track.displayIndex.map((k, i) => {
    const displayName = resolveDisplayAttachment(asset, name, track.displayAttachment[i], k.value)
    // 没有附件（displayIndex 为 -1 / 越界）时**不能写空串**：运行库判定「清空附件」用的是
    // `name == null`，空串会拿去做 `getAttachment`，直接抛 `placeholder cannot be null.` ——
    // 这就是「setup 正常、一播动画就崩/黑」的原因。省掉 name 字段即 null = 隐藏该插槽。
    return displayName.length > 0 ? { time: k.time, name: displayName } : { time: k.time }
  })
  if (rgba.length > 0) tl[name] = { rgba }
  if (attachment.length > 0) tl[name] = { ...(tl[name] as object), attachment }
  return tl
}

/**
 * 附件轨道的一帧 → 附件名（空串表示该帧没有附件）。
 *
 * DragonBones 的 slot 轨道只存 `displayIndex`（指向该槽附件列表的下标，-1 = 隐藏），并**没有名字**，
 * 导入器把 `displayAttachment` 一律填成空串；编辑器运行期是按下标去查当前皮肤的附件数组的。
 * 所以导出时必须按**运行期同一张皮肤**（默认皮肤）把下标反解成名字，否则整条附件轨道都成了空串：
 *   - 有名字（Spine 导入的工程）→ 直接用；
 *   - 没名字 → 用下标查默认皮肤该槽的附件列表；
 *   - 下标越界 / 为负 → 空串，由调用方写成「清空附件」的帧。
 */
function resolveDisplayAttachment(
  asset: RuntimeAsset,
  slotName: string,
  byName: string,
  index: number
): string {
  if (byName) return byName
  let def = asset.defaultSkinIndex
  if (def < 0 || def >= asset.skins.length) def = 0
  const skinSlot = asset.skins[def]?.slots.find((s) => s.slotName === slotName)
  return skinSlot?.attachments[index]?.name ?? ''
}

function skinOfAttachment(asset: RuntimeAsset, slotName: string, attachmentName: string): string {
  for (const skin of asset.skins) {
    const slot = skin.slots.find((s) => s.slotName === slotName)
    if (slot && slot.attachments.some((a) => a.name === attachmentName)) return skin.name || 'default'
  }
  return asset.skins[0]?.name || 'default'
}

function findAttachment(asset: RuntimeAsset, slotName: string, attachmentName: string): AttachmentData | undefined {
  for (const skin of asset.skins) {
    const slot = skin.slots.find((s) => s.slotName === slotName)
    const att = slot?.attachments.find((a) => a.name === attachmentName)
    if (att) return att
  }
  return undefined
}

/**
 * FFD 轨道指向哪个附件：轨道名（DB 导入存的是显示名 / 参考库存的是附件名）优先，
 * 其次插槽的 setup 附件，再兜底到该插槽的第一个网格附件。
 * DB 的 FFD 是**按插槽**记录的（数据里没有附件名），只按名字硬查会整条轨道丢掉。
 */
function deformAttachmentName(asset: RuntimeAsset, slotName: string, track: DeformAnim, setupAttachment: string): string {
  if (track.attachmentName && findAttachment(asset, slotName, track.attachmentName)) return track.attachmentName
  if (setupAttachment && findAttachment(asset, slotName, setupAttachment)) return setupAttachment
  for (const skin of asset.skins) {
    const slot = skin.slots.find((s) => s.slotName === slotName)
    const att = slot?.attachments.find((a) => a.type === AttachmentType.Mesh)
    if (att) return att.name
  }
  return ''
}

/**
 * 一帧 FFD 偏移 → Spine 的 `deform.vertices`。
 *
 * 三个必须对齐的地方：
 * - Spine 的数组按**影响**展开（每根影响的骨内 (x,y) 各一份，加权网格逐骨骼复制），
 *   编辑器运行期按**顶点**存一份（见 meshBuilder 的 accumulateWeighted）；
 * - 偏移在**显示空间**时，要按该影响的 bindpose 方向换算到骨内空间，
 *   与运行期 `!ffdInBoneSpace` 分支完全一致（`ffdInBoneSpace` 由 compile 归一化，正常恒为 false）；
 * - **未加权网格**的偏移要按附件自身的 TRS 线性部分转一次：编辑器是在**附件坐标**里
 *   `vertex + offset` 之后才走刚体变换的（`emitMesh` 的 rigid 分支），而导出的顶点已经烘过
 *   附件 TRS（`bakeMeshTransform`），Spine 又只会在骨内坐标上直接加偏移 —— 少转这一下，
 *   偏移就等于没跟着附件的旋转/缩放走：Ubbie 的披风（附件旋转约 50°、偏移上千像素）整块
 *   被扯歪，最大偏差 250px，而偏移为 0 的顶点却完好（这是「setup 对、一播动画就错」的由来）。
 *
 * 数组长度严格等于附件顶点数 ×2（加权网格 = 影响数 ×2）：短了参考库按 0 补齐没问题，
 * 长了 `Array.Copy` 直接越界抛异常。
 */
function deformFrameVertices(asset: RuntimeAsset, att: AttachmentData, frame: DeformAnim['frames'][number]): number[] {
  const count = Math.floor(att.vertices.length / 2)
  const weighted = count > 0 && att.weights.length === count
  const base = Math.max(0, frame.vertexOffset)
  const out: number[] = []
  const bindposes = asset.bindposes
  // 未加权网格的偏移先过附件 TRS（与 bakeMeshTransform 同一套线性部分，不含平移）
  const rad = (att.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ta = cos * att.scale.x
  const tb = -sin * att.scale.y
  const tc = sin * att.scale.x
  const td = cos * att.scale.y
  for (let i = 0; i < count; i++) {
    const at = (base + i) * 2
    const dx = frame.offsets[at] ?? 0
    const dy = frame.offsets[at + 1] ?? 0
    if (!weighted) {
      out.push((ta * dx + tb * dy) * RUNTIME_PPU, (tc * dx + td * dy) * RUNTIME_PPU)
      continue
    }
    const w = att.weights[i]
    const influences: Array<[number, number]> = [
      [w.b0, w.w0],
      [w.b1, w.w1],
      [w.b2, w.w2],
      [w.b3, w.w3]
    ]
    for (const [bone, weight] of influences) {
      if (weight <= 0) continue // 与 meshWeightedVertices 的过滤一致，否则下标会错位
      if (att.ffdInBoneSpace) {
        out.push(dx * RUNTIME_PPU, dy * RUNTIME_PPU)
        continue
      }
      const o = bone * 16
      if (o + 5 >= bindposes.length) {
        out.push(dx * RUNTIME_PPU, dy * RUNTIME_PPU)
        continue
      }
      out.push(
        (bindposes[o] * dx + bindposes[o + 4] * dy) * RUNTIME_PPU,
        (bindposes[o + 1] * dx + bindposes[o + 5] * dy) * RUNTIME_PPU
      )
    }
  }
  return out
}

/**
 * FFD → 附件级 `deform` 轨道。
 *
 * 4.2 起 deform 必须挂在 `attachments.<skin>.<slot>.<attachment>.deform` 下：
 * 顶层的 `deform`（4.0~4.1 写法）官方 4.3 运行库整段不读，导出物会静默丢掉 FFD。
 */
function buildDeforms(asset: RuntimeAsset, animation: AnimData): SpineAnimationJson['attachments'] {
  const attachments: NonNullable<SpineAnimationJson['attachments']> = {}
  for (const track of animation.deforms) {
    if (track.frames.length === 0) continue
    const slot = asset.slots[track.slotIndex]
    if (!slot) continue
    const attachmentName = deformAttachmentName(asset, slot.name, track, slot.setupAttachment)
    if (!attachmentName) continue
    const att = findAttachment(asset, slot.name, attachmentName)
    if (!att) continue
    const skinName = skinOfAttachment(asset, slot.name, attachmentName)
    const frames: SpineCurveKeyframe[] = track.frames.map((f, i) => {
      const next = track.frames[i + 1]
      const key: SpineCurveKeyframe = { time: f.time, vertices: deformFrameVertices(asset, att, f) }
      // 参考库读 deform 曲线时按「值域 0..1」换算（SkeletonJson: ReadCurve(..., 0, 1, 1)）
      const curve = spineCurve(f.easing, f.curve, f.time, next ? next.time : f.time, 0, 1)
      if (curve !== undefined) key.curve = curve
      return key
    })
    attachments[skinName] = attachments[skinName] ?? {}
    attachments[skinName][slot.name] = attachments[skinName][slot.name] ?? {}
    attachments[skinName][slot.name][attachmentName] = { deform: frames }
  }
  return attachments
}

/**
 * 一帧完整抽取顺序 → Spine 的 `offsets`。
 *
 * 参考库的读法（`SkeletonJson.readDrawOrder`）是**沿 setup 下标单向扫描**：
 * 维护 originalIndex 从 0 往 n-1 走，遇到一条 offset 就先把沿途未改动的槽收进 unchanged，
 * 再把当前槽放到 `slotIndex + offset` 位置；扫完剩下的槽按 setup 顺序回填空位。
 * 因此：
 * - entries 必须按槽的 **setup 下标升序**：顺序反了 `while (originalIndex !== index)` 永远
 *   追不上（index 比 originalIndex 小），originalIndex 一路涨到 2^32-1，报
 *   `RangeError: Invalid array length`（Dora_zorder 就是这么炸的）；
 * - offset 是相对 **setup 顺序**的位移，每帧独立还原、不叠加前一帧；旧实现按上一帧推算，
 *   多帧重排时就会写出反向 / 过量的 entries；
 * - 未出现在 entries 里的槽由参考库按 setup 顺序回填，所以只需给
 *   `targetPos != setupIndex` 的槽写 entry，entries 数量天然 ≤ 槽数，不会越界。
 */
function buildDrawOrder(asset: RuntimeAsset, animation: AnimData): SpineCurveKeyframe[] {
  if (animation.drawOrder.length === 0) return []
  const setupOrder = asset.slots.map((s) => s.name)
  const frames: SpineCurveKeyframe[] = []
  for (const key of animation.drawOrder) {
    // order 存的是槽索引，写进 json 必须是槽名（spine-core 按 name 查槽）
    const targetPos = new Map<string, number>()
    for (let pos = 0; pos < key.order.length; pos++) {
      const slotName = asset.slots[key.order[pos]]?.name
      if (slotName && !targetPos.has(slotName)) targetPos.set(slotName, pos)
    }
    const offsets: Array<{ slot: string; offset: number }> = []
    for (let si = 0; si < setupOrder.length; si++) {
      const pos = targetPos.get(setupOrder[si])
      if (pos === undefined || pos === si) continue
      offsets.push({ slot: setupOrder[si], offset: pos - si })
    }
    // 即使这一帧就是「setup 顺序」也要保留时间点：运行库对没有 offsets 的帧按 **setup 顺序**处理
    // （`DrawOrderTimeline.apply`：null → 拷回 setup），漏掉这一帧会让上一帧的重排一直生效到下一帧。
    frames.push(
      (offsets.length > 0 ? { time: key.time, offsets } : { time: key.time }) as unknown as SpineCurveKeyframe
    )
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
    const attachments = buildDeforms(asset, animation)
    if (Object.keys(attachments).length > 0) anim.attachments = attachments
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

export function buildSpineJson(asset: RuntimeAsset, lookup?: SpineRegionLookup): SpineJson {
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
    skins: buildSkins(asset, lookup),
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

/** 图片文件后缀：区域名一旦带上它，spine-unity 就会把这行当成图集页 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|tga|gif|tiff?)$/i

/**
 * 区域改名表（原名 → 写进 `.atlas` 的名字）：区域名不能长得像图片文件名。
 *
 * spine-unity 的 `SpineAtlasAsset.CreateRuntimeInstance` 是按「行尾是图片后缀」找图集页的
 * （它要据此组装 material 列表），所以一个叫 `Sheep_tex.png` 的区域会被当成新的一页，
 * 页与区域的对应关系全乱：材质数对不上、后面的区域全挂到前一页。
 * 编辑器里「整页当一块区域」的兜底区域正是拿页文件名当区域名（exportService 的 `name: page.image`），
 * 这里统一把后缀摘掉；摘完重名时加序号，避免把两块区域压成同名。
 */
export function spineAtlasRegionNames(atlas: RuntimeAtlasJson): Map<string, string> {
  const renamed = new Map<string, string>()
  const used = new Set(atlas.regions.map((region) => region.name))
  for (const region of atlas.regions) {
    if (!IMAGE_EXT_RE.test(region.name)) continue
    const stem = region.name.replace(IMAGE_EXT_RE, '') || 'region'
    let name = stem
    for (let i = 1; used.has(name); i++) name = `${stem}_${i}`
    used.delete(region.name)
    used.add(name)
    renamed.set(region.name, name)
  }
  return renamed
}

/** Spine `.atlas` 的裁剪四项（区域语义见 `serializeSpineAtlas`） */
interface RegionTrim {
  origWidth: number
  origHeight: number
  offsetX: number
  offsetY: number
}

/**
 * 收集「图集区域里没写、附件里却带着」的裁剪信息。
 *
 * DragonBones 导入的工程把裁剪记在附件上（`frameSize` = 原图尺寸，`contentOffset` = 内容中心
 * 相对原图中心的偏移），图集区域则写成裁剪后的中性值（orig = 区域尺寸、offset = 0，
 * 见 dragonBones.ts）。而 Spine 这边 `.atlas` 是裁剪信息的**唯一**载体：区域只描述「页里这块
 * 矩形」，原图多大、内容落在原图哪里必须由 `offsets` 交代 —— 否则那几个被裁过的 sprite
 * 在 Unity 里会整体偏几像素。所以导出前把附件上的裁剪反解回 Spine 语义：
 *
 *   官方 `RegionAttachment.ComputeUVs`（regionScale = 1，即 json 宽高 = 原图尺寸时）：
 *     localX = -origW/2 + offsetX          内容中心 x = localX + packedW/2
 *     localY = -origH/2 + offsetY          内容中心 y = localY + packedH/2
 *   注意 localY 配的是区域**下**边（offsets[BLY]），即 offsetY 是「距原图底边多远」。
 *   与 contentOffset（y 向上为正、相对原图中心）对齐：
 *     offsetX = contentOffset.x + (origW - packedW)/2
 *     offsetY = contentOffset.y + (origH - packedH)/2
 *   拿 DB 的 Rooster 下嘴验算：帧 73×53 / 区域 39×14 / frameX=-24, frameY=-34
 *     → contentOffset = (7, -14.5) → offsets = (24, 5)：左裁 24、距底边 5，与美术一致。
 */
export function collectRegionTrim(
  asset: RuntimeAsset,
  atlas: RuntimeAtlasJson
): { trim: Map<string, RegionTrim>; conflicts: string[] } {
  const trim = new Map<string, RegionTrim>()
  const conflicts: string[] = []
  const regionByName = new Map(atlas.regions.map((region) => [region.name, region]))
  for (const skin of asset.skins) {
    for (const slot of skin.slots) {
      for (const att of slot.attachments) {
        if (att.type !== AttachmentType.Region) continue
        const name = regionSource(att)
        if (!name) continue
        const region = regionByName.get(name)
        if (!region) continue
        // 区域自带裁剪（Spine 图集导入的工程）→ 以区域为准，不回推
        if (
          (region.origWidth ?? 0) > region.width ||
          (region.origHeight ?? 0) > region.height ||
          (region.offsetX ?? 0) !== 0 ||
          (region.offsetY ?? 0) !== 0
        ) {
          continue
        }
        // 旋转过的区域，宽高是页内摆放方向，跟裁剪尺寸对不上，跳过
        if (region.rotate) continue
        const derived = regionTrimOf(att, region)
        if (!derived) continue
        const prev = trim.get(name)
        if (prev && !sameTrim(prev, derived)) {
          // 同一块区域被不同裁剪引用说明数据本身有歧义，一处写错就是几像素的偏差 → 宁可按原样写出
          conflicts.push(name)
          trim.delete(name)
          continue
        }
        if (!conflicts.includes(name)) trim.set(name, derived)
      }
    }
  }
  return { trim, conflicts }
}

function sameTrim(a: RegionTrim, b: RegionTrim): boolean {
  return (
    Math.abs(a.origWidth - b.origWidth) <= 0.5 &&
    Math.abs(a.origHeight - b.origHeight) <= 0.5 &&
    Math.abs(a.offsetX - b.offsetX) <= 0.5 &&
    Math.abs(a.offsetY - b.offsetY) <= 0.5
  )
}

/** 单个附件 → Spine 裁剪四项；区域与附件尺寸对不上（倍率导出 / 重新打包）或压根没裁剪时返回 null */
function regionTrimOf(att: AttachmentData, region: RuntimeAtlasJson['regions'][number]): RegionTrim | null {
  const packedW = att.size.x * RUNTIME_PPU
  const packedH = att.size.y * RUNTIME_PPU
  // 只有「区域正是这张图、且 1:1」才反解得准：缩放过的区域坐标与原尺寸不成比例
  if (Math.abs(packedW - region.width) > 0.5 || Math.abs(packedH - region.height) > 0.5) return null
  const origW = Math.max(att.frameSize.x * RUNTIME_PPU, region.width)
  const origH = Math.max(att.frameSize.y * RUNTIME_PPU, region.height)
  if (origW - region.width <= 0.5 && origH - region.height <= 0.5) return null
  return {
    origWidth: Math.round(origW),
    origHeight: Math.round(origH),
    offsetX: Math.round(att.contentOffset.x * RUNTIME_PPU + (origW - region.width) / 2),
    offsetY: Math.round(att.contentOffset.y * RUNTIME_PPU + (origH - region.height) / 2)
  }
}

/** 把运行期图集（页 + 区域）写成 Spine `.atlas` 文本，对齐 4.2+ 的 `bounds:` / `offsets:` 语法。
 *  - 每个图集页照原样落盘（区域里的子 sprite 也一并写出，而不是把整页当一块）；
 *  - 页与页之间留一个空行：Spine 靠空行切页，缺了它第二页的页名会被当成上一页的区域名；
 *  - `bounds:` = 区域在页里的矩形；`offsets:` = 裁剪（offsetX 左裁 / offsetY 距原图**底边**多少），
 *    只在真裁剪时才写 —— 不写时运行库取 originalWidth = bounds 宽，正好等价于「没裁」；
 *  - 旋转写 4.2 的度数（`rotate: 90`），不再写 3.x 的 `rotate: true`；
 *  - 不再写 `index`（4.2 起运行库默认 0）与全局 `scale`（4.2 里 `scale` 是**页**字段，
 *    我们的页都是 1:1，省略即为 1）；`format` / `repeat` / `pma` 同样省略，取运行库默认值（直通 Alpha）。 */
export function serializeSpineAtlas(atlas: RuntimeAtlasJson): string {
  const byPage = new Map<number, RuntimeAtlasJson['regions']>()
  for (const region of atlas.regions) {
    const list = byPage.get(region.page) ?? []
    list.push(region)
    byPage.set(region.page, list)
  }
  const lines: string[] = []
  atlas.pages.forEach((page, index) => {
    if (index > 0) lines.push('')
    lines.push(page.image)
    lines.push(`\tsize: ${Math.round(page.width)}, ${Math.round(page.height)}`)
    lines.push('\tfilter: Linear, Linear')
    for (const region of byPage.get(index) ?? []) {
      const w = Math.round(region.width)
      const h = Math.round(region.height)
      const ow = Math.round(region.origWidth ?? w)
      const oh = Math.round(region.origHeight ?? h)
      const ox = Math.round(region.offsetX ?? 0)
      const oy = Math.round(region.offsetY ?? 0)
      const rotate = typeof region.rotate === 'number' ? Math.round(region.rotate) : region.rotate === true ? 90 : 0
      lines.push(region.name)
      lines.push(`\tbounds: ${Math.round(region.x)}, ${Math.round(region.y)}, ${w}, ${h}`)
      if (ow !== w || oh !== h || ox !== 0 || oy !== 0) lines.push(`\toffsets: ${ox}, ${oy}, ${ow}, ${oh}`)
      if (rotate) lines.push(`\trotate: ${rotate}`)
    }
  })
  return `${lines.join('\n')}\n`
}

/** Spine 导出的可选项 */
export interface SpineExportOptions {
  /** 图集文件名后缀 `.txt`：写 `<骨架名>.atlas.txt`（Spine 编辑器默认导出的形态，spine-unity 认） */
  atlasTxt?: boolean
}

/**
 * 把准备好的产物写成 Spine 数据：`<骨架名>.json` + `<骨架名>.atlas[.txt]` + `<骨架名>_<序号>.<扩展名>` 图集页。
 * 复用运行期图集的打包结果（只重命名页文件，使 Spine 加载器按 `<json 同名>.atlas` 找到配套资源）。
 */
export async function writeSpineExport(
  dir: string,
  plan: RuntimeExportPlan,
  options: SpineExportOptions = {}
): Promise<ExportResult> {
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
  /*
   * 区域名与裁剪都要先「翻译」成 Spine 能接受的形态，否则 Unity 端会出坑：
   *  - 名叫 `xxx.png` 的区域会被 spine-unity 当成图集页（材质表错乱）；
   *  - DB 导入的工程裁剪只记在附件上，`.atlas` 不写 offsets 就会丢裁剪、sprite 偏几像素。
   * 两处改动必须让 json 的 `path` 一起跟着改，所以改名表交给查表对象（见 SpineRegionLookup.names）。
   */
  const names = spineAtlasRegionNames(plan.atlas)
  const { trim, conflicts } = collectRegionTrim(skeleton.asset, plan.atlas)
  if (conflicts.length > 0) {
    warnings.push(`区域 ${conflicts.join(' / ')} 被多个附件以不同裁剪引用，已按原样写出（不做裁剪换算）`)
  }
  const atlasRegions = plan.atlas.regions.map((region) => ({
    ...region,
    name: names.get(region.name) ?? region.name,
    ...(trim.get(region.name) ?? {})
  }))
  const atlas = { ...plan.atlas, pages: atlasPages, regions: atlasRegions }
  const atlasText = serializeSpineAtlas(atlas)

  // 编码图集页（与运行期导出同一套）
  const loadSource = async (name: string): Promise<ImageBitmap | null> => {
    const image = doc.images.find((entry) => entry.name === name)
    return image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
  }
  const pngs = await encodeAtlasPages(
    plan.pageSources.map((source) => (source.kind === 'packed' ? source.plan : null)),
    loadSource
  )
  const pageBytes = await readPageBytes(plan, pngs)
  if (pageBytes.failed.length > 0) {
    warnings.push(`图集页 ${pageBytes.failed.join(' / ')} 读不出内容（源图缺失或无法读取）`)
  }

  // 查表用**未改名的**区域（UV 换算要的是那块矩形本身），页名用改名后的，附件 path 由 names 改写
  const lookup: SpineRegionLookup = { ...buildRegionLookup({ ...plan.atlas, pages: atlasPages }), names }
  const skeletonJson = buildSpineJson(skeleton.asset, lookup)
  const atlasFile = `${base}.atlas${options.atlasTxt ? '.txt' : ''}`
  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = [
    { path: joinPath(outDir, `${base}.json`), text: `${JSON.stringify(skeletonJson, null, 2)}\n` },
    { path: joinPath(outDir, atlasFile), text: atlasText }
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
    message: `已导出到 ${base}/：${base}.json / ${atlasFile} / ${newPageFiles.length} 张图集页`,
    warnings,
    files: files.map((file) => baseName(file.path))
  }
}
