import { create } from 'zustand'
import { useTimelineStore } from './timelineStore'

export type SelectionKind = 'none' | 'bone' | 'slot' | 'attachment' | 'constraint'

/**
 * 全局选中对象的**规范化标签**：任何面板想「当前选中的是什么」，读 `selection.selectedObjects`
 * 就够了，不用各自再把 `kind` + `bone/bones/slot/attachment` 拼一遍。
 *
 * - `display` 就是 `Selection` 里的 **attachment**（附件）：`HierarchyTree` / `focusNode`
 *   一直在手工把 `kind: 'attachment'` 映射成 `{ kind: 'display' }`，这里统一掉。
 * - 三条互斥是**由 `kind` 保证的**（一次只有一个 `kind`），所以数组里不会同时出现骨骼和附件。
 * - 骨骼多选时逐个展开，顺序 = `bones` 的点选顺序。
 * - `constraint` / `none` 不在这个数组里（它既不是可高亮的对象行，也没有 display 语义）；
 *   选中约束时数组为空，别把「空数组」当成「什么都没选」——要看对象选中请读 `kind`。
 */
export type SelectedObject =
  | { kind: 'bone'; name: string }
  | { kind: 'slot'; name: string }
  | { kind: 'display'; slot: string; name: string }

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

export interface SelectionState extends Selection {
  /**
   * 当前选中对象的规范化数组（派生字段，由下面所有写入口统一维护，调用方不要直接写）。
   * 「有哪些东西被选中了」只此一处，其它面板不用再从 `kind` + 各字段拼。
   */
  selectedObjects: SelectedObject[]
  /**
   * 资源面板里选中的图片（多选：拖拽时整组一起走，落到视口 / 层级树里一次建多个插槽 / display）。
   *
   * 放进全局而不是留在面板局部 state：它和对象选中是**同一个「当前选中」概念的两半** ——
   * 原来两处各亮各的，点了骨骼资源面板那几行还亮着（用户报的就是这个）。
   * 现在任何一次**对象选中**的变化都会把它清掉，见 `commit`。
   */
  pickedImages: string[]
  /** 写选中的图片。与内容相同的写不通知（在资源面板里重复点同一行不会白响一次） */
  setPickedImages: (names: readonly string[]) => void
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

/** 由选中状态算出规范化数组：只认 bone / slot / display 三类，其余（约束、无选中）为空 */
function toSelectedObjects(state: Selection): SelectedObject[] {
  if (state.kind === 'bone') return state.bones.map((name) => ({ kind: 'bone', name }))
  if (state.kind === 'slot') return state.slot ? [{ kind: 'slot', name: state.slot }] : []
  if (state.kind === 'attachment') {
    return state.attachment ? [{ kind: 'display', slot: state.slot, name: state.attachment }] : []
  }
  return []
}

/** 逐项比两个数组是否同内容（`bones` / `vertices` 都是短数组，直接比即可） */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * 两次**对象选中**是否相同：只比真实字段，不比 `selectedObjects`（派生字段，这些一样它必然一样），
 * 也不比 `pickedImages`（那是另一半，见 `sameSelection`）。
 */
function sameObjectSelection(a: Selection, b: Selection): boolean {
  return (
    a.kind === b.kind &&
    a.bone === b.bone &&
    a.slot === b.slot &&
    a.skin === b.skin &&
    a.attachment === b.attachment &&
    a.constraint === b.constraint &&
    a.vertex === b.vertex &&
    sameItems(a.bones, b.bones) &&
    sameItems(a.vertices, b.vertices)
  )
}

/** 全量判等：对象选中 + 资源面板里选中的那批图片 */
function sameSelection(a: SelectionState, b: SelectionState): boolean {
  return sameObjectSelection(a, b) && sameItems(a.pickedImages, b.pickedImages)
}

/**
 * 收敛一次写入：算出 `selectedObjects`、按需清掉图片选中，并在**与当前状态完全相同时
 * 原样返回 `state`**。
 *
 * 「有变化才发变化事件」靠最后那一步保证：zustand 的 `set` 在 `Object.is(next, state)` 时
 * 既不合并也不通知订阅者（`vanilla.mjs` 的 `setState` 第一件事就是这个判断），
 * 所以「选中没变就不通知」是 store 一处的行为，调用方不用各自写 guard。
 *
 * 这不是省几行代码的小事 —— 拖拽中会反复 `selectBone` 同一根骨骼、权重工具会反复
 * `selectAttachment` 同一批顶点，原先每次都发通知，`ViewportCanvas` 的
 * `subscribe(push)`（那里不比较内容）就跟着全量重算一遍场景选中态。
 */
function commit(
  state: SelectionState,
  patch: Partial<Selection> & { pickedImages?: string[] }
): SelectionState {
  // 标成 `SelectionState`（而不是 `Selection`）：里面要带上 action 方法，否则返回类型不成立
  const next: SelectionState = { ...state, ...patch }
  /*
   * 对象选中一变，资源面板里选中的那批图片就作废 —— 两处选中不能同时亮着，
   * 「点了骨骼，图片还选着」就是这里补上的。
   * 写图片本身（`patch.pickedImages`）时除外，否则会把这次要写的值清掉。
   */
  if (patch.pickedImages === undefined && !sameObjectSelection(next, state)) next.pickedImages = []
  if (sameSelection(next, state)) return state
  return { ...next, selectedObjects: toSelectedObjects(next) }
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
  selectedObjects: [],
  pickedImages: [],

  setPickedImages: (names) => set((state) => commit(state, { pickedImages: [...names] })),

  select: (partial) =>
    set((state) => {
      // 只装本次给的字段：与旧状态合并交给 `commit`（顺带做派生与「没变化就不通知」）
      const next: Partial<Selection> = { ...partial }
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
      return commit(state, next)
    }),

  selectBone: (name) => {
    clearTrackFocus()
    set((state) => {
      // 同一根骨骼保持原有顶点选择（拖拽中途会重复选中），换对象则连单选顶点一起作废
      const keep = state.bone === name
      return commit(state, {
        kind: 'bone',
        bone: name,
        bones: name ? [name] : [],
        vertices: keep ? state.vertices : [],
        vertex: keep ? state.vertex : -1
      })
    })
  },

  selectBones: (names) => {
    clearTrackFocus()
    // 去重（点选顺序即主选中优先级：最后一根是主选中）
    const unique = [...new Set(names.filter((name) => name !== ''))]
    set((state) =>
      commit(state, {
        kind: unique.length > 0 ? 'bone' : 'none',
        bone: unique.length > 0 ? unique[unique.length - 1] : '',
        bones: unique,
        vertices: [],
        vertex: -1
      })
    )
  },

  toggleBone: (name) => {
    clearTrackFocus()
    if (!name) return
    set((state) => {
      const has = state.bones.includes(name)
      const bones = has ? state.bones.filter((item) => item !== name) : [...state.bones, name]
      if (bones.length === 0) {
        return commit(state, { kind: 'none', bone: '', bones: [], vertices: [], vertex: -1 })
      }
      return commit(state, {
        kind: 'bone',
        // 新加进来的那根成为主选中；移出的若是主选中，就退回集合里最后一根
        bone: has && state.bone !== name ? state.bone : bones[bones.length - 1],
        bones,
        vertices: [],
        vertex: -1
      })
    })
  },

  selectSlot: (name) => {
    clearTrackFocus()
    set((state) => commit(state, { kind: 'slot', slot: name, bones: [], vertices: [], vertex: -1 }))
  },

  selectAttachment: (slot, attachment) =>
    set((state) =>
      commit(state, {
        kind: 'attachment',
        slot,
        attachment,
        bones: [],
        vertices: [],
        vertex: -1
      })
    ),

  selectConstraint: (name) =>
    set((state) => commit(state, { kind: 'constraint', constraint: name, bones: [], vertices: [], vertex: -1 })),

  // 框选只拿得到共享缓冲下标，没有「附件内下标」→ 单选标记一律清掉
  selectVertices: (vertices) => set((state) => commit(state, { vertices, vertex: -1 })),

  clear: () => {
    const skin = get().skin
    // 连资源面板里选中的图片一起清：`clear` 的语义是「全都取消选择」
    set((state) => commit(state, { ...EMPTY, skin, pickedImages: [] }))
  }
}))

/**
 * 当前选中（含派生出来的 `selectedObjects`）；非 React 环境（命令 / 工具）读这个。
 * 只要「选中了哪些对象」就读 `.selectedObjects`。
 */
export function currentSelection(): SelectionState {
  return useSelectionStore.getState()
}
