import type { Vec2 } from '../math/matrix'
import type { RGBA } from './types'

/** 平滑方式。Bezier 的 4 个控制量与 Spine 一致：[cx1, cy1, cx2, cy2]。 */
export enum Easing {
  Linear = 0,
  Stepped = 1,
  Bezier = 2
}

export interface KeyframeBase {
  /** 秒 */
  time: number
  easing: Easing
  curve: number[] | null
}

export interface FloatKeyframe extends KeyframeBase {
  value: number
}

export interface Float2Keyframe extends KeyframeBase {
  value: Vec2
}

export interface ColorKeyframe extends KeyframeBase {
  value: RGBA
}

export interface IntKeyframe extends KeyframeBase {
  value: number
}

export interface DeformKeyframe extends KeyframeBase {
  /** 满顶点长度的 (x,y) 偏移数组 */
  offsets: number[]
  /** 偏移作用的起始顶点下标（参考库恒为 0） */
  vertexOffset: number
}

/**
 * 子骨架控制关键帧（编辑器扩展，对应 DragonBones 的 slot 帧 `actions.gotoAndPlay`）。
 *
 * 一条关键帧同时带「动画名 + 循环 + 偏移 + 倍速」，而不是拆成 4 条并行轨道：
 * 并行数组一旦某一列错位，动画名就会指到别的插槽上（`displayIndex ↔ displayAttachment`
 * 已经踩过这个坑），对象型关键帧则天然不掉队。
 *
 * 时间语义：`time` 是**父动画**里的时间，`offset` 是子动画内部的起始时刻。
 * 首个关键帧之前沿用附件的 setup 默认值（`AttachmentData.subAnimation/...`）。
 */
export interface SubArmatureKeyframe extends KeyframeBase {
  /** 子骨架动画名；空串 = 回 setup 姿态（相当于 DragonBones 的 gotoAndStop） */
  animation: string
  /** 0 = 无限循环；n = 播 n 次后定格末帧 */
  playTimes: number
  /** 起始偏移（秒） */
  offset: number
  /** 倍速，1 = 原速 */
  speed: number
}

/** 该时刻完整的插槽绘制顺序（非增量） */
export interface DrawOrderKeyframe {
  time: number
  order: number[]
}

export interface EventKeyframe {
  time: number
  name: string
  stringParam: string
  intParam: number
  floatParam: number
}

export interface BoneAnim {
  boneIndex: number
  translate: Float2Keyframe[]
  rotate: FloatKeyframe[]
  scale: Float2Keyframe[]
  shear: Float2Keyframe[]
}

export interface SlotAnim {
  slotIndex: number
  color: ColorKeyframe[]
  displayIndex: IntKeyframe[]
  /** 与 displayIndex 一一对应的附件名（空串 = 该帧隐藏 / 用下标兜底） */
  displayAttachment: string[]
  /**
   * 可见性轨道。
   * 参考库中该轨道未被采样（运行期覆盖优先）；编辑器会实现采样，导出报告需标注差异。
   */
  visible: IntKeyframe[]
  /** 子骨架动画控制（仅该插槽挂有 armature display 时有意义） */
  subArmature: SubArmatureKeyframe[]
}

export interface DeformAnim {
  slotIndex: number
  attachmentName: string
  frames: DeformKeyframe[]
}

/** 参考库的 IK 动画轨道（仅 mix） */
export interface IkAnim {
  ikIndex: number
  mix: FloatKeyframe[]
}

/**
 * 约束动画轨道（编辑器扩展）。按约束类型使用对应字段，缺省字段表示该类型没有这条轨道。
 * ik 用 mix；transform 用 mixRotate/mixX/... 与 offsetRotate/offsetX/...；
 * path 用 position/spacing/rotateMix/translateMix。
 */
export interface ConstraintAnim {
  constraintIndex: number
  mix: FloatKeyframe[]
  mixRotate: FloatKeyframe[]
  mixX: FloatKeyframe[]
  mixY: FloatKeyframe[]
  mixScaleX: FloatKeyframe[]
  mixScaleY: FloatKeyframe[]
  mixShearY: FloatKeyframe[]
  offsetRotate: FloatKeyframe[]
  offsetX: FloatKeyframe[]
  offsetY: FloatKeyframe[]
  offsetScaleX: FloatKeyframe[]
  offsetScaleY: FloatKeyframe[]
  offsetShearY: FloatKeyframe[]
  position: FloatKeyframe[]
  spacing: FloatKeyframe[]
  rotateMix: FloatKeyframe[]
  translateMix: FloatKeyframe[]
}

export interface AnimData {
  name: string
  /** 秒 */
  duration: number
  bones: BoneAnim[]
  slots: SlotAnim[]
  deforms: DeformAnim[]
  drawOrder: DrawOrderKeyframe[]
  events: EventKeyframe[]
  iks: IkAnim[]
  constraints: ConstraintAnim[]
}

// ---------------- 工厂与工具 ----------------

/**
 * 动画里最晚的关键帧时间（秒，含事件 / 绘制顺序 / 约束轨道）。
 *
 * 播放长度按它计算：非循环播到最后一帧停下，循环则回到第一帧。
 * 这样即使数据里的 duration 字段不准（旧文件 / 外部数据），也不会播到尾部的空白区。
 */
export function lastKeyframeTime(anim: AnimData): number {
  let last = 0
  const consider = (frames: ReadonlyArray<{ time: number }>): void => {
    for (const frame of frames) if (frame.time > last) last = frame.time
  }
  for (const track of anim.bones) {
    consider(track.translate)
    consider(track.rotate)
    consider(track.scale)
    consider(track.shear)
  }
  for (const track of anim.slots) {
    consider(track.color)
    consider(track.displayIndex)
    consider(track.visible)
    if (track.subArmature) consider(track.subArmature)
  }
  for (const track of anim.deforms) consider(track.frames)
  for (const track of anim.iks) consider(track.mix)
  for (const track of anim.constraints) {
    for (const list of Object.values(track)) {
      if (Array.isArray(list)) consider(list as ReadonlyArray<{ time: number }>)
    }
  }
  consider(anim.drawOrder)
  consider(anim.events)
  return last
}

export function emptyFloatKeyframe(time = 0, value = 0): FloatKeyframe {
  return { time, value, easing: Easing.Linear, curve: null }
}

export function emptyFloat2Keyframe(time = 0, value: Vec2 = { x: 0, y: 0 }): Float2Keyframe {
  return { time, value: { x: value.x, y: value.y }, easing: Easing.Linear, curve: null }
}

export function emptyColorKeyframe(time = 0, value: RGBA = { r: 1, g: 1, b: 1, a: 1 }): ColorKeyframe {
  return { time, value: { ...value }, easing: Easing.Linear, curve: null }
}

export function emptyIntKeyframe(time = 0, value = 0): IntKeyframe {
  return { time, value, easing: Easing.Stepped, curve: null }
}

export function emptyDeformKeyframe(time = 0, offsets: number[] = []): DeformKeyframe {
  return { time, offsets, vertexOffset: 0, easing: Easing.Linear, curve: null }
}

export function emptyBoneAnim(boneIndex: number): BoneAnim {
  return { boneIndex, translate: [], rotate: [], scale: [], shear: [] }
}

export function emptySlotAnim(slotIndex: number): SlotAnim {
  return { slotIndex, color: [], displayIndex: [], displayAttachment: [], visible: [], subArmature: [] }
}

export function emptySubArmatureKeyframe(
  time = 0,
  animation = '',
  playTimes = 0,
  offset = 0,
  speed = 1
): SubArmatureKeyframe {
  // 离散量（动画名 / 循环次数）按阶跃，偏移与倍速同一帧内也不需要插值
  return { time, easing: Easing.Stepped, curve: null, animation, playTimes, offset, speed }
}

export function emptyDeformAnim(slotIndex: number, attachmentName: string): DeformAnim {
  return { slotIndex, attachmentName, frames: [] }
}

export function emptyIkAnim(ikIndex: number): IkAnim {
  return { ikIndex, mix: [] }
}

export function emptyConstraintAnim(constraintIndex: number): ConstraintAnim {
  return {
    constraintIndex,
    mix: [],
    mixRotate: [],
    mixX: [],
    mixY: [],
    mixScaleX: [],
    mixScaleY: [],
    mixShearY: [],
    offsetRotate: [],
    offsetX: [],
    offsetY: [],
    offsetScaleX: [],
    offsetScaleY: [],
    offsetShearY: [],
    position: [],
    spacing: [],
    rotateMix: [],
    translateMix: []
  }
}

export function emptyAnimData(name = 'animation'): AnimData {
  return {
    name,
    duration: 1,
    bones: [],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    iks: [],
    constraints: []
  }
}

/** 二分查找：最后一个 time <= target 的下标；全部大于 target 时返回 -1 */
export function lowerBoundByTime<T extends { time: number }>(keys: readonly T[], target: number): number {
  let lo = 0
  let hi = keys.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** 精确命中某时间的关键帧下标，找不到返回 -1（容差 1e-4 秒） */
export function findKeyframeAt<T extends { time: number }>(keys: readonly T[], time: number): number {
  const idx = lowerBoundByTime(keys, time + 1e-4)
  if (idx < 0) return -1
  return Math.abs(keys[idx].time - time) <= 1e-3 ? idx : -1
}

/** 按时间升序插入（覆盖同时间点的关键帧），返回插入后的下标 */
export function upsertKeyframe<T extends { time: number }>(keys: T[], key: T): number {
  const existing = findKeyframeAt(keys, key.time)
  if (existing >= 0) {
    keys[existing] = key
    return existing
  }
  keys.push(key)
  keys.sort((a, b) => a.time - b.time)
  return keys.indexOf(key)
}

export function removeKeyframeAt<T extends { time: number }>(keys: T[], time: number): boolean {
  const idx = findKeyframeAt(keys, time)
  if (idx < 0) return false
  keys.splice(idx, 1)
  return true
}

/** 轨道是否有内容 */
export function trackHasKeys(track: readonly { time: number }[] | undefined): boolean {
  return track !== undefined && track.length > 0
}
