import { create } from 'zustand'

/**
 * 层级树的「折叠」状态（仅影响显示，不动数据）。
 *
 * 原本是 HierarchyTree 组件内的局部 useState，但复制 / 直接复制（Ctrl+D）生成新节点时，
 * 需要把源节点的折叠状态照搬到新节点上，而粘贴逻辑在 editor 层（clipboardCommands），
 * 拿不到组件的局部 state。于是把它提升到 store，两边都能读写，且保持与原 useState
 * 完全一致的函数式更新签名（setCollapsed((prev) => next)）。
 *
 * 约定 key：骨骼直接存名字；插槽存 `slot:${name}`（与层级树里的 key 口径一致）。
 */
interface TreeUiState {
  collapsed: Set<string>
  setCollapsed: (updater: (prev: Set<string>) => Set<string>) => void
}

export const useTreeUiStore = create<TreeUiState>((set) => ({
  collapsed: new Set<string>(),
  setCollapsed: (updater) => set((s) => ({ collapsed: updater(s.collapsed) }))
}))
