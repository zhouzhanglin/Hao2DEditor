import {
  emptyColorKeyframe,
  emptyDeformKeyframe,
  emptyFloat2Keyframe,
  emptyFloatKeyframe,
  emptySubArmatureKeyframe,
  removeKeyframeAt,
  upsertKeyframe
} from '@core/model/animation'
import type { DeformKeyframe, EventKeyframe, Float2Keyframe, FloatKeyframe } from '@core/model/animation'
import type {
  AuthoringAnimData,
  AuthoringBoneAnim,
  AuthoringConstraintAnim,
  AuthoringDeformAnim,
  AuthoringDrawOrderKeyframe,
  AuthoringSlotAnim
} from '@core/model/authoring'
import type { RGBA } from '@core/model/types'

/**
 * 动画轨道写入命令。
 *
 * 约定：所有 `ensure*` 都返回**草稿里的对象引用**（调用方在 immer/拷贝草稿上执行），
 * 关键帧统一用 `upsertKeyframe` 插入，保证按时间排序且同时间点覆盖。
 */

export type BoneChannel = 'translate' | 'rotate' | 'scale' | 'shear'

export function ensureBoneAnim(anim: AuthoringAnimData, bone: string): AuthoringBoneAnim {
  let track = anim.bones.find((item) => item.bone === bone)
  if (!track) {
    track = { bone, translate: [], rotate: [], scale: [], shear: [] }
    anim.bones.push(track)
  }
  return track
}

export function ensureSlotAnim(anim: AuthoringAnimData, slot: string): AuthoringSlotAnim {
  let track = anim.slots.find((item) => item.slot === slot)
  if (!track) {
    track = { slot, color: [], displayIndex: [], displayAttachment: [], visible: [], subArmature: [] }
    anim.slots.push(track)
  }
  return track
}

/**
 * FFD 轨道的皮肤归属：**默认皮肤 → 空串**（与老工程 / 无皮肤归属的轨道兼容），
 * 其它皮肤 → 写皮肤名。
 *
 * 为什么必须带：换装皮肤里的链接网格与默认皮肤的源网格**同名、同槽位、同显示下标**，
 * 运行期只靠 `track.skin` 判定归属（见 player.applyDeform）；不写就会把变形加到源网格上。
 */
export function deformSkinTag(doc: { skins: readonly { name: string }[] }, skinName: string): string {
  const name = (skinName ?? '').trim()
  if (!name) return ''
  const defaultSkin = doc.skins.find((item) => item.name === 'default') ?? doc.skins[0]
  return defaultSkin && defaultSkin.name === name ? '' : name
}

export function ensureDeformAnim(
  anim: AuthoringAnimData,
  slot: string,
  attachment: string,
  skin = ''
): AuthoringDeformAnim {
  const wanted = skin.trim()
  let track = anim.deforms.find(
    (item) => item.slot === slot && item.attachment === attachment && (item.skin ?? '') === wanted
  )
  if (!track) {
    track = { slot, attachment, frames: [] }
    if (wanted) track.skin = wanted
    anim.deforms.push(track)
  }
  return track
}

/** 约束的数值通道打一帧（物理 / 变换 / 路径 / IK 共用；通道不存在返回 false） */
export function keyConstraintChannel(
  anim: AuthoringAnimData,
  constraint: string,
  channel: string,
  time: number,
  value: number
): boolean {
  const track = ensureConstraintAnim(anim, constraint)
  const keys = (track as unknown as Record<string, FloatKeyframe[] | undefined>)[channel]
  if (!Array.isArray(keys)) return false
  upsertKeyframe(keys, emptyFloatKeyframe(time, value))
  return true
}

export function ensureConstraintAnim(anim: AuthoringAnimData, constraint: string): AuthoringConstraintAnim {
  let track = anim.constraints.find((item) => item.constraint === constraint)
  if (!track) {
    track = {
      constraint,
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
      translateMix: [],
      inertia: [],
      strength: [],
      damping: [],
      mass: [],
      wind: [],
      gravity: [],
      reset: []
    }
    anim.constraints.push(track)
  }
  return track
}

/** 写入骨骼变换通道的关键帧，返回是否真正改动了数据 */
export function keyBoneChannel(
  anim: AuthoringAnimData,
  bone: string,
  channel: BoneChannel,
  time: number,
  value: number | { x: number; y: number }
): boolean {
  const track = ensureBoneAnim(anim, bone)
  if (channel === 'rotate') {
    const frame = emptyFloatKeyframe(time, typeof value === 'number' ? value : value.y)
    upsertKeyframe(track.rotate, frame)
    return true
  }
  const vec = typeof value === 'number' ? { x: value, y: value } : value
  const frame: Float2Keyframe = emptyFloat2Keyframe(time, vec)
  if (channel === 'translate') upsertKeyframe(track.translate, frame)
  else if (channel === 'scale') upsertKeyframe(track.scale, frame)
  else upsertKeyframe(track.shear, frame)
  return true
}

/** 删除某个通道在指定时间点的关键帧 */
export function removeBoneKeyframe(
  anim: AuthoringAnimData,
  bone: string,
  channel: BoneChannel,
  time: number
): boolean {
  const track = anim.bones.find((item) => item.bone === bone)
  if (!track) return false
  const removed =
    channel === 'rotate'
      ? removeKeyframeAt(track.rotate, time)
      : channel === 'translate'
        ? removeKeyframeAt(track.translate, time)
        : channel === 'scale'
          ? removeKeyframeAt(track.scale, time)
          : removeKeyframeAt(track.shear, time)
  pruneBoneTrack(anim, track)
  return removed
}

export function keySlotColor(anim: AuthoringAnimData, slot: string, time: number, color: RGBA): void {
  const track = ensureSlotAnim(anim, slot)
  upsertKeyframe(track.color, emptyColorKeyframe(time, color))
}

/**
 * 打一帧**绘制顺序**关键帧：`order` 是完整的插槽名序列，**第 0 个最先画（最底层）**。
 * 同一时刻只保留一帧（离散帧，重复打关键帧即覆盖），打完按时间排序。
 */
export function keyDrawOrder(anim: AuthoringAnimData, time: number, order: readonly string[]): void {
  const frames = anim.drawOrder.filter((frame) => Math.abs(frame.time - time) > 1e-4)
  frames.push({ time, order: [...order] })
  frames.sort((left, right) => left.time - right.time)
  anim.drawOrder = frames
}

/** 取当前时刻生效的绘制顺序帧（最后一个 time <= t 的帧）；没有则返回 null（用 setup 顺序） */
export function drawOrderFrameAt(
  anim: AuthoringAnimData,
  time: number
): AuthoringDrawOrderKeyframe | null {
  let found: AuthoringDrawOrderKeyframe | null = null
  for (const frame of anim.drawOrder) {
    if (frame.time <= time + 1e-6) found = frame
  }
  return found
}

// ---------------- 事件帧 ----------------

/** 按时间点找事件帧（4 位小数口径，与打帧一致）：同一时间点只允许一个事件帧 */
export function eventFrameAt(anim: AuthoringAnimData, time: number): EventKeyframe | null {
  return anim.events.find((event) => Math.abs(event.time - time) < 1e-4) ?? null
}

/** 事件名默认取 `event`、`event2`…（避开整个动画里已用过的名字） */
export function nextEventName(events: readonly EventKeyframe[]): string {
  const used = new Set(events.map((event) => event.name))
  if (!used.has('event')) return 'event'
  for (let i = 2; i < 10000; i++) {
    const candidate = `event${i}`
    if (!used.has(candidate)) return candidate
  }
  return `event${events.length + 1}`
}

/**
 * 写入一个事件帧：**同一时间点只允许一个事件帧**（不同名的事件也不许并存）。
 *
 * 该时间点已有事件时就地覆盖**给出的字段**，没给的保持原值 —— 重复打帧不会叠出第二个
 * 事件（否则播放时同一时刻会全部触发，时间轴上看又只是一个标记），
 * 也不会把已有事件的名字 / 参数冲回默认值。
 */
export function keyEventFrame(
  anim: AuthoringAnimData,
  time: number,
  value: { name?: string; stringParam?: string; intParam?: number; floatParam?: number } = {}
): { frame: EventKeyframe; replaced: boolean } {
  const existing = eventFrameAt(anim, time)
  if (existing) {
    if (value.name !== undefined) existing.name = value.name
    if (value.stringParam !== undefined) existing.stringParam = value.stringParam
    if (value.intParam !== undefined) existing.intParam = value.intParam
    if (value.floatParam !== undefined) existing.floatParam = value.floatParam
    return { frame: existing, replaced: true }
  }
  const frame: EventKeyframe = {
    time,
    name: value.name ?? nextEventName(anim.events),
    stringParam: value.stringParam ?? '',
    intParam: value.intParam ?? 0,
    floatParam: value.floatParam ?? 0
  }
  anim.events.push(frame)
  anim.events.sort((left, right) => left.time - right.time)
  return { frame, replaced: false }
}

export function keySlotDisplay(
  anim: AuthoringAnimData,
  slot: string,
  time: number,
  displayIndex: number,
  attachmentName: string
): void {
  const track = ensureSlotAnim(anim, slot)
  // displayIndex 帧与 displayAttachment（附件名）是**两个并行数组**，运行期按名字解析显示项。
  // 这里必须「帧 + 名字」成对写入再成对排序：先 upsert 帧、再按下标补名字的写法，
  // 在「往中间插帧」时会把已有帧的名字挤到别的帧上（错位）→
  // 播放时该插槽显示成别的附件，或索引越界干脆不画（表现为「有的图丢失看不见」）。
  const pairs = track.displayIndex.map((frame, index) => ({
    frame,
    name: track.displayAttachment[index] ?? ''
  }))
  const existing = pairs.find((pair) => Math.abs(pair.frame.time - time) < 1e-4)
  if (existing) {
    existing.frame.value = displayIndex
    existing.frame.easing = 1
    existing.frame.curve = null
    existing.name = attachmentName
  } else {
    pairs.push({ frame: { time, value: displayIndex, easing: 1, curve: null }, name: attachmentName })
  }
  pairs.sort((left, right) => left.frame.time - right.frame.time)
  track.displayIndex = pairs.map((pair) => pair.frame)
  track.displayAttachment = pairs.map((pair) => pair.name)
}

/**
 * 打「子骨架」控制帧：一条帧同时带动画名 / 循环次数 / 起始偏移 / 倍速。
 *
 * 对象型关键帧没有并行数组，`upsertKeyframe` 按时间覆盖即可，不存在错位问题。
 */
export function keySlotSubArmature(
  anim: AuthoringAnimData,
  slot: string,
  time: number,
  key: { animation: string; playTimes: number; offset: number; speed: number }
): void {
  const track = ensureSlotAnim(anim, slot)
  if (!track.subArmature) track.subArmature = []
  upsertKeyframe(
    track.subArmature,
    // 0 / 负数都表示循环（-1 更直白），不要夹到 0
    emptySubArmatureKeyframe(time, key.animation, Math.round(key.playTimes), key.offset, key.speed)
  )
}

export function keySlotVisible(anim: AuthoringAnimData, slot: string, time: number, visible: boolean): void {
  const track = ensureSlotAnim(anim, slot)
  upsertKeyframe(track.visible, { time, value: visible ? 1 : 0, easing: 1, curve: null })
}

/** 写入 FFD：offsets 为满顶点长度的 [x0,y0,x1,y1,...]；`skin` 见 deformSkinTag */
export function keyDeform(
  anim: AuthoringAnimData,
  slot: string,
  attachment: string,
  time: number,
  offsets: number[],
  vertexOffset = 0,
  skin = ''
): void {
  const track = ensureDeformAnim(anim, slot, attachment, skin)
  upsertKeyframe(track.frames, emptyDeformKeyframe(time, [...offsets]))
  const frame = track.frames.find((item) => Math.abs(item.time - time) < 1e-4)
  if (frame) frame.vertexOffset = vertexOffset
}

export function removeDeformKeyframe(
  anim: AuthoringAnimData,
  slot: string,
  attachment: string,
  time: number
): boolean {
  const index = anim.deforms.findIndex((item) => item.slot === slot && item.attachment === attachment)
  if (index < 0) return false
  const track = anim.deforms[index]
  const removed = removeKeyframeAt(track.frames, time)
  if (track.frames.length === 0) anim.deforms.splice(index, 1)
  return removed
}

/** 清掉空轨道，避免工程文件里堆积无用数据 */
export function pruneEmptyTracks(anim: AuthoringAnimData): void {
  anim.bones = anim.bones.filter((track) => !isEmptyBoneTrack(track))
  anim.slots = anim.slots.filter(
    (track) =>
      track.color.length > 0 ||
      track.displayIndex.length > 0 ||
      track.visible.length > 0 ||
      (track.subArmature?.length ?? 0) > 0
  )
  anim.deforms = anim.deforms.filter((track) => track.frames.length > 0)
  anim.constraints = anim.constraints.filter((track) => !isEmptyConstraintTrack(track))
}

function isEmptyBoneTrack(track: AuthoringBoneAnim): boolean {
  return (
    track.translate.length === 0 && track.rotate.length === 0 && track.scale.length === 0 && track.shear.length === 0
  )
}

function pruneBoneTrack(anim: AuthoringAnimData, track: AuthoringBoneAnim): void {
  if (isEmptyBoneTrack(track)) {
    const index = anim.bones.indexOf(track)
    if (index >= 0) anim.bones.splice(index, 1)
  }
}

function isEmptyConstraintTrack(track: AuthoringConstraintAnim): boolean {
  const lists: FloatKeyframe[][] = [
    track.mix,
    track.mixRotate,
    track.mixX,
    track.mixY,
    track.mixScaleX,
    track.mixScaleY,
    track.mixShearY,
    track.offsetRotate,
    track.offsetX,
    track.offsetY,
    track.offsetScaleX,
    track.offsetScaleY,
    track.offsetShearY,
    track.position,
    track.spacing,
    track.rotateMix,
    track.translateMix
  ]
  return lists.every((list) => list.length === 0)
}

/** 读取某时刻的关键帧值（用于拖拽起点快照），无则返回 null */
export function frameValueAt<T extends { time: number }>(frames: readonly T[], time: number): T | null {
  const found = frames.find((frame) => Math.abs(frame.time - time) < 1e-4)
  return found ?? null
}

export type { DeformKeyframe, FloatKeyframe }
