import { create } from 'zustand'

/**
 * 「在层级树里定位到某根骨骼」的请求（检查器里的定位图标 → 层级树）。
 *
 * 只提示位置、**不改选中**：定位按钮的用意是「让我看到它在哪」，抢走选中会把当前正在
 * 编辑的面板（约束 / 附件）切走，反而打断手头的活。
 *
 * 用请求 + 序号而不是直接存「当前高亮」：同一根骨骼连点两次也要能重新滚动 + 闪烁，
 * 序号变了订阅者才知道这是一次新请求。
 */
export interface RevealState {
  /** 最近一次请求定位的骨骼名；空串 = 还没请求过 */
  bone: string
  /** 请求序号（每次请求 +1） */
  nonce: number
  revealBone: (name: string) => void
}

export const useRevealStore = create<RevealState>((set) => ({
  bone: '',
  nonce: 0,
  revealBone: (name) => {
    if (!name) return
    set((state) => ({ bone: name, nonce: state.nonce + 1 }))
  }
}))
