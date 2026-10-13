import { create } from 'zustand'

/**
 * 层级树的 UI 状态：折叠 + display 行显隐（仅影响显示，不动数据）。
 *
 * 折叠状态原本是 HierarchyTree 组件内的局部 useState，但复制 / 直接复制（Ctrl+D）生成新节点时，
 * 需要把源节点的折叠状态照搬到新节点上，而粘贴逻辑在 editor 层（clipboardCommands），
 * 拿不到组件的局部 state。于是把它提升到 store，两边都能读写，且保持与原 useState
 * 完全一致的函数式更新签名（setCollapsed((prev) => next)）。
 *
 * 约定 key：骨骼直接存名字；插槽存 `slot:${name}`（与层级树里的 key 口径一致）。
 */
interface TreeUiState {
  collapsed: Set<string>
  setCollapsed: (updater: (prev: Set<string>) => Set<string>) => void
  /**
   * 树里是否列出 display（附件）行。关掉后只剩骨骼 / 插槽 —— 附件多的时候把树压短些。
   * 纯显示开关：不动数据，也不影响视口 / 导出，只是插槽行下面的子行不渲染。
   */
  showDisplays: boolean
  setShowDisplays: (value: boolean) => void
}

export const useTreeUiStore = create<TreeUiState>((set) => ({
  collapsed: new Set<string>(),
  setCollapsed: (updater) => set((s) => ({ collapsed: updater(s.collapsed) })),
  showDisplays: true,
  setShowDisplays: (value) => set({ showDisplays: value })
}))
