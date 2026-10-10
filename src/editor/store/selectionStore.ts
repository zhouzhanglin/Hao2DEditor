import { create } from 'zustand'
import { useTimelineStore } from './timelineStore'

export type SelectionKind = 'none' | 'bone' | 'slot' | 'attachment' | 'constraint'

export interface Selection {
  kind: SelectionKind
  /** 主选中骨骼名（检查器、操作器轴心、父子挂载点这些「单目标」入口读它） */
  bone: string
  /**
   * 选中的骨骼集合（含 `bone`，顺序 = 点选顺序）。
   *
   * 单选时就是 `[bone]`；多选时 `bone` 仍是**主选中**（最后点中的那根）——
   * 旋转 / 移动 / 缩放工具遍历整个集合一起改，其余只看主选中。
   */
  bones: string[]
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
  /** 直接把集合替换成这几根（主选中 = 最后一根）；空数组等于取消选择 */
  selectBones: (names: readonly string[]) => void
  /** 多选点击（Shift / Cmd / Ctrl）：已在集合里就移出，否则追加并成为主选中 */
  toggleBone: (name: string) => void
  selectSlot: (name: string) => void
  selectAttachment: (slot: string, attachment: string) => void
  selectConstraint: (name: string) => void
  selectVertices: (vertices: number[]) => void
  clear: () => void
}

const EMPTY: Selection = {
  kind: 'none',
  bone: '',
  bones: [],
  slot: '',
  skin: '',
  attachment: '',
  constraint: '',
  vertices: [],
  vertex: -1
}

/**
 * 点了骨骼 / 插槽（层级树、视口、插槽层级面板…）就把动画面板里选中的**通道**清掉。
 *
 * 通道属于上一个对象：留着不但 dope sheet 继续高亮那一行，按 K 也不再「打这个对象的全部通道」，
 * 而是只打那条已经跟当前选择无关的子轨道。
 *
 * 动画面板自己点轨道行**不受影响** —— `TimelinePanel.selectTrack` 先选对象、最后才写通道
 *（顺序反了会被这里清掉，那里有对应注释）。没选中通道时直接返回，重复调用（如拖拽中反复选中同一根骨骼）
 * 不会多写一次 store。
 */
function clearTrackFocus(): void {
  const timeline = useTimelineStore.getState()
  if (timeline.selectedTrack) timeline.setSelectedTrack(null)
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ...EMPTY,

  select: (partial) =>
    set((state) => {
      const next = { ...state, ...partial }
      // `bones` 与 `bone` 必须同源：只给了主选中就按单选处理，别让集合里还留着上一个对象
      if (partial.bones === undefined && partial.bone !== undefined) {
        next.bones = partial.bone ? [partial.bone] : []
      }
      // 切到非骨骼对象（插槽 / 附件 / 约束 / 无）时集合一律清空，否则叠加层还画着上一批骨骼
      if (partial.kind !== undefined && partial.kind !== 'bone') next.bones = []
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

  selectBone: (name) => {
    clearTrackFocus()
    set((state) => {
      // 同一根骨骼保持原有顶点选择（拖拽中途会重复选中），换对象则连单选顶点一起作废
      const keep = state.bone === name
      return {
        ...state,
        kind: 'bone',
        bone: name,
        bones: name ? [name] : [],
        vertices: keep ? state.vertices : [],
        vertex: keep ? state.vertex : -1
      }
    })
  },

  selectBones: (names) => {
    clearTrackFocus()
    // 去重（点选顺序即主选中优先级：最后一根是主选中）
    const unique = [...new Set(names.filter((name) => name !== ''))]
    set((state) => ({
      ...state,
      kind: unique.length > 0 ? 'bone' : 'none',
      bone: unique.length > 0 ? unique[unique.length - 1] : '',
      bones: unique,
      vertices: [],
      vertex: -1
    }))
  },

  toggleBone: (name) => {
    clearTrackFocus()
    if (!name) return
    set((state) => {
      const has = state.bones.includes(name)
      const bones = has ? state.bones.filter((item) => item !== name) : [...state.bones, name]
      if (bones.length === 0) {
        return { ...state, kind: 'none', bone: '', bones: [], vertices: [], vertex: -1 }
      }
      return {
        ...state,
        kind: 'bone',
        // 新加进来的那根成为主选中；移出的若是主选中，就退回集合里最后一根
        bone: has && state.bone !== name ? state.bone : bones[bones.length - 1],
        bones,
        vertices: [],
        vertex: -1
      }
    })
  },

  selectSlot: (name) => {
    clearTrackFocus()
    set((state) => ({ ...state, kind: 'slot', slot: name, bones: [], vertices: [], vertex: -1 }))
  },

  selectAttachment: (slot, attachment) =>
    set((state) => ({
      ...state,
      kind: 'attachment',
      slot,
      attachment,
      bones: [],
      vertices: [],
      vertex: -1
    })),

  selectConstraint: (name) =>
    set((state) => ({ ...state, kind: 'constraint', constraint: name, bones: [], vertices: [], vertex: -1 })),

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
