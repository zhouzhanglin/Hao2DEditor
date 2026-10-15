import { create } from 'zustand'

/**
 * 拖动预览通道（**不进文档、不进历史、不通知面板**）。
 *
 * 连续编辑（拖拾色器 / 拖滑杆）如果每帧都写主 store，代价是深拷贝整份文档 + 换掉文档对象
 * ⇒ 视口按 `needsRebuild` 重建整个运行期 + 所有订阅 `document` 的面板（时间轴 / 层级树 /
 * 检查器…）整棵重渲染。一次拖动能连发上百个事件，就是上百遍这套重活 ——
 * 表现正是「越拖越卡、颜色半天不跟手」。
 *
 * 所以拖动期间只把**画面用的临时值**写这里：只有视口订阅它（见 `ViewportCanvas` 的预览
 * effect），按帧把颜色热写进运行期；文档、历史、面板一动不动。松手时调用方把最终值
 * 提交进主 store（一条撤销记录），再 `clearSlotColors()`。
 *
 * 与播放头那条高频通道（`usePlayheadStore`）是同一个套路：**高频的东西别写主 store**。
 */
export interface PreviewState {
  /** 拖动中的插槽颜色：插槽名 → `#RRGGBBAA` */
  slotColors: Record<string, string>
  setSlotColor: (slot: string, hex: string) => void
  clearSlotColors: () => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  slotColors: {},
  setSlotColor: (slot, hex) =>
    set((state) =>
      // 值没变就不换对象：zustand 用 Object.is 判等，免得白通知视口
      state.slotColors[slot] === hex ? state : { slotColors: { ...state.slotColors, [slot]: hex } }
    ),
  clearSlotColors: () => set((state) => (Object.keys(state.slotColors).length === 0 ? state : { slotColors: {} }))
}))
