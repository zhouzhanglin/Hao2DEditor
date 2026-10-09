
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

/**
 * 权重刷的**模式**（与 Unity 2D Animation 的 Weight Brush「Mode」同名）：
 *
 * - `addSubtract`：影响选中骨骼周围**所有**顶点（增加；按住 Alt 减少）
 * - `growShrink`：只影响**已经受该骨骼影响**的顶点（生长 / 收缩）
 * - `smooth`：与邻居平均，让权重分布更平滑（与刷哪根骨骼无关）
 */
export type BrushModeSetting = 'addSubtract' | 'growShrink' | 'smooth'

/**
 * 权重刷参数 —— **与 Unity Weight Brush 面板同名**（Mode / Size / Hardness / Normalize），
 * 面板在属性最下面的「权重刷」一栏（只在权重刷工具下出现）。
 *
 * 修饰键仍可临时改方向，落笔用的是**修饰键优先、其次这个 Mode**：
 * Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长（见 brushModeFor）。
 */
export interface BrushState {
  mode: BrushModeSetting
  /** Unity: Size —— 笔刷光标大小（像素，视口里的圈就是它） */
  size: number
  /**
   * Unity: Hardness —— 每次笔刷施加多少权重，0..100（100 = 一次到位）。
   * 默认 1.5：一次划过约百分之几，需要来回刷才逐步加满（500 时代一次拖拽就冲满，手感"擦一下就满"）。
   */
  hardness: number
  /** Unity: Normalize —— 刷过的顶点权重归一到 1；关掉则只改目标骨骼，权重和可能 ≠ 1 */
  normalize: boolean
}

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

/**
 * 视口叠加层开关。
 *
 * **刻意只留「与在编辑谁无关」的两项**：骨骼骨架、约束手柄 —— 它们在任何工具下看的都是同一件事。
 *
 * 被移除的三项都是「跟着编辑对象 / 工具走」的，用户不需要手动同步：
 * - **网格线框与顶点**：选择 / Pose 工具按选中项只画那一个（视口填 `focusMeshSlot`），
 *   顶点工具走网格隔离（只渲染正在编辑的那一个）；
 * - **FFD**：同上，顶点工具选中附件就显示；
 * - **权重着色（饼图）**：只在权重刷工具激活时画（视口填 `weightTool`，见 Scene）。
 *
 * 手动开全局的那几个反而是负担：复杂角色会铺满线条与顶点（这正是它们被移除的原因）。
 */
export interface OverlayState {
  bones: boolean
  constraints: boolean
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
  overlay: { bones: true, constraints: true },
  /*
   * 笔刷参数：与 Unity Weight Brush 面板同名（Mode / Size / Hardness / Normalize），
   * 面板见属性最下面的「权重刷」一栏。
   * - Size 40px = 0.4 世界单位（视口里的圈就是它）；
   * - Hardness 1.5（= 强度 0.015）：每移动一次叠加 0.015×衰减，一次划过约百分之几；
   * - Normalize 默认开：刷完归一化到 1，避免出现权重和不等于 1 的顶点。
   */
  brush: { mode: 'addSubtract', size: 40, hardness: 1.5, normalize: true },
  gridDivisions: 4,
  pendingWeightBone: null,

  /**
   * 换工具**不再改任何显示层**：网格线框与顶点、FFD、权重着色都由工具与选中项驱动
   *（视口把它们作为 `isolateMeshSlot` / `focusMeshSlot` / `weightTool` 推给场景，
   * 见 Scene.drawOverlays）。这里的 overlay 只留给「骨架 / 约束」两个纯显示开关。
   */
  setTool: (tool) => {
    // 换工具就放弃「等待点选骨骼」，免得换个工具后第一次点击被旧等待态吃掉
    set({ tool, pendingWeightBone: null })
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
