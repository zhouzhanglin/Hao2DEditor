import { create } from 'zustand'

/** Pose（绑定）态与 Animate（动画编辑）态。时间轴只在 animate 态出现。 */
export type EditorMode = 'pose' | 'animate'

export interface ModeState {
  mode: EditorMode
  /** 切到 animate 时上一次选中的动画名，用于返回时恢复 */
  lastAnimation: string | null
  setMode: (mode: EditorMode) => void
  toggleMode: () => void
  setLastAnimation: (name: string | null) => void
}

export const useModeStore = create<ModeState>((set, get) => ({
  mode: 'pose',
  lastAnimation: null,
  setMode: (mode) => set({ mode }),
  toggleMode: () => set({ mode: get().mode === 'pose' ? 'animate' : 'pose' }),
  setLastAnimation: (name) => set({ lastAnimation: name })
}))

export function isAnimateMode(): boolean {
  return useModeStore.getState().mode === 'animate'
}
