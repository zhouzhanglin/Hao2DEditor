import { useProjectStore } from './store/projectStore'
import { t } from '@i18n'
import { useTimelineStore } from './store/timelineStore'
import { useModeStore } from './store/modeStore'
import { applySlotOrder } from './commands/hierarchyCommands'
import { deleteSlot } from './commands/authoringCommands'
import { drawOrderFrameAt, keyDrawOrder } from './commands/animationCommands'
import type { EditorDocument } from '@core/model/authoring'

/**
 * 插槽**层级（绘制顺序）**的共享操作：视口右键菜单与 slot 层级面板走同一条路。
 *
 * - Pose：改 setup 的 zOrder（`applySlotOrder`，列表是顶层在前）
 * - Animate：在当前时间打**绘制顺序关键帧**（整帧离散值，快照全部插槽顺序）
 *
 * 顺序语义：列表 / 返回值都是「顶层在前」；绘制顺序帧的 order 是「第 0 个最先画」，
 * 两者互为倒序 —— 与 SlotOrderPanel 的既有约定一致。
 */

export type LayerDirection = 'up' | 'down' | 'top' | 'bottom'

/** 当前图层顺序（顶层在前）：Pose 用 setup；Animate 优先用当前时间的帧（缺的名字按 setup 补到底层） */
export function layerOrderTopFirst(
  doc: EditorDocument,
  animate: boolean,
  animationName: string | null,
  time: number
): string[] {
  const setupTopFirst = [...doc.slots].sort((left, right) => right.zOrder - left.zOrder).map((slot) => slot.name)
  const animation = doc.animations.find((item) => item.name === animationName) ?? null
  const frame = animate && animation ? drawOrderFrameAt(animation, time) : null
  if (!frame) return setupTopFirst
  const names = [...frame.order].reverse()
  for (const name of setupTopFirst) if (!names.includes(name)) names.push(name)
  return names.filter((name) => doc.slots.some((slot) => slot.name === name))
}

/**
 * 移动一个插槽的层级（up / down / top / bottom，都按「顶层在前」的列表语义）。
 * 返回状态栏文案；返回空串 = 没有变化（已在顶 / 底，或插槽不存在），调用方不要出提示。
 */
export function moveSlotLayer(slotName: string, direction: LayerDirection): string {
  const { mode } = useModeStore.getState()
  const { document, update } = useProjectStore.getState()
  const { currentAnimation, time } = useTimelineStore.getState()
  const animate = mode === 'animate' && currentAnimation !== null

  const layers = layerOrderTopFirst(document, animate, currentAnimation, time)
  const index = layers.indexOf(slotName)
  if (index < 0) return ''
  const names = [...layers]
  const [moved] = names.splice(index, 1)
  const target =
    direction === 'up'
      ? Math.max(0, index - 1)
      : direction === 'down'
        ? Math.min(names.length, index + 1)
        : direction === 'top'
          ? 0
          : names.length
  names.splice(target, 0, moved)
  // 移完等于没移（本来就在顶 / 底）：不产生撤销记录、不出提示
  if (names.every((name, i) => name === layers[i])) return ''

  if (animate) {
    const order = [...names].reverse() // 顶层在前 → 绘制顺序反过来（第 0 个最先画）
    const at = time
    update('绘制顺序关键帧', (draft) => {
      const track = draft.animations.find((item) => item.name === currentAnimation)
      if (track) keyDrawOrder(track, at, order)
    })
    return t('已在 {0}s 写入「{1}」的层级关键帧', [at.toFixed(2), slotName])
  }
  update('调整插槽层级', (draft) => {
    applySlotOrder(draft, names)
  })
  return t('已移动「{0}」（setup 绘制顺序）', slotName)
}

/** 删除插槽（只有 Pose 态给这个入口）：复用 deleteSlot，会一并清 skins / 动画轨道 / 层级帧里的名字 */
export function deleteSlotNamed(slotName: string): void {
  const { update } = useProjectStore.getState()
  update('删除插槽', (draft) => {
    deleteSlot(draft, slotName)
  })
}
