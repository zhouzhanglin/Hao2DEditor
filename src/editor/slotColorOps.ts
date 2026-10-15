import { useProjectStore } from './store/projectStore'
import { useTimelineStore } from './store/timelineStore'
import { useModeStore } from './store/modeStore'
import { keySlotColor } from './commands/animationCommands'
import { sameSelector, syncDuration } from './timeline/model'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import { sampleColor } from '@core/anim/interpolation'
import type { EditorDocument } from '@core/model/authoring'
import type { KeySelector } from './timeline/model'

/**
 * 插槽**颜色（含透明度）**的共享操作：视口右键的「修改颜色」与它弹出来的拾色器走同一条路。
 *
 * - Pose：改 setup 的颜色（`slot.color`，`#RRGGBBAA`）
 * - Animate：在当前时间打**颜色关键帧**（alpha 就在颜色里，透明度一起进帧）
 *
 * 打的是**插槽**颜色帧而不是附件颜色：颜色轨本来就是插槽级的（时间轴 / 层级树里的
 * 「颜色关键帧」是同一份数据），附件自身的颜色不参与动画 —— 运行期的画面颜色是
 * 「插槽色 × 附件色 × 染色」（见 meshBuilder），所以这里只动插槽色，与检查器一致。
 */

/** 一次颜色编辑的目标上下文（打开拾色器时算一次，之后固定） */
export interface SlotColorTarget {
  /** true = 写颜色关键帧；false = 改 setup 颜色 */
  animate: boolean
  animation: string | null
  /** 打帧时间（秒） */
  time: number
  /** 撤销记录标签 */
  label: string
}

/**
 * 目标上下文：与 `slotOrderOps` 的 mode / animate 判定同口径 ——
 * Animate 态**且已选中动画**才算打帧态，否则退回 setup 颜色（没有动画时无处打帧）。
 */
export function slotColorTarget(): SlotColorTarget {
  const { mode } = useModeStore.getState()
  const { currentAnimation, time } = useTimelineStore.getState()
  const animate = mode === 'animate' && currentAnimation !== null
  return {
    animate,
    animation: currentAnimation,
    time,
    label: animate ? '插槽颜色关键帧' : '修改插槽颜色'
  }
}

/**
 * 插槽当前「看到」的颜色（`#RRGGBBAA`）—— 拾色器的初始值。
 *
 * Animate 且该插槽已有颜色轨 → 按当前时间采样（与运行期同一规则：有轨用轨、没轨用 setup）；
 * 其它情况 setup 颜色就是权威值。不能一律读 `slot.color`：打了颜色帧之后 setup 就没再变过，
 * 用 setup 回显会让拾色器打开时显示成上一次的颜色。
 */
export function slotColorHexAt(doc: EditorDocument, target: SlotColorTarget, slotName: string): string {
  const slot = doc.slots.find((item) => item.name === slotName)
  if (!slot) return '#FFFFFFFF'
  if (target.animate) {
    const track = doc.animations
      .find((item) => item.name === target.animation)
      ?.slots.find((item) => item.slot === slotName)
    const sampled = hexToRgba(slot.color)
    if (track && track.color.length > 0 && sampleColor(track.color, target.time, sampled)) {
      return rgbaToHex(sampled)
    }
  }
  return rgbaToHex(hexToRgba(slot.color))
}

/** 颜色写入的状态栏文案（拖动收尾时用，免得只在「提交那一刻」才说一句） */
export function slotColorMessage(slotName: string, target: SlotColorTarget): string {
  return target.animate
    ? `已在 ${target.time.toFixed(3)}s 打关键帧：插槽「${slotName}」颜色 / 透明度`
    : `已修改插槽「${slotName}」的 setup 颜色`
}

/**
 * 写入颜色（含透明度）：Animate 打当前时间的颜色帧，Pose 改 setup 颜色。
 *
 * 拖动拾色器 / 滑杆时由调用方先 `beginTransaction(label)` 再反复调它：事务期间的每次写入会合并成
 * **一条**撤销记录（见 History.push），画面则是逐帧实时预览。
 * 返回状态栏文案；写不成（插槽 / 动画已不在）时返回原因。
 */
export function writeSlotColor(
  slotName: string,
  hex: string,
  target: SlotColorTarget,
  /**
   * 拖动中的高频写入：走 `updateSilent`（不记账，整段由调用方的事务收成一条）。
   * 与 `SliderField` 的 `silent` 是同一个约定 —— 直接一路 `update` 的话，撤销要按几十下才退回去。
   */
  silent = false
): string {
  const store = useProjectStore.getState()
  const { document } = store
  if (!document.slots.some((slot) => slot.name === slotName)) return `插槽「${slotName}」已不存在`
  if (target.animate && !document.animations.some((item) => item.name === target.animation)) {
    return `找不到动画「${target.animation ?? ''}」：先在时间轴选一个动画`
  }
  const color = hexToRgba(hex)
  const value = rgbaToHex(color)
  const apply = (draft: EditorDocument): void => {
    if (target.animate) {
      const animation = draft.animations.find((item) => item.name === target.animation)
      if (!animation) return
      keySlotColor(animation, slotName, target.time, color)
      // 帧落在时长之外时同步延长（与时间轴打帧同一套兜底，否则末尾帧会被裁掉）
      syncDuration(animation)
      return
    }
    const slot = draft.slots.find((item) => item.name === slotName)
    if (slot) slot.color = value
  }
  if (silent) store.updateSilent(apply)
  else store.update(target.label, apply)
  return slotColorMessage(slotName, target)
}

/**
 * 打帧后把时间轴滚到那条颜色轨并高亮、选中刚打的帧 —— 与层级树 / K 键的打帧入口一致。
 * 只在**收尾**（拖完 / 输入框提交）调一次：拖动中每帧都调的话时间轴会跟着抖。
 *
 * 这一帧**本来就是唯一的选中项**时直接返回：反复拖同一个拾色器时，每次都重新选一遍
 * 会把时间轴滚过去 + 闪一下（见 DopeSheet 的 reveal / 打帧高亮），而用户并没有换选中目标。
 */
export function highlightSlotColorKey(slotName: string, time: number): void {
  const timeline = useTimelineStore.getState()
  const selector: KeySelector = { kind: 'slot', target: slotName, attachment: '', channel: 'color', time }
  if (timeline.selectedKeys.length === 1 && sameSelector(timeline.selectedKeys[0], selector)) return
  timeline.notifyKeyed(`slot:${slotName}:color`, time)
  timeline.setSelectedKeys([selector])
}
