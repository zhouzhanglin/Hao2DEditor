import { Easing } from '@core/model/animation'
import { lastKeyTime } from '@core/model/authoring'
import type { AuthoringAnimData, AuthoringSlotAnim, EditorDocument } from '@core/model/authoring'
import {
  keyBoneChannel,
  keyDeform,
  keySlotColor,
  keySlotDisplay,
  keySlotVisible,
  pruneEmptyTracks
} from '../commands/animationCommands'

export type KeyKind = 'bone' | 'slot' | 'deform' | 'constraint' | 'event' | 'drawOrder'

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
  /** 子轨道对应的通道名（旋转 / 位置 / 缩放 / 斜切） */
  channel?: string
}

/** 骨骼子轨道的顺序与中文名（位置在前，符合 TRS 习惯） */
const BONE_CHANNELS: Array<{ channel: 'translate' | 'rotate' | 'scale' | 'shear'; label: string }> = [
  { channel: 'translate', label: '位置' },
  { channel: 'rotate', label: '旋转' },
  { channel: 'scale', label: '缩放' },
  { channel: 'shear', label: '斜切' }
]

/**
 * 插槽子轨道：显示（切 display）在最前，它是做换装动画最常用的通道。
 *
 * `always`：没有关键帧时也把这一行留在时间轴上 —— 「显示」是换装动画的入口，
 * 藏起来用户就找不到在哪儿切 display 了（右键该行可以选要显示的 display 并打关键帧）。
 */
const SLOT_CHANNELS: Array<{ channel: 'display' | 'color' | 'visible'; label: string; always?: boolean }> = [
  { channel: 'display', label: '显示', always: true },
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
  event: '事件',
  drawOrder: '插槽层级'
}

/**
 * 当前时间点某插槽实际显示的 display 名（空串 = 不显示）；没有 display 轨道 / 早于第一帧时用 setup 名。
 *
 * 采样规则与运行期一致（见 core/anim/player.ts 的 resolveDisplay）：取 `time <= t` 的最后一帧，
 * 名字为空表示这一帧起不显示。Animate 态判断「是否正在显示某个 display」要用它，
 * 不能用 `slot.attachment`：打显示关键帧不改 setup，用 setup 判断会得到
 * 「打完显示帧后再点没反应」的错觉。
 */
export function slotDisplayNameAt(
  animation: AuthoringAnimData | null,
  slotName: string,
  time: number,
  setupName: string
): string {
  const track = animation?.slots.find((item) => item.slot === slotName)
  if (!track || track.displayIndex.length === 0) return setupName
  let best = Number.NEGATIVE_INFINITY
  let name = setupName
  for (let i = 0; i < track.displayIndex.length; i++) {
    const frameTime = track.displayIndex[i].time
    // 不依赖帧一定有序：取所有 `<= t` 的帧里时间最大的那个
    if (frameTime > time + 1e-6 || frameTime < best) continue
    best = frameTime
    name = track.displayAttachment[i] ?? ''
  }
  return name
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

  // 骨骼：一行分组标题 + 每个有帧的通道各一行子轨道（位置 / 旋转 / 缩放 / 斜切）
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
      SLOT_CHANNELS.map(({ channel, label, always }) => {
        if (channel === 'display') return { channel, label, keys: displayKeys, always }
        const keys: TimelineKey[] = []
        pushKeys(keys, track.slot, '', 'slot', channel, track[channel])
        return { channel, label, keys, always }
      })
    )
  }

  // 插槽层级（绘制顺序）：每帧是一份完整顺序快照，在 slot 层级面板改完顺序后打帧产生。
  // 它不属于任何单个插槽，所以是一条独立顶层轨道，删除 / 移动帧都走通用编辑链路。
  if (animation.drawOrder.length > 0) {
    const keys: TimelineKey[] = animation.drawOrder.map((frame) => ({
      id: `drawOrder@${frame.time}`,
      trackId: 'drawOrder',
      kind: 'drawOrder' as const,
      channel: 'order',
      target: '',
      attachment: '',
      time: frame.time,
      easing: Easing.Stepped,
      curve: null
    }))
    tracks.push({
      id: 'drawOrder',
      group: GROUP_LABEL.drawOrder,
      label: GROUP_LABEL.drawOrder,
      kind: 'drawOrder',
      target: '',
      attachment: '',
      keys,
      depth: 0
    })
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

/** 最晚关键帧时间：实现下沉到 core（导出 / 播放也要用），这里透出给编辑器 UI */
export { lastKeyTime } from '@core/model/authoring'

/**
 * 动画时长跟随最晚的关键帧**只增不减**（时长是「可编辑范围」，供往后继续加帧）。
 *
 * 关键帧被拖到原时长之外时自动延长；用户手动设大的时长会保留。
 * 「播放到哪算完」不在这里决定 —— 那是播放时按最后一个关键帧算的（见 AnimationPlayer）。
 */
export function syncDuration(animation: AuthoringAnimData): number {
  const max = Math.max(animation.duration, lastKeyTime(animation))
  animation.duration = max
  return max
}

/**
 * 打开工程 / 导入后的兜底修复：时长若小于最后一个关键帧（末尾帧会被裁掉、播放只在
 * 极短区间循环），补齐到最后关键帧。**不收缩**（时长是留给用户继续加帧的编辑范围）。
 * 返回修好的动画数量（供上层标脏用）。
 */
export function repairAnimationDurations(doc: EditorDocument): number {
  let repaired = 0
  for (const animation of doc.animations) {
    const min = lastKeyTime(animation)
    if (animation.duration < min) {
      animation.duration = min
      repaired++
    }
  }
  return repaired
}

/**
 * 打开工程 / 导入后的兜底：displayIndex 帧与 displayAttachment（附件名）必须一一对应，
 * 两者长度不一致时补齐 / 截断，避免运行期取到 undefined 后显示异常。
 *
 * 注意：只能修「长度不匹配」；「长度一致但内容错位」的历史数据无法从数据本身判断，
 * 写入端（打帧 / 拖动 / 删除）已经做了成对维护，新数据不会再出现。
 */
export function repairDisplayNames(doc: EditorDocument): number {
  let repaired = 0
  for (const animation of doc.animations) {
    for (const track of animation.slots) {
      if (track.displayAttachment.length === track.displayIndex.length) continue
      track.displayAttachment = track.displayIndex.map((_, index) => track.displayAttachment[index] ?? '')
      repaired++
    }
  }
  return repaired
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

/**
 * display 通道的帧与「附件名」是**两个并行数组**（displayIndex / displayAttachment），
 * 运行期按帧对应的名字解析显示项。所以排序时必须把「帧 + 名字」成对搬运 ——
 * 只排帧数组会让名字错位：播放时该插槽显示成别的附件，或索引越界干脆不画
 * （表现为「有的图丢失看不见」）。
 */
function sortDisplayTrack(track: AuthoringSlotAnim): void {
  const pairs = track.displayIndex.map((frame, index) => ({
    frame,
    name: track.displayAttachment[index] ?? ''
  }))
  pairs.sort((left, right) => left.frame.time - right.frame.time)
  track.displayIndex = pairs.map((pair) => pair.frame)
  track.displayAttachment = pairs.map((pair) => pair.name)
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
    sortDisplayTrack(track)
    sortFrames(track.visible)
  }
  for (const track of animation.deforms) sortFrames(track.frames)
  for (const track of animation.constraints) {
    for (const list of Object.values(constraintFrames(track))) sortFrames(list)
  }
  sortFrames(animation.events)
  sortFrames(animation.drawOrder)
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
 * 运行时姿态由 `pose` 提供（`skeleton.localRot` 等），因此打关键帧的结果是所见即所得。
 */
export interface PoseSnapshot {
  localRot: Float32Array
  localPos: Float32Array
  localScale: Float32Array
  localShear: Float32Array
  /** 运行期插槽颜色（RGBA 对象数组） */
  slotColors: Array<{ r: number; g: number; b: number; a: number }>
  /** 运行期插槽当前显示的附件下标 */
  slotDisplayIndex: Int32Array
  /**
   * 运行期插槽当前显示的附件名（与 slotDisplayIndex 一一对应）。
   * 显示帧必须把名字一起写进去：运行期是「名字优先、下标兜底」，
   * 只写下标的话，换皮肤 / 附件增删后下标就可能指到别的附件 —— 表现为「有的图丢失看不见」。
   */
  slotDisplayNames?: string[]
  /** 运行期插槽可见性（1 / 0） */
  slotVisible: Uint8Array
  deformOffsets: Array<number[] | null>
  boneIndex: Record<string, number>
  slotIndex: Record<string, number>
}

/**
 * 打关键帧的目标。`channel` 缺省时打该对象的全部通道（按对象打帧）；
 * 指定时只打这一条通道 —— 时间轴上选中某条子轨道（如插槽的「显示」）后按 K 就用它。
 */
export interface KeyframeTarget {
  kind: KeyKind
  target: string
  attachment: string
  channel?: string
}

export function keyframeTargets(
  doc: EditorDocument,
  animationName: string | null,
  pose: PoseSnapshot,
  targets: readonly KeyframeTarget[],
  time: number
): number {
  const animation = doc.animations.find((item) => item.name === animationName)
  if (!animation) return 0
  let count = 0
  for (const target of targets) {
    if (target.kind === 'bone') {
      const index = pose.boneIndex[target.target]
      if (index === undefined) continue
      const channels = target.channel
        ? [target.channel]
        : ['rotate', 'translate', 'scale', 'shear']
      for (const channel of channels) {
        if (channel === 'rotate') keyBoneChannel(animation, target.target, 'rotate', time, pose.localRot[index])
        else if (channel === 'translate')
          keyBoneChannel(animation, target.target, 'translate', time, {
            x: pose.localPos[index * 2],
            y: pose.localPos[index * 2 + 1]
          })
        else if (channel === 'scale')
          keyBoneChannel(animation, target.target, 'scale', time, {
            x: pose.localScale[index * 2],
            y: pose.localScale[index * 2 + 1]
          })
        else if (channel === 'shear')
          keyBoneChannel(animation, target.target, 'shear', time, {
            x: pose.localShear[index * 2],
            y: pose.localShear[index * 2 + 1]
          })
      }
      count++
      continue
    }
    if (target.kind === 'slot') {
      const index = pose.slotIndex[target.target]
      if (index === undefined) continue
      // 指定通道时只打那一条（时间轴上选中的子轨道）；缺省仍是颜色，保持旧行为
      const channel = target.channel ?? 'color'
      if (channel === 'color') {
        const color = pose.slotColors[index]
        keySlotColor(animation, target.target, time, { r: color.r, g: color.g, b: color.b, a: color.a })
      } else if (channel === 'display') {
        // 名字与下标一起写：运行期「名字优先、下标兜底」，名字在手才不怕换皮肤 / 附件增删
        keySlotDisplay(
          animation,
          target.target,
          time,
          pose.slotDisplayIndex[index],
          pose.slotDisplayNames?.[index] ?? ''
        )
      } else if (channel === 'visible') {
        keySlotVisible(animation, target.target, time, pose.slotVisible[index] !== 0)
      } else {
        continue
      }
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
  channels: Array<{ channel: string; label: string; keys: TimelineKey[]; always?: boolean }>
): void {
  const children: TimelineTrack[] = []
  let total = 0
  for (const item of channels) {
    if (item.keys.length === 0 && !item.always) continue
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
  // 绘制顺序帧只有 time 与完整顺序快照（没有 easing / curve），单独走一支
  if (selector.kind === 'drawOrder') return animation.drawOrder
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
    // display 通道：帧和附件名是并行数组，删/移动帧后要按**帧对象身份**恢复配对
    // （否则名字会错位，播放时显示出错误的 attachment 或直接不画）
    const displayTrack =
      list[0].kind === 'slot' && list[0].channel === 'display'
        ? animation.slots.find((item) => item.slot === list[0].target)
        : undefined
    const namesByFrame = displayTrack
      ? new Map(displayTrack.displayIndex.map((frame, index) => [frame, displayTrack.displayAttachment[index] ?? '']))
      : null
    mutate(subset, frames)
    count += subset.length
    if (displayTrack && namesByFrame) {
      displayTrack.displayAttachment = displayTrack.displayIndex.map(
        (frame) => namesByFrame.get(frame) ?? ''
      )
    }
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
    // 只有「显示」通道走这里；未知 channel 不再兜底到它 ——
    // 否则形状像 `order` 这类选择器会误删显示帧
    if (selector.channel === 'display') return track.displayIndex
    return null
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
