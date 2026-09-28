import { Easing, emptyBoneAnim, emptyConstraintAnim, emptyDeformAnim, emptyIkAnim, emptySlotAnim } from '@core/model/animation'
import type {
  AnimData,
  BoneAnim,
  ConstraintAnim,
  DeformAnim,
  DeformKeyframe,
  DrawOrderKeyframe,
  EventKeyframe,
  IkAnim,
  SlotAnim
} from '@core/model/animation'
import type { BoneData } from '@core/model/types'
import type { Constraint } from '@core/model/constraints'
import type { AtlasRegion, PageSizes } from './uv'
import { parseHexColor, pxToUnit } from './uv'
import type { SpineAnimationJson } from './spineTypes'

export interface SpineAnimContext {
  boneIndex: Map<string, number>
  slotIndex: Map<string, number>
  /** 新序骨骼（动画增量需要叠加 setup 值） */
  bones: readonly BoneData[]
  constraints: readonly Constraint[]
  /** 每个插槽的「附件名 → 默认皮肤下的下标」 */
  attIndexBySlot: Map<string, Map<string, number>>
  regions: Map<string, AtlasRegion>
  pageSizes: PageSizes
  warnings: string[]
}

/**
 * Spine 动画 → AnimData。
 *
 * 关键点（与参考库一致）：
 * - 骨骼轨道的 rotate/translate/scale 是**相对 setup 的增量**，这里叠加成绝对值后写入
 * - `attachment` 轨道固定 Stepped，同时产出附件名（换皮肤后按名解析才正确）
 * - `deform` 的层级既可能是 3.x 的「插槽层」，也可能是 4.x 的「皮肤层」
 * - easing：curve 数组 ≥4 → Bezier；数字 → Bezier[c,0,1,1]；"stepped" → Stepped；其余 Linear
 */
export function importSpineAnimations(
  name: string,
  animation: SpineAnimationJson,
  ctx: SpineAnimContext
): AnimData {
  const bones: BoneAnim[] = []
  const slots: SlotAnim[] = []
  const deforms: DeformAnim[] = []
  const drawOrder: DrawOrderKeyframe[] = []
  const events: EventKeyframe[] = []
  const iks: IkAnim[] = []
  const constraintTracks: ConstraintAnim[] = []
  let duration = 0

  for (const [boneName, timeline] of Object.entries(animation.bones ?? {})) {
    const index = ctx.boneIndex.get(boneName)
    if (index === undefined) {
      ctx.warnings.push(`动画「${name}」的骨骼轨道「${boneName}」不存在，已忽略`)
      continue
    }
    const bone = ctx.bones[index]
    if (!bone) continue
    const track: BoneAnim = emptyBoneAnim(index)

    for (const key of timeline.rotate ?? []) {
      const easing = easingOf(key.curve)
      track.rotate.push({ time: key.time, value: numberOr(key.angle, 0) + bone.rotation, ...easing })
      duration = Math.max(duration, key.time)
    }
    for (const key of timeline.translate ?? []) {
      const easing = easingOf(key.curve)
      track.translate.push({
        time: key.time,
        value: {
          x: bone.localPosition.x + pxToUnit(numberOr(key.x, 0)),
          y: bone.localPosition.y + pxToUnit(numberOr(key.y, 0))
        },
        ...easing
      })
      duration = Math.max(duration, key.time)
    }
    for (const key of timeline.scale ?? []) {
      const easing = easingOf(key.curve)
      track.scale.push({
        time: key.time,
        value: { x: bone.localScale.x * numberOr(key.x, 1), y: bone.localScale.y * numberOr(key.y, 1) },
        ...easing
      })
      duration = Math.max(duration, key.time)
    }
    for (const key of timeline.shear ?? []) {
      const easing = easingOf(key.curve)
      track.shear.push({
        time: key.time,
        value: { x: numberOr(key.x, 0), y: numberOr(key.y, 0) },
        ...easing
      })
      duration = Math.max(duration, key.time)
    }

    if (
      track.rotate.length > 0 ||
      track.translate.length > 0 ||
      track.scale.length > 0 ||
      track.shear.length > 0
    ) {
      bones.push(track)
    }
  }

  for (const [slotName, timeline] of Object.entries(animation.slots ?? {})) {
    const slotIndex = ctx.slotIndex.get(slotName)
    if (slotIndex === undefined) {
      ctx.warnings.push(`动画「${name}」的插槽轨道「${slotName}」不存在，已忽略`)
      continue
    }
    const track: SlotAnim = emptySlotAnim(slotIndex)
    const attIndex = ctx.attIndexBySlot.get(slotName)

    for (const key of timeline.color ?? []) {
      track.color.push({
        time: key.time,
        value: parseHexColor(typeof key.color === 'string' ? key.color : undefined),
        easing: Easing.Linear,
        curve: null
      })
      duration = Math.max(duration, key.time)
    }

    for (const key of timeline.attachment ?? []) {
      const attachment = typeof key.name === 'string' ? key.name : ''
      const index = attachment ? (attIndex?.get(attachment) ?? -1) : -1
      track.displayIndex.push({ time: key.time, value: index, easing: Easing.Stepped, curve: null })
      track.displayAttachment.push(attachment)
      duration = Math.max(duration, key.time)
    }

    if (track.color.length > 0 || track.displayIndex.length > 0) slots.push(track)
  }

  collectDeforms(animation, ctx, deforms, (time) => {
    duration = Math.max(duration, time)
  })

  for (const key of animation.drawOrder ?? []) {
    const offsets = Array.isArray(key.offsets) ? (key.offsets as Array<Record<string, unknown>>) : []
    drawOrder.push({ time: key.time, order: expandDrawOrder(offsets, ctx.slotIndex) })
    duration = Math.max(duration, key.time)
  }

  for (const key of animation.events ?? []) {
    events.push({
      time: key.time,
      name: typeof key.name === 'string' ? key.name : '',
      stringParam: typeof key.string === 'string' ? key.string : '',
      intParam: Math.round(numberOr(key.int, 0)),
      floatParam: numberOr(key.float, 0)
    })
    duration = Math.max(duration, key.time)
  }

  // ik 轨道（参考库风格，ikIndex 指向 IK 约束列表）
  const ikConstraintIndices = ctx.constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.type === 'ik')
    .map((entry) => entry.i)

  for (const [ikName, keys] of Object.entries(animation.ik ?? {})) {
    const constraintIndex = ctx.constraints.findIndex((c) => c.name === ikName && c.type === 'ik')
    if (constraintIndex < 0) {
      ctx.warnings.push(`动画「${name}」的 IK 轨道「${ikName}」不存在，已忽略`)
      continue
    }
    const ikOrder = ikConstraintIndices.indexOf(constraintIndex)
    const track = emptyIkAnim(ikOrder)
    for (const key of keys) {
      track.mix.push({
        time: key.time,
        value: numberOr(key.mix, 1),
        easing: Easing.Linear,
        curve: null
      })
      duration = Math.max(duration, key.time)
    }
    iks.push(track)

    // 同时产出编辑器的完整约束轨道（mix）
    const full = emptyConstraintAnim(constraintIndex)
    full.mix = track.mix
    constraintTracks.push(full)
  }

  for (const [constraintName, keys] of Object.entries(animation.transform ?? {})) {
    const index = ctx.constraints.findIndex((c) => c.name === constraintName && c.type === 'transform')
    if (index < 0) continue
    const track = emptyConstraintAnim(index)
    for (const key of keys) {
      track.mixRotate.push(floatKey(key, 'mixRotate', 1))
      track.mixX.push(floatKey(key, 'mixX', 1))
      track.mixY.push(floatKey(key, 'mixY', 1))
      track.mixScaleX.push(floatKey(key, 'mixScaleX', 1))
      track.mixScaleY.push(floatKey(key, 'mixScaleY', 1))
      track.mixShearY.push(floatKey(key, 'mixShearY', 1))
      track.offsetRotate.push(floatKey(key, 'rotate', 0))
      track.offsetX.push(floatKey(key, 'x', 0, true))
      track.offsetY.push(floatKey(key, 'y', 0, true))
      duration = Math.max(duration, key.time)
    }
    constraintTracks.push(track)
  }

  for (const [constraintName, keys] of Object.entries(animation.path ?? {})) {
    const index = ctx.constraints.findIndex((c) => c.name === constraintName && c.type === 'path')
    if (index < 0) continue
    const track = emptyConstraintAnim(index)
    for (const key of keys) {
      track.position.push(floatKey(key, 'position', 0))
      track.spacing.push(floatKey(key, 'spacing', 0))
      track.rotateMix.push(floatKey(key, 'rotateMix', 1))
      track.translateMix.push(floatKey(key, 'translateMix', 1))
      duration = Math.max(duration, key.time)
    }
    constraintTracks.push(track)
  }

  return {
    name,
    duration: duration > 0 ? duration : 1,
    bones,
    slots,
    deforms,
    drawOrder,
    events,
    iks,
    constraints: constraintTracks
  }
}

function floatKey(
  key: Record<string, unknown>,
  field: string,
  fallback: number,
  scaled = false
): { time: number; value: number; easing: Easing; curve: number[] | null } {
  const raw = numberOr(key[field], fallback)
  return {
    time: key.time as number,
    value: scaled ? pxToUnit(raw) : raw,
    easing: Easing.Linear,
    curve: null
  }
}

/** deform 层级判定：第一层键能在插槽表找到 → 3.x 插槽层；否则是 4.x 皮肤层（只取第一个皮肤） */
function collectDeforms(
  animation: SpineAnimationJson,
  ctx: SpineAnimContext,
  out: DeformAnim[],
  onTime: (time: number) => void
): void {
  const deform = animation.deform
  if (!deform) return

  const keys = Object.keys(deform)
  if (keys.length === 0) return
  const isSlotLayer = ctx.slotIndex.has(keys[0])
  const layer = (
    isSlotLayer ? deform : (deform[keys[0]] ?? {})
  ) as unknown as Record<string, Record<string, Array<Record<string, unknown>>>>

  for (const [slotName, attachments] of Object.entries(layer)) {
    const slotIndex = ctx.slotIndex.get(slotName)
    if (slotIndex === undefined) continue
    for (const [attachmentName, frames] of Object.entries(attachments)) {
      if (!Array.isArray(frames)) continue
      const track = emptyDeformAnim(slotIndex, attachmentName)
      let need = 0
      for (const frame of frames) {
        const offset = numberOr(frame.offset, 0)
        const vertices = Array.isArray(frame.vertices) ? (frame.vertices as number[]) : []
        need = Math.max(need, Math.round(offset) + vertices.length)
        onTime(numberOr(frame.time, 0))
      }
      for (const frame of frames) {
        const offset = Math.max(0, Math.round(numberOr(frame.offset, 0)))
        const vertices = Array.isArray(frame.vertices) ? (frame.vertices as number[]) : []
        const offsets = new Array<number>(need).fill(0)
        for (let i = 0; i < vertices.length; i++) offsets[offset + i] = pxToUnit(vertices[i])
        const key: DeformKeyframe = {
          time: numberOr(frame.time, 0),
          offsets,
          vertexOffset: 0,
          easing: Easing.Linear,
          curve: null
        }
        track.frames.push(key)
      }
      if (track.frames.length > 0) out.push(track)
    }
  }
}

type SpineCurveKeyframeMap = Record<string, Array<Record<string, unknown>>>

/**
 * drawOrder 的 offsets 展开成完整顺序：
 * 依次把插槽从原位置取出，插入到 `原下标 + offset` 处（夹取到合法范围）。
 */
function expandDrawOrder(
  offsets: Array<Record<string, unknown>>,
  slotIndex: Map<string, number>
): number[] {
  const order = [...slotIndex.values()].sort((a, b) => a - b)
  const nameOf = new Map<number, string>()
  for (const [name, index] of slotIndex) nameOf.set(index, name)

  for (const entry of offsets) {
    const slotName = typeof entry.slot === 'string' ? entry.slot : ''
    const index = slotIndex.get(slotName)
    if (index === undefined) continue
    const from = order.indexOf(index)
    if (from < 0) continue
    order.splice(from, 1)
    const offset = Math.round(numberOr(entry.offset, 0))
    const target = Math.max(0, Math.min(order.length, from + offset))
    order.splice(target, 0, index)
  }
  void nameOf
  return order
}

function easingOf(curve: unknown): { easing: Easing; curve: number[] | null } {
  if (Array.isArray(curve) && curve.length >= 4) {
    return { easing: Easing.Bezier, curve: curve.slice(0, 4).map((v) => Number(v) || 0) }
  }
  if (typeof curve === 'number') {
    return { easing: Easing.Bezier, curve: [curve, 0, 1, 1] }
  }
  if (curve === 'stepped') return { easing: Easing.Stepped, curve: null }
  return { easing: Easing.Linear, curve: null }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
