import { create } from 'zustand'

export type SelectionKind = 'none' | 'bone' | 'slot' | 'attachment' | 'constraint'

export interface Selection {
  kind: SelectionKind
  /** 骨骼名 */
  bone: string
  /** 插槽名 */
  slot: string
  /** 皮肤名 */
  skin: string
  /** 附件名 */
  attachment: string
  /** 约束名 */
  constraint: string
  /** 选中的网格顶点（共享顶点缓冲下标） */
  vertices: number[]
}

interface SelectionState extends Selection {
  select: (partial: Partial<Selection>) => void
  selectBone: (name: string) => void
  selectSlot: (name: string) => void
  selectAttachment: (slot: string, attachment: string) => void
  selectConstraint: (name: string) => void
  selectVertices: (vertices: number[]) => void
  clear: () => void
}

const EMPTY: Selection = {
  kind: 'none',
  bone: '',
  slot: '',
  skin: '',
  attachment: '',
  constraint: '',
  vertices: []
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ...EMPTY,

  select: (partial) =>
    set((state) => {
      const next = { ...state, ...partial }
      // 切换主选中对象时清掉顶点选择，避免跨对象残留
      if (partial.kind && partial.kind !== state.kind) next.vertices = []
      return next
    }),

  selectBone: (name) =>
    set((state) => ({
      ...state,
      kind: 'bone',
      bone: name,
      vertices: state.bone === name ? state.vertices : []
    })),

  selectSlot: (name) => set((state) => ({ ...state, kind: 'slot', slot: name, vertices: [] })),

  selectAttachment: (slot, attachment) =>
    set((state) => ({ ...state, kind: 'attachment', slot, attachment, vertices: [] })),

  selectConstraint: (name) => set((state) => ({ ...state, kind: 'constraint', constraint: name, vertices: [] })),

  selectVertices: (vertices) => set((state) => ({ ...state, vertices })),

  clear: () => {
    const skin = get().skin
    set({ ...EMPTY, skin })
  }
}))

export function currentSelection(): Selection {
  return useSelectionStore.getState()
}
