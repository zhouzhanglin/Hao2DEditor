import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useTimelineStore } from '../store/timelineStore'
import type { Selection } from '../store/selectionStore'
import type { RuntimeBundle } from '../runtime'
import { deleteKeys, keyframeTargets } from './model'
import { keySlotDisplay } from '../commands/animationCommands'
import type { KeyframeTarget, KeyKind, PoseSnapshot } from './model'

export interface ActionResult {
  ok: boolean
  message: string
}

/** 把当前选中对象映射为可打关键帧的目标 */
export function selectionTargets(selection: Selection): Array<{ kind: KeyKind; target: string; attachment: string }> {
  if (selection.kind === 'bone' && selection.bone) {
    return [{ kind: 'bone', target: selection.bone, attachment: '' }]
  }
  if (selection.kind === 'slot' && selection.slot) {
    return [{ kind: 'slot', target: selection.slot, attachment: '' }]
  }
  if (selection.kind === 'attachment' && selection.slot && selection.attachment) {
    return [{ kind: 'deform', target: selection.slot, attachment: selection.attachment }]
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
    slotIndex: bundle.slotIndex
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
 * 在当前时间点打一帧**显示**关键帧，把插槽切到指定附件（层级树里右键某个 display = 从这里开始显示它）。
 * 名字与下标一起写入（运行期名字优先，换皮肤后仍能解析）。
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
  const index = attachments.findIndex((attachment) => attachment.name === attachmentName)
  if (index < 0) return { ok: false, message: `当前皮肤里没有「${attachmentName}」` }

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
  return { ok: true, message: `已在 ${at.toFixed(2)}s 打「${slotName}」的显示帧 → 「${attachmentName}」` }
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
  if (targets.length === 0) return { ok: false, message: '请先选中骨骼、插槽或网格附件' }
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
