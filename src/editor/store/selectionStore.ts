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
  /**
   * 单选顶点在**附件自己的顶点数组**里的下标（-1 = 没有单选）。
   *
   * 两个下标都要留：`vertices` 是共享顶点缓冲下标（叠加层画选中标记用它），
   * 而属性检查器要显示「这个顶点的权重」时，得用它去查附件的 `vertices[i].weights` ——
   * 两者语义不同，混用会取到别的顶点（甚至别的附件）。
   */
  vertex: number
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
  vertices: [],
  vertex: -1
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ...EMPTY,

  select: (partial) =>
    set((state) => {
      const next = { ...state, ...partial }
      /*
       * 切换主选中对象时清掉顶点选择，避免跨对象残留 —— 但**本次显式给了顶点**就照给的来：
       * 权重工具「点顶点」正是这种调用（kind 从 bone 变成 attachment，同时给出新顶点），
       * 一刀切清掉会让叠加层画不出选中标记。
       */
      if (partial.kind && partial.kind !== state.kind && partial.vertices === undefined) {
        next.vertices = []
        if (partial.vertex === undefined) next.vertex = -1
      }
      return next
    }),

  selectBone: (name) =>
    set((state) => {
      // 同一根骨骼保持原有顶点选择（拖拽中途会重复选中），换对象则连单选顶点一起作废
      const keep = state.bone === name
      return {
        ...state,
        kind: 'bone',
        bone: name,
        vertices: keep ? state.vertices : [],
        vertex: keep ? state.vertex : -1
      }
    }),

  selectSlot: (name) => set((state) => ({ ...state, kind: 'slot', slot: name, vertices: [], vertex: -1 })),

  selectAttachment: (slot, attachment) =>
    set((state) => ({ ...state, kind: 'attachment', slot, attachment, vertices: [], vertex: -1 })),

  selectConstraint: (name) =>
    set((state) => ({ ...state, kind: 'constraint', constraint: name, vertices: [], vertex: -1 })),

  // 框选只拿得到共享缓冲下标，没有「附件内下标」→ 单选标记一律清掉
  selectVertices: (vertices) => set((state) => ({ ...state, vertices, vertex: -1 })),

  clear: () => {
    const skin = get().skin
    set({ ...EMPTY, skin })
  }
}))

export function currentSelection(): Selection {
  return useSelectionStore.getState()
}
