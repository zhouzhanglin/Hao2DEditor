
import { create } from 'zustand'

/**
 * 编辑工具。**顶点编辑只有一个工具**（`ffd`）：Pose 态它就是「网格工具(M)」，
 * Animate 态是「FFD 顶点工具(D)」—— 两者本来就是同一段实现（见 authoringTools 的顶点拖拽分支），
 * 拆成两个按钮只会让人犹豫点哪个。
 */
export type EditorTool = 'select' | 'bone' | 'weight' | 'ffd'

export type BrushMode = 'add' | 'subtract' | 'replace'

/**
 * 骨骼变换小坐标轴（gizmo）的操作模式：移动 / 旋转 / 缩放 / 斜切。
 * 快捷键 W / E / R / T（按工具条从上到下的顺序连续排布）。
 */
export type GizmoMode = 'move' | 'rotate' | 'scale' | 'shear'

/** 小坐标轴工具顺序（快捷键与工具栏共用，改一处即可） */
export const GIZMO_ORDER: ReadonlyArray<{ mode: GizmoMode; key: string; label: string; hint: string }> = [
  { mode: 'move', key: 'W', label: '移动', hint: '移动骨骼：拖 X/Y 轴只走单轴，拖中间方块自由移动；Shift 拖动改位移（Pose 改 setup / Animate 写关键帧）' },
  { mode: 'rotate', key: 'E', label: '旋转', hint: '旋转骨骼：拖圆环或骨骼本体都行' },
  { mode: 'scale', key: 'R', label: '缩放', hint: '缩放骨骼：X 轴改长度、Y 轴改粗细，拖中间方块等比缩放' },
  {
    mode: 'shear',
    key: 'T',
    label: '斜切',
    hint: '斜切骨骼：选中骨骼会被包围盒框住，拖动包围盒的边即可斜切（上下边横向拖改 shearY，左右边纵向拖改 shearX）'
  }
]

export interface OverlayState {
  bones: boolean
  mesh: boolean
  weight: boolean
  ffd: boolean
  constraints: boolean
}

export interface BrushState {
  radius: number
  strength: number
  mode: BrushMode
}

export interface ToolState {
  tool: EditorTool
  /** 骨骼变换 gizmo 的当前模式 */
  gizmo: GizmoMode
  overlay: OverlayState
  brush: BrushState
  /** 网格创建的栅格细分数量（Region 转网格） */
  gridDivisions: number
  /**
   * 「添加绑定骨骼」的等待态：记下正要把骨骼绑给哪个网格，之后在视口里点中的骨骼
   * 就加入它的权重骨骼列表。刻意与 tool 解耦（独立字段），切换工具 / gizmo 时自动清掉。
   */
  pendingWeightBone: { slot: string; attachment: string } | null
  setTool: (tool: EditorTool) => void
  setGizmo: (mode: GizmoMode) => void
  setOverlay: (overlay: OverlayState) => void
  toggleOverlay: (key: keyof OverlayState) => void
  setBrush: (brush: Partial<BrushState>) => void
  setGridDivisions: (value: number) => void
  setPendingWeightBone: (target: { slot: string; attachment: string } | null) => void
}

export const useToolStore = create<ToolState>((set, get) => ({
  tool: 'select',
  gizmo: 'move',
  overlay: { bones: true, mesh: false, weight: false, ffd: false, constraints: true },
  brush: { radius: 40, strength: 0.5, mode: 'add' },
  gridDivisions: 4,
  pendingWeightBone: null,

  // 选中绘制类工具时顺手打开对应显示层，否则「工具选了但看不到能编辑的东西」
  setTool: (tool) => {
    const overlay = { ...get().overlay }
    if (tool === 'weight') overlay.weight = true
    if (tool === 'ffd') {
      // 顶点编辑：Pose 态要看网格线，Animate 态要看 FFD 偏移虚线，两个显示层都打开
      overlay.ffd = true
      overlay.mesh = true
    }
    // 换工具就放弃「等待点选骨骼」，免得换个工具后第一次点击被旧等待态吃掉
    set({ tool, overlay, pendingWeightBone: null })
  },
  /**
   * 选择变换工具时**自动退出绘制类工具**（权重刷 / FFD / 网格 / 插槽 / 约束）。
   * 否则鼠标会被绘制工具吃掉（点了「旋转」却在刷权重），变换看起来完全没反应。
   */
  setGizmo: (gizmo) => {
    const tool = get().tool
    const painting = tool !== 'select' && tool !== 'bone'
    set(painting ? { gizmo, tool: 'select', pendingWeightBone: null } : { gizmo, pendingWeightBone: null })
  },
  setOverlay: (overlay) => set({ overlay }),
  toggleOverlay: (key) => set({ overlay: { ...get().overlay, [key]: !get().overlay[key] } }),
  setBrush: (brush) => set({ brush: { ...get().brush, ...brush } }),
  setGridDivisions: (value) => set({ gridDivisions: Math.max(1, Math.min(24, Math.round(value))) }),
  setPendingWeightBone: (target) => set({ pendingWeightBone: target })
}))

export function currentTools(): ToolState {
  return useToolStore.getState()
}
