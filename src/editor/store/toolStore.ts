
import { create } from 'zustand'

/**
 * 编辑工具。**顶点编辑只有一个工具**（`ffd`）：Pose 态它就是「网格工具(M)」，
 * Animate 态是「FFD 顶点工具(D)」—— 两者本来就是同一段实现（见 authoringTools 的顶点拖拽分支），
 * 拆成两个按钮只会让人犹豫点哪个。
 */
export type EditorTool = 'select' | 'bone' | 'weight' | 'ffd' | 'pose'

/**
 * 「网格类」编辑工具：顶点/UV 编辑、网格隔离、顶点显示都归它们。
 *
 * - `ffd`：拖顶点改**几何**（Pose 改绑定网格 / Animate 写 FFD 帧），贴图跟着保持不动
 * - `pose`：拖顶点只改**贴图坐标（UV）**，几何不动（调绑定姿态 / 修贴图用）
 *
 * 两者的骨骼变换都写进绑定姿态，所以视口里骨骼操作器对它们都开放。
 */
export function isMeshEditTool(tool: EditorTool): boolean {
  return tool === 'ffd' || tool === 'pose'
}

/**
 * 「绘制类」工具：鼠标按下即开始**绘制/涂抹**，会被它们自己吃掉。
 *
 * 只有这些工具在点变换工具（W/E/R/T）时才需要被顶掉成 `select` —— 否则会出现
 * 「点了旋转却在刷权重」这种变换看起来完全没反应的情况。
 *
 * 反过来，下面这几个**不动**：
 * - `select`：本来就是变换工具；
 * - `bone`：画骨骼时常要顺手调一下骨骼姿态；
 * - `pose`：Pose 工具的核心操作就是「拖骨骼改绑定姿态」，切 gizmo 只是换一种变换方式 ——
 *   把工具顶掉的话，每换一次变换方式都得重新点一下 Pose 工具。
 *
 * 注意 `pose` 与 `ffd` 虽然都会拖顶点，但 `ffd` 的拖动是**写帧/改网格**（绘制语义），
 * 而 `pose` 走的是「选中 + 变换」语义，所以两者分属不同阵营。
 */
export function isDrawTool(tool: EditorTool): boolean {
  return tool !== 'select' && tool !== 'bone' && tool !== 'pose'
}

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
    // Pose 工具编的是网格顶点 / UV：顺手打开网格层，否则「看不到能拖的顶点」。
    // 这里不像 ffd 那样顾虑「全局线框铺满角色」—— 场景会把网格**隔离**到选中的那一个
    //（见 ViewportCanvas 的 isolateMesh*，Pose 与 FFD 走同一套判定）。
    if (tool === 'pose') overlay.mesh = true
    if (tool === 'ffd') {
      // 顶点编辑：打开「FFD」显示层（顶点方块 + 偏移虚线）。
      //
      // **不**顺手打开「网格」：网格层是**全局**的（画所有附件的线框），而且切回别的
      // 工具后它仍然亮着 —— 整个角色会铺满线框，而这并不是使用者要的「只看我选中的
      // 那个网格」。网格工具本身已经只渲染选中的那个网格（见 Scene.applyMeshIsolation），
      // 需要线框时手动点一下「网格」按钮即可（此时也只有那一个网格有线框）。
      overlay.ffd = true
    }
    // 换工具就放弃「等待点选骨骼」，免得换个工具后第一次点击被旧等待态吃掉
    set({ tool, overlay, pendingWeightBone: null })
  },
  /**
   * 选择变换工具（移动/旋转/缩放/斜切）时**自动退出绘制类工具**，见 `isDrawTool`。
   */
  setGizmo: (gizmo) => {
    const tool = get().tool
    set(
      isDrawTool(tool)
        ? { gizmo, tool: 'select', pendingWeightBone: null }
        : { gizmo, pendingWeightBone: null }
    )
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
