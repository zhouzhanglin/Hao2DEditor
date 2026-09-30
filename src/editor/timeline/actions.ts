import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useTimelineStore } from '../store/timelineStore'
import type { Selection } from '../store/selectionStore'
import { deleteKeys, keyframeTargets } from './model'
import type { KeyframeTarget, KeyKind } from './model'

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
 * 在当前时间点为选中对象打关键帧（捕获运行时姿态）。
 * 需要 Animate 状态 + 已选动画 + 有效的运行时 bundle。
 */
export function keyframeNow(): ActionResult {
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: '视口尚未就绪' }
  const bundle = scene.runtime
  if (!bundle) return { ok: false, message: '没有可打关键帧的骨架' }
  const timeline = useTimelineStore.getState()
  const animationName = timeline.currentAnimation
  if (!animationName) return { ok: false, message: '请先在时间轴选择动画' }

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
    count = keyframeTargets(
      draft,
      animationName,
      {
        localRot: bundle.skeleton.localRot,
        localPos: bundle.skeleton.localPos,
        localScale: bundle.skeleton.localScale,
        localShear: bundle.skeleton.localShear,
        slotColors: bundle.skeleton.slotColors,
        slotDisplayIndex: bundle.skeleton.slotDisplayIndex,
        slotVisible: bundle.skeleton.slotVisible,
        deformOffsets: bundle.skeleton.deformOffsets,
        boneIndex: bundle.boneIndex,
        slotIndex: bundle.slotIndex
      },
      targets,
      timeline.time
    )
  })

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
