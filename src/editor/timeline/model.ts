import { Easing } from '@core/model/animation'
import type { AuthoringAnimData, EditorDocument } from '@core/model/authoring'
import { keyBoneChannel, keyDeform, keySlotColor, pruneEmptyTracks } from '../commands/animationCommands'

export type KeyKind = 'bone' | 'slot' | 'deform' | 'constraint' | 'event'

export interface TimelineKey {
  /** 稳定标识：轨道 + 通道 + 时间（时间会随拖动变化，仅用于当前帧内的定位） */
  id: string
  trackId: string
  kind: KeyKind
  channel: string
  target: string
  attachment: string
  time: number
  easing: Easing
  curve: number[] | null
}

export interface TimelineTrack {
  id: string
  group: string
  label: string
  kind: KeyKind
  target: string
  attachment: string
  keys: TimelineKey[]
  /** 缩进层级：0 = 顶层（分组行 / 事件轨），1 = 骨骼通道等子轨道 */
  depth: number
  /** 分组行：只作标题与折叠入口，本身不含关键帧 */
  isGroup?: boolean
  /** 子轨道所属分组行 id（折叠时隐藏） */
  parentId?: string
  /** 分组行显示的关键帧总数 */
  keyCount?: number
  /** 子轨道对应的通道名（旋转 / 位置 / 缩放 / 错切） */
  channel?: string
}

/** 骨骼子轨道的顺序与中文名（位置在前，符合 TRS 习惯） */
const BONE_CHANNELS: Array<{ channel: 'translate' | 'rotate' | 'scale' | 'shear'; label: string }> = [
  { channel: 'translate', label: '位置' },
  { channel: 'rotate', label: '旋转' },
  { channel: 'scale', label: '缩放' },
  { channel: 'shear', label: '错切' }
]

/** 插槽子轨道：显示（切 display）在最前，它是做换装动画最常用的通道 */
const SLOT_CHANNELS: Array<{ channel: 'display' | 'color' | 'visible'; label: string }> = [
  { channel: 'display', label: '显示' },
  { channel: 'color', label: '颜色' },
  { channel: 'visible', label: '可见性' }
]

export interface KeySelector {
  kind: KeyKind
  target: string
  attachment: string
  channel: string
  time: number
}

const GROUP_LABEL: Record<KeyKind, string> = {
  bone: '骨骼',
  slot: '插槽',
  deform: 'FFD',
  constraint: '约束',
  event: '事件'
}

/** 从动画数据构建轨道 + 关键帧模型（供 dope sheet 渲染与编辑） */
export function buildTimeline(animation: AuthoringAnimData | null): TimelineTrack[] {
  if (!animation) return []
  const tracks: TimelineTrack[] = []

  // 事件轨永远排在最上面（时间轴上最容易先看到）
  if (animation.events.length > 0) {
    const keys: TimelineKey[] = animation.events.map((event) => ({
      id: `event:${event.time}:${event.name}`,
      trackId: 'event',
      kind: 'event' as const,
      channel: event.name,
      target: event.name,
      attachment: '',
      time: event.time,
      easing: Easing.Stepped,
      curve: null
    }))
    tracks.push(makeTrack('event', `事件（${animation.events.length}）`, '', 'event', keys))
  }

  // 骨骼：一行分组标题 + 每个有帧的通道各一行子轨道（位置 / 旋转 / 缩放 / 错切）
  for (const track of animation.bones) {
    pushGroupedTracks(
      tracks,
      'bone',
      track.bone,
      BONE_CHANNELS.map(({ channel, label }) => {
        const keys: TimelineKey[] = []
        pushKeys(keys, track.bone, '', 'bone', channel, track[channel])
        return { channel, label, keys }
      })
    )
  }

  // 插槽：同样是「分组行 + 子轨」，显示通道的每个帧带上附件名，便于一眼看出切到了哪个 display
  for (const track of animation.slots) {
    const displayKeys: TimelineKey[] = track.displayIndex.map((frame, index) => ({
      id: `slot:${track.slot}#display@${frame.time}`,
      trackId: `slot:${track.slot}`,
      kind: 'slot' as const,
      channel: 'display',
      target: track.slot,
      attachment: track.displayAttachment[index] ?? '',
      time: frame.time,
      easing: frame.easing,
      curve: frame.curve
    }))
    pushGroupedTracks(
      tracks,
      'slot',
      track.slot,
      SLOT_CHANNELS.map(({ channel, label }) => {
        if (channel === 'display') return { channel, label, keys: displayKeys }
        const keys: TimelineKey[] = []
        pushKeys(keys, track.slot, '', 'slot', channel, track[channel])
        return { channel, label, keys }
      })
    )
  }

  for (const track of animation.deforms) {
    const keys: TimelineKey[] = track.frames.map((frame) => ({
      id: `deform:${track.slot}:${track.attachment}@${frame.time}`,
      trackId: `deform:${track.slot}:${track.attachment}`,
      kind: 'deform' as const,
      channel: 'offsets',
      target: track.slot,
      attachment: track.attachment,
      time: frame.time,
      easing: frame.easing,
      curve: frame.curve
    }))
    if (keys.length > 0) {
      // target 用插槽名，attachment 单独带上 —— 与 KeySelector 的定位口径保持一致
      tracks.push(makeTrack('deform', `${track.slot} / ${track.attachment}`, track.attachment, track.slot, keys))
    }
  }

  for (const track of animation.constraints) {
    const keys: TimelineKey[] = []
    for (const [channel, list] of Object.entries(constraintFrames(track))) {
      pushKeys(keys, track.constraint, '', 'constraint', channel, list)
    }
    if (keys.length > 0) tracks.push(makeTrack('constraint', track.constraint, '', track.constraint, keys))
  }

  // 顺序：事件 → 骨骼（分组行 + 通道子轨）→ 插槽 → FFD → 约束。
  // 这里刻意不做二次排序：骨骼子轨道必须紧跟在自己的分组行后面，排序会打散这层结构。
  return tracks
}

type MutableFrame = { time: number; easing: Easing; curve: number[] | null }

/**
 * 重新定位：按 selector 找到关键帧，执行 mutate 后清理空轨道。
 * `subset` 是命中的关键帧（改值用），`frames` 是它所属的完整数组（删除用）。
 */
export function editKeys(
  doc: EditorDocument,
  animationName: string | null,
  selectors: readonly KeySelector[],
  mutate: (subset: MutableFrame[], frames: MutableFrame[]) => void
): number {
  const animation = doc.animations.find((item) => item.name === animationName)
  if (!animation) return 0
  let count = 0
  const grouped = new Map<string, KeySelector[]>()
  for (const selector of selectors) {
    const key = `${selector.kind}|${selector.target}|${selector.attachment}|${selector.channel}`
    const list = grouped.get(key) ?? []
    list.push(selector)
    grouped.set(key, list)
  }

  for (const list of grouped.values()) {
    const frames = resolveFrames(animation, list[0])
    if (!frames) continue
    // 只把命中的关键帧交给 mutate，避免误改同轨道的其它帧
    const subset = list
      .map((selector) => frames.find((frame) => Math.abs(frame.time - selector.time) < 1e-4))
      .filter((frame): frame is MutableFrame => Boolean(frame))
    if (subset.length === 0) continue
    mutate(subset, frames)
    count += subset.length
    sortFrames(frames)
  }
  pruneEmptyTracks(animation)
  syncDuration(animation)
  return count
}

/** 删除选中的关键帧（含事件帧） */
export function deleteKeys(doc: EditorDocument, animationName: string | null, selectors: readonly KeySelector[]): number {
  return editFrameTimes(doc, animationName, selectors, (subset, frames) => {
    for (const frame of subset) {
      const index = frames.indexOf(frame)
      if (index >= 0) frames.splice(index, 1)
    }
  })
}

/** 平移选中的关键帧（拖拽）：只改时间，保持排序；拖出原时长会自动延长动画 */
export function moveKeys(
  doc: EditorDocument,
  animationName: string | null,
  selectors: readonly KeySelector[],
  delta: number
): number {
  if (Math.abs(delta) < 1e-6) return 0
  // 只限制不能为负：往后拖会自动延长动画时长
  return editFrameTimes(doc, animationName, selectors, (subset) => {
    for (const frame of subset) frame.time = Math.max(0, frame.time + delta)
  })
}

/**
 * 动画时长跟随最晚的关键帧**只增不减**。
 * 关键帧被拖到原时长之后时自动延长动画，这样用户总能「往后面加帧」而不必先改时长。
 */
export function syncDuration(animation: AuthoringAnimData): number {
  let max = animation.duration
  const consider = (frames: ReadonlyArray<{ time: number }>): void => {
    for (const frame of frames) if (frame.time > max) max = frame.time
  }
  for (const track of animation.bones) {
    consider(track.rotate)
    consider(track.translate)
    consider(track.scale)
    consider(track.shear)
  }
  for (const track of animation.slots) {
    consider(track.color)
    consider(track.displayIndex)
    consider(track.visible)
  }
  for (const track of animation.deforms) consider(track.frames)
  for (const track of animation.constraints) {
    for (const list of Object.values(constraintFrames(track))) consider(list)
  }
  consider(animation.events)
  animation.duration = max
  return max
}

/**
 * 按「选择器（保存原始时间）+ 目标时间」重设关键帧时间。
 * 拖拽时每次都基于**原始时间**重算，避免增量累积误差；selector 始终能定位到原始帧。
 */
export function setKeysTimes(
  doc: EditorDocument,
  animationName: string | null,
  entries: ReadonlyArray<{ selector: KeySelector; time: number }>
): number {
  const animation = doc.animations.find((item) => item.name === animationName)
  if (!animation) return 0
  let count = 0
  for (const entry of entries) {
    const frames = resolveTimeFrames(animation, entry.selector)
    if (!frames) continue
    const frame = frames.find((item) => Math.abs(item.time - entry.selector.time) < 1e-4)
    if (!frame) continue
    frame.time = Math.max(0, entry.time)
    count++
  }
  // 全部处理完再排序，保证 selector → frame 的匹配不被中途排序破坏
  sortAllTracks(animation)
  syncDuration(animation)
  return count
}

/** 所有轨道的关键帧按时间重排（含事件轨） */
function sortAllTracks(animation: AuthoringAnimData): void {
  for (const track of animation.bones) {
    sortFrames(track.rotate)
    sortFrames(track.translate)
    sortFrames(track.scale)
    sortFrames(track.shear)
  }
  for (const track of animation.slots) {
    sortFrames(track.color)
    sortFrames(track.displayIndex)
    sortFrames(track.visible)
  }
  for (const track of animation.deforms) sortFrames(track.frames)
  for (const track of animation.constraints) {
    for (const list of Object.values(constraintFrames(track))) sortFrames(list)
  }
  sortFrames(animation.events)
}

export function setKeyEasing(
  doc: EditorDocument,
  animationName: string | null,
  selectors: readonly KeySelector[],
  easing: Easing,
  curve: number[] | null
): number {
  return editKeys(doc, animationName, selectors, (subset) => {
    for (const frame of subset) {
      frame.easing = easing
      frame.curve = easing === Easing.Bezier ? (curve ?? [0.25, 0.25, 0.75, 0.75]) : null
    }
  })
}

/**
 * 在当前时间点，为选中对象打关键帧（捕获当前姿态）。
 * 运行时姿态由 `pose` 提供（`skeleton.localRot` 等），因此打帧结果是所见即所得。
 */
export interface PoseSnapshot {
  localRot: Float32Array
  localPos: Float32Array
  localScale: Float32Array
  localShear: Float32Array
  /** 运行期插槽颜色（RGBA 对象数组） */
  slotColors: Array<{ r: number; g: number; b: number; a: number }>
  deformOffsets: Array<number[] | null>
  boneIndex: Record<string, number>
  slotIndex: Record<string, number>
}

export function keyframeTargets(
  doc: EditorDocument,
  animationName: string | null,
  pose: PoseSnapshot,
  targets: readonly {
    kind: KeyKind
    target: string
    attachment: string
  }[],
  time: number
): number {
  const animation = doc.animations.find((item) => item.name === animationName)
  if (!animation) return 0
  let count = 0
  for (const target of targets) {
    if (target.kind === 'bone') {
      const index = pose.boneIndex[target.target]
      if (index === undefined) continue
      keyBoneChannel(animation, target.target, 'rotate', time, pose.localRot[index])
      keyBoneChannel(animation, target.target, 'translate', time, {
        x: pose.localPos[index * 2],
        y: pose.localPos[index * 2 + 1]
      })
      keyBoneChannel(animation, target.target, 'scale', time, {
        x: pose.localScale[index * 2],
        y: pose.localScale[index * 2 + 1]
      })
      keyBoneChannel(animation, target.target, 'shear', time, {
        x: pose.localShear[index * 2],
        y: pose.localShear[index * 2 + 1]
      })
      count++
      continue
    }
    if (target.kind === 'slot') {
      const index = pose.slotIndex[target.target]
      const color = index === undefined ? undefined : pose.slotColors[index]
      if (!color) continue
      keySlotColor(animation, target.target, time, { r: color.r, g: color.g, b: color.b, a: color.a })
      count++
      continue
    }
    if (target.kind === 'deform' && target.attachment) {
      const index = pose.slotIndex[target.target]
      const offsets = index === undefined ? null : pose.deformOffsets[index]
      if (!offsets) continue
      keyDeform(animation, target.target, target.attachment, time, offsets)
      count++
    }
  }
  if (count > 0) syncDuration(animation)
  return count
}

export { GROUP_LABEL }

/**
 * 「分组行 + 通道子轨」两层的轨道结构（骨骼与插槽共用）：
 * 分组行只作标题与折叠入口，子轨各自持有自己的关键帧；没有任何子轨时整组不出现。
 */
function pushGroupedTracks(
  tracks: TimelineTrack[],
  kind: KeyKind,
  target: string,
  channels: Array<{ channel: string; label: string; keys: TimelineKey[] }>
): void {
  const children: TimelineTrack[] = []
  let total = 0
  for (const item of channels) {
    if (item.keys.length === 0) continue
    total += item.keys.length
    children.push({
      id: `${kind}:${target}:${item.channel}`,
      group: target,
      label: item.label,
      kind,
      target,
      attachment: '',
      keys: item.keys.sort((a, b) => a.time - b.time),
      depth: 1,
      parentId: `${kind}:${target}`,
      channel: item.channel
    })
  }
  if (children.length === 0) return
  tracks.push({
    id: `${kind}:${target}`,
    group: target,
    label: target,
    kind,
    target,
    attachment: '',
    keys: [],
    depth: 0,
    isGroup: true,
    keyCount: total
  })
  tracks.push(...children)
}

function makeTrack(kind: KeyKind, label: string, attachment: string, target: string, keys: TimelineKey[]): TimelineTrack {
  return {
    id: `${kind}:${target}${attachment ? `:${attachment}` : ''}`,
    group: GROUP_LABEL[kind],
    label,
    kind,
    target,
    attachment,
    keys: keys.sort((a, b) => a.time - b.time),
    depth: 0
  }
}

function pushKeys(
  out: TimelineKey[],
  target: string,
  attachment: string,
  kind: KeyKind,
  channel: string,
  frames: ReadonlyArray<{ time: number; easing: Easing; curve: number[] | null }>
): void {
  const trackId = `${kind}:${target}${attachment ? `:${attachment}` : ''}`
  for (const frame of frames) {
    out.push({
      id: `${trackId}#${channel}@${frame.time}`,
      trackId,
      kind,
      channel,
      target,
      attachment,
      time: frame.time,
      easing: frame.easing,
      curve: frame.curve
    })
  }
}

function constraintFrames(track: AuthoringAnimData['constraints'][number]): Record<string, Array<{ time: number; easing: Easing; curve: number[] | null }>> {
  return {
    mix: track.mix,
    mixRotate: track.mixRotate,
    mixX: track.mixX,
    mixY: track.mixY,
    mixScaleX: track.mixScaleX,
    mixScaleY: track.mixScaleY,
    mixShearY: track.mixShearY,
    offsetRotate: track.offsetRotate,
    offsetX: track.offsetX,
    offsetY: track.offsetY,
    offsetScaleX: track.offsetScaleX,
    offsetScaleY: track.offsetScaleY,
    offsetShearY: track.offsetShearY,
    position: track.position,
    spacing: track.spacing,
    rotateMix: track.rotateMix,
    translateMix: track.translateMix
  }
}

/**
 * 关键帧的宽松结构：不同通道的 `value` 类型不同（数值 / 二维 / 颜色 / 布尔），
 * 事件帧则没有 value 而是 name + 三个参数。属性检查器按值形状分派编辑控件。
 */
export interface AnyKeyframe {
  time: number
  easing?: Easing
  curve?: number[] | null
  value?: unknown
  name?: string
  stringParam?: string
  intParam?: number
  floatParam?: number
  offsets?: number[]
  vertexOffset?: number
}

/**
 * 时间类操作的定位：在 `resolveFrames` 基础上**额外支持事件轨**。
 * 事件关键帧只有时间（没有 easing/curve），因此拖动 / 删除 / 重设时间都走这个入口。
 */
function resolveTimeFrames(animation: AuthoringAnimData, selector: KeySelector): Array<AnyKeyframe> | null {
  if (selector.kind === 'event') return animation.events
  return resolveFrames(animation, selector)
}

/** 供属性检查器读取关键帧实体（找不到返回 null） */
export function findKeyframe(
  animation: AuthoringAnimData | null | undefined,
  selector: KeySelector
): AnyKeyframe | null {
  if (!animation) return null
  const frames = resolveTimeFrames(animation, selector)
  if (!frames) return null
  return frames.find((item) => Math.abs(item.time - selector.time) < 1e-4) ?? null
}

/** 时间类编辑的通用实现（移动 / 删除 / 重设时间），事件轨参与 */
function editFrameTimes(
  doc: EditorDocument,
  animationName: string | null,
  selectors: readonly KeySelector[],
  mutate: (subset: Array<{ time: number }>, frames: Array<{ time: number }>) => void
): number {
  const animation = doc.animations.find((item) => item.name === animationName)
  if (!animation) return 0
  let count = 0
  const grouped = new Map<string, KeySelector[]>()
  for (const selector of selectors) {
    const key = `${selector.kind}|${selector.target}|${selector.attachment}|${selector.channel}`
    const list = grouped.get(key) ?? []
    list.push(selector)
    grouped.set(key, list)
  }

  for (const list of grouped.values()) {
    const frames = resolveTimeFrames(animation, list[0])
    if (!frames) continue
    const subset = list
      .map((selector) => frames.find((frame) => Math.abs(frame.time - selector.time) < 1e-4))
      .filter((frame): frame is { time: number } => Boolean(frame))
    if (subset.length === 0) continue
    mutate(subset, frames)
    count += subset.length
  }
  sortAllTracks(animation)
  syncDuration(animation)
  return count
}

function resolveFrames(
  animation: AuthoringAnimData,
  selector: KeySelector
): Array<{ time: number; easing: Easing; curve: number[] | null }> | null {
  if (selector.kind === 'bone') {
    const track = animation.bones.find((item) => item.bone === selector.target)
    if (!track) return null
    if (selector.channel === 'rotate') return track.rotate
    if (selector.channel === 'translate') return track.translate
    if (selector.channel === 'scale') return track.scale
    return track.shear
  }
  if (selector.kind === 'slot') {
    const track = animation.slots.find((item) => item.slot === selector.target)
    if (!track) return null
    if (selector.channel === 'color') return track.color
    if (selector.channel === 'visible') return track.visible
    return track.displayIndex
  }
  if (selector.kind === 'deform') {
    const track = animation.deforms.find(
      (item) => item.slot === selector.target && item.attachment === selector.attachment
    )
    return track ? track.frames : null
  }
  if (selector.kind === 'constraint') {
    const track = animation.constraints.find((item) => item.constraint === selector.target)
    if (!track) return null
    return constraintFrames(track)[selector.channel] ?? null
  }
  return null
}

function sortFrames(frames: Array<{ time: number }>): void {
  frames.sort((a, b) => a.time - b.time)
}
