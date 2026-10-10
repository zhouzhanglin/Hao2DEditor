import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useTimelineStore } from '../store/timelineStore'
import type { Selection } from '../store/selectionStore'
import type { RuntimeBundle } from '../runtime'
import { buildTimeline, deleteKeys, keyframeTargets, syncDuration } from './model'
import { keySlotDisplay } from '../commands/animationCommands'
import type { KeyframeTarget, KeyKind, KeySelector, PoseSnapshot } from './model'
import type { AuthoringAnimData } from '@core/model/authoring'
import type { EventKeyframe } from '@core/model/animation'

export interface ActionResult {
  ok: boolean
  message: string
}

/** 把当前选中对象映射为可打关键帧的目标 */
export function selectionTargets(selection: Selection): Array<{ kind: KeyKind; target: string; attachment: string }> {
  // 多选：整批骨骼都算目标（按 K 一次给所有选中骨骼打帧）
  if (selection.kind === 'bone' && selection.bones.length > 0) {
    return selection.bones.map((name) => ({ kind: 'bone' as KeyKind, target: name, attachment: '' }))
  }
  if (selection.kind === 'slot' && selection.slot) {
    return [{ kind: 'slot', target: selection.slot, attachment: '' }]
  }
  if (selection.kind === 'attachment' && selection.slot && selection.attachment) {
    return [{ kind: 'deform', target: selection.slot, attachment: selection.attachment }]
  }
  // 约束：IK 的混合（mix）等参数是可做动画的，选中约束按 K 就给它的全部通道打帧
  if (selection.kind === 'constraint' && selection.constraint) {
    return [{ kind: 'constraint', target: selection.constraint, attachment: '' }]
  }
  return []
}

/**
 * 打帧要写进哪个动画：优先当前选中的动画；**没选但工程里有动画时自动选第一个** ——
 * 右键菜单打帧不该因为「还没在时间轴上点过动画」就静默失败（只闪一行状态栏，很难发现）。
 * 一个动画都没有时返回空串，由调用方给出明确提示。
 */
function resolveAnimationName(): string {
  const current = useTimelineStore.getState().currentAnimation
  if (current) return current
  const first = useProjectStore.getState().document.animations[0]
  if (!first) return ''
  // 只设置当前动画，不动播放头时间（用户可能正停在某个时刻上打帧）
  useTimelineStore.setState({ currentAnimation: first.name })
  return first.name
}

/** 没有可用动画时的统一提示 */
const NO_ANIMATION_MESSAGE = '工程里还没有动画：先在时间轴点「+ 动画」建一个，再打关键帧'

/**
 * 打帧目标 → 时间轴子轨道 id（与 `buildTimeline` 的 id 规则一致）：
 * 有通道的用 `kind:target:channel`，约束这类整条轨道用 `kind:target`。
 * DopeSheet 靠它把打帧的轨道滚动到可见并高亮。
 */
function trackIdOf(target: KeyframeTarget): string {
  if (target.kind === 'constraint') return `constraint:${target.target}`
  if (target.kind === 'deform') return `deform:${target.target}:${target.attachment}`
  return target.channel ? `${target.kind}:${target.target}:${target.channel}` : `${target.kind}:${target.target}`
}

/** 运行时姿态 → 打关键帧的快照（层级树 / slot 层级的右键菜单也走这里） */
function snapshotPose(bundle: RuntimeBundle): PoseSnapshot {
  return {
    localRot: bundle.skeleton.localRot,
    localPos: bundle.skeleton.localPos,
    localScale: bundle.skeleton.localScale,
    localShear: bundle.skeleton.localShear,
    slotColors: bundle.skeleton.slotColors,
    slotDisplayIndex: bundle.skeleton.slotDisplayIndex,
    // 显示帧要把附件名一起写进去（运行期名字优先）：从当前皮肤反查每个插槽正在显示谁
    slotDisplayNames: bundle.asset.slots.map((_, slotIndex) => {
      const skin = bundle.maps.skinOfSlot[slotIndex]
      const attachments = skin >= 0 ? bundle.maps.skinArr[skin].attachments : []
      return attachments[bundle.skeleton.slotDisplayIndex[slotIndex]]?.name ?? ''
    }),
    slotVisible: bundle.skeleton.slotVisible,
    deformOffsets: bundle.skeleton.deformOffsets,
    boneIndex: bundle.boneIndex,
    slotIndex: bundle.slotIndex,
    // 约束打帧读的是**画面上正在生效**的值（动画轨道驱动过的 mix 也在里面），
    // 所以取运行期状态而不是工程文件里的静态参数
    constraintStates: bundle.asset.constraints.map((_, index) => bundle.player.constraintStateAt(index) ?? undefined),
    constraintIndex: bundle.constraintIndex
  }
}

/**
 * 给**指定目标**打关键帧（层级树 / slot 层级的右键菜单用）。
 * `label` 只用于状态提示，如「骨骼「root」的位置」。
 */
export function keyframeTargetsNow(targets: readonly KeyframeTarget[], label = ''): ActionResult {
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: '视口尚未就绪' }
  const bundle = scene.runtime
  if (!bundle) return { ok: false, message: '没有可打关键帧的骨架' }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: NO_ANIMATION_MESSAGE }
  const timeline = useTimelineStore.getState()
  const animationName = animScope
  if (targets.length === 0) return { ok: false, message: '没有可打关键帧的目标' }

  let count = 0
  useProjectStore.getState().update('打关键帧', (draft) => {
    count = keyframeTargets(draft, animationName, snapshotPose(bundle), targets, timeline.time)
  })
  if (count > 0) {
    // 让时间轴滚动到该轨道并高亮：不然打的帧在轨道列表下方看不见，像「没反应」
    useTimelineStore.getState().notifyKeyed(trackIdOf(targets[0]), timeline.time)
    // 顺手把刚打的关键帧选中：时间轴上会高亮，底部关键帧属性面板也会显示它
    const first = targets[0]
    if (first.channel) {
      useTimelineStore.getState().setSelectedKeys([
        {
          kind: first.kind,
          target: first.target,
          attachment: first.attachment,
          channel: first.channel,
          time: timeline.time
        }
      ])
    }
  }
  return count > 0
    ? {
        ok: true,
        message: `已在 ${timeline.time.toFixed(2)}s 为${label ? `「${label}」` : '选中对象'}打关键帧`
      }
    : { ok: false, message: '当前对象没有可打关键帧的数据（FFD 需要先编辑过顶点）' }
}

/**
 * 在当前时间点打一帧**显示**关键帧：把插槽切到指定附件，**传空名表示不显示任何附件**。
 *
 * 名字与下标一起写入（运行期名字优先，换皮肤后仍能解析）；不显示时下标写 -1，
 * 这是「setup 时不显示任何附件」的合法值（见 asset.ts 的 setupDisplayIndex）。
 */
export function keySlotDisplayNow(slotName: string, attachmentName: string): ActionResult {
  const scene = getActiveScene()
  const bundle = scene?.runtime
  if (!bundle) return { ok: false, message: '没有可打关键帧的骨架' }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: NO_ANIMATION_MESSAGE }
  const timeline = useTimelineStore.getState()
  const animationName = animScope
  const slotIndex = bundle.slotIndex[slotName]
  if (slotIndex === undefined) return { ok: false, message: `找不到插槽「${slotName}」` }
  const skin = bundle.maps.skinOfSlot[slotIndex]
  const attachments = skin >= 0 ? bundle.maps.skinArr[skin].attachments : []
  // 空名 = 这一个关键帧起不再显示任何 display（下标 -1），不需要校验附件是否存在
  const index = attachmentName
    ? attachments.findIndex((attachment) => attachment.name === attachmentName)
    : -1
  if (attachmentName && index < 0) return { ok: false, message: `当前皮肤里没有「${attachmentName}」` }

  const at = timeline.time
  useProjectStore.getState().update('打显示关键帧', (draft) => {
    const animation = draft.animations.find((item) => item.name === animationName)
    if (animation) keySlotDisplay(animation, slotName, at, index, attachmentName)
  })
  // 同打帧：把时间轴的这一行滚到可见并高亮，并选中刚打的显示帧
  useTimelineStore.getState().notifyKeyed(`slot:${slotName}:display`, at)
  useTimelineStore.getState().setSelectedKeys([
    { kind: 'slot', target: slotName, attachment: '', channel: 'display', time: at }
  ])
  return {
    ok: true,
    message: attachmentName
      ? `已在 ${at.toFixed(2)}s 打「${slotName}」的显示帧 → 「${attachmentName}」`
      : `已在 ${at.toFixed(2)}s 打「${slotName}」的显示帧 → 不显示`
  }
}

/** 事件名默认取 `event`、`event2`…（避开已用过的名字） */
function nextEventName(events: readonly EventKeyframe[]): string {
  const used = new Set(events.map((event) => event.name))
  if (!used.has('event')) return 'event'
  for (let i = 2; i < 10000; i++) {
    const candidate = `event${i}`
    if (!used.has(candidate)) return candidate
  }
  return `event${events.length + 1}`
}

/**
 * 在当前播放头位置插入一个**事件帧**（时间轴最上面那条事件轨）。
 *
 * 事件帧只有「时间 + 事件名 + 字符串 / 整数 / 浮点参数」（见 `EventKeyframe`）：
 * 运行期由 `AnimationPlayer.fireEvents` 在越过该时刻时触发（含循环回绕），
 * 导出到 spine / DragonBones 也带着它 —— 之前缺的就是这里的创建入口。
 *
 * 名字按 `event` / `event2`… 递增，插入后**立刻选中它**：视口下方的值栏会直接给出
 * 改名与三个参数的输入框，不用再去轨道里把它找出来。
 */
export function keyEventNow(): ActionResult {
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: NO_ANIMATION_MESSAGE }
  // 与 dope sheet 新建关键帧同一取整口径（4 位小数），保证键 id / 选中判定稳定
  const at = Math.round(useTimelineStore.getState().time * 1e4) / 1e4
  let name = ''
  useProjectStore.getState().update('添加事件帧', (draft) => {
    const animation = draft.animations.find((item) => item.name === animScope)
    if (!animation) return
    name = nextEventName(animation.events)
    animation.events.push({ time: at, name, stringParam: '', intParam: 0, floatParam: 0 })
    animation.events.sort((a, b) => a.time - b.time)
    // 时长是「可编辑范围」：事件落在末尾之外时同步延长（只增不减）
    syncDuration(animation)
  })
  if (!name) return { ok: false, message: `找不到动画「${animScope}」` }

  const timeline = useTimelineStore.getState()
  // 事件轨固定在最上面，这里主要借高亮闪一下，确认「帧确实加上了」
  timeline.notifyKeyed('event', at)
  timeline.setSelectedKeys([{ kind: 'event', target: name, attachment: '', channel: name, time: at }])
  return { ok: true, message: `已在 ${at.toFixed(2)}s 添加事件帧「${name}」（在视口下方值栏改名 / 设参数）` }
}

/**
 * 在当前时间点为选中对象打关键帧（捕获运行时姿态）。
 * 需要 Animate 状态 + 已选动画 + 有效的运行时 bundle。
 */
export function keyframeNow(): ActionResult {
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: '视口尚未就绪' }
  const bundle = scene.runtime
  if (!bundle) return { ok: false, message: '没有可打关键帧的骨架' }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: NO_ANIMATION_MESSAGE }
  const timeline = useTimelineStore.getState()
  const animationName = animScope

  // 时间轴上点了某条子轨道（如插槽的「显示」）就只打那一条；否则按选中对象的全部通道打
  const focusedTrack = timeline.selectedTrack
  const targets: KeyframeTarget[] = focusedTrack
    ? [
        {
          kind: focusedTrack.kind as KeyKind,
          target: focusedTrack.target,
          attachment: focusedTrack.attachment,
          channel: focusedTrack.channel
        }
      ]
    : selectionTargets(useSelectionStore.getState())
  if (targets.length === 0) return { ok: false, message: '请先选中骨骼、插槽、网格附件或约束' }
  const trackLabel = focusedTrack ? `「${focusedTrack.target} · ${focusedTrack.channel}」` : ''

  let count = 0
  useProjectStore.getState().update('打关键帧', (draft) => {
    count = keyframeTargets(draft, animationName, snapshotPose(bundle), targets, timeline.time)
  })
  if (count > 0) {
    // 与右键菜单一致：滚到该轨道并高亮（K 键打帧同样不该「悄无声息」）
    useTimelineStore.getState().notifyKeyed(trackIdOf(targets[0]), timeline.time)
  }

  return count > 0
    ? {
        ok: true,
        message: focusedTrack
          ? `已在 ${timeline.time.toFixed(2)}s 为${trackLabel}打关键帧`
          : `已在 ${timeline.time.toFixed(2)}s 打了 ${count} 处关键帧`
      }
    : { ok: false, message: '当前对象没有可打关键帧的数据（FFD 需要先编辑过顶点）' }
}

/** 删除 dope sheet 里选中的关键帧 */
export function removeSelectedKeys(): ActionResult {
  const timeline = useTimelineStore.getState()
  if (timeline.selectedKeys.length === 0) return { ok: false, message: '先在 dope sheet 里选中关键帧' }
  let removed = 0
  useProjectStore.getState().update('删除关键帧', (draft) => {
    removed = deleteKeys(draft, timeline.currentAnimation, timeline.selectedKeys)
  })
  timeline.setSelectedKeys([])
  return { ok: true, message: `已删除 ${removed} 个关键帧` }
}

/** 收集某条通道（轨道）当前的全部关键帧选择器：按 kind / target / attachment / channel 精确定位 */
function selectorsOfFocus(animation: AuthoringAnimData | null, focus: KeySelector): KeySelector[] {
  if (!animation) return []
  return buildTimeline(animation)
    .flatMap((track) => track.keys)
    .filter(
      (key) =>
        key.kind === focus.kind &&
        key.target === focus.target &&
        key.attachment === focus.attachment &&
        (!focus.channel || key.channel === focus.channel)
    )
    .map((key) => ({
      kind: key.kind,
      target: key.target,
      attachment: key.attachment,
      channel: key.channel,
      time: key.time
    }))
}

/**
 * 删除**当前选中的整条通道**（轨道）：把它名下的关键帧一次性删掉。
 *
 * 走的是与「删除选中关键帧」同一条数据链路，因此事件、插槽层级（绘制顺序）
 * 这类特殊轨也一样支持；删空后由数据层清理空轨道并同步动画时长。
 */
export function deleteSelectedTrack(): ActionResult {
  const timeline = useTimelineStore.getState()
  const focus = timeline.selectedTrack
  if (!focus) return { ok: false, message: '先在时间轴上点选一条通道，再按 Delete 删除它' }

  const animation =
    useProjectStore.getState().document.animations.find((item) => item.name === timeline.currentAnimation) ?? null
  const selectors = selectorsOfFocus(animation, focus as KeySelector)
  if (selectors.length === 0) return { ok: false, message: `通道「${trackLabelOf(focus)}」还没有关键帧` }

  let removed = 0
  useProjectStore.getState().update('删除动画通道', (draft) => {
    removed = deleteKeys(draft, timeline.currentAnimation, selectors)
  })
  timeline.setSelectedKeys([])
  return removed > 0
    ? { ok: true, message: `已删除通道「${trackLabelOf(focus)}」（${removed} 个关键帧）` }
    : { ok: false, message: `通道「${trackLabelOf(focus)}」没有可删除的关键帧` }
}

/** 通道名的中文label（提示文案用） */
function trackLabelOf(focus: { kind: string; target: string; channel: string }): string {
  const channel = CHANNEL_LABEL[focus.channel] ?? focus.channel
  if (focus.kind === 'drawOrder') return '插槽层级'
  if (focus.kind === 'event') return `事件 ${focus.target}`
  if (focus.kind === 'bone') return `${focus.target} · ${channel}`
  if (focus.kind === 'slot') return `${focus.target} · ${channel}`
  if (focus.kind === 'deform') return `${focus.target} · FFD`
  return focus.target || channel
}

const CHANNEL_LABEL: Record<string, string> = {
  translate: '位置',
  rotate: '旋转',
  scale: '缩放',
  shear: '斜切',
  display: '显示',
  color: '颜色',
  visible: '可见性',
  order: '绘制顺序',
  offsets: 'FFD'
}
