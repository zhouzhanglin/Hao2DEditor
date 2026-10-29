
import { create } from 'zustand'
import type { AutoWeightMethod } from '@editor/commands/authoringCommands'
import { t } from '@i18n'

/**
 * 编辑工具。**顶点编辑只有一个工具**（`ffd`）：Pose 态它就是「网格工具(M)」，
 * Animate 态是「FFD 顶点工具(D)」—— 两者本来就是同一段实现（见 authoringTools 的顶点拖拽分支），
 * 拆成两个按钮只会让人犹豫点哪个。
 */
export type EditorTool = 'select' | 'bone' | 'weight' | 'ffd' | 'pose' | 'mask'

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
 * 权重刷参数 —— Mode / Size / Strength / Feather / Normalize。
 *
 * `strength` 与 `feather` 走 **Spine Weights 工具的笔刷语义**：
 * - `strength`：一笔内目标骨骼能刷到的**权重上限**（0..100）。100 = 一次刷满；
 *   30 = 无论这一笔里来回刷多少遍，最多到 30%，不再像"每帧增量"那样越刷越浓。
 * - `feather`：笔刷边缘的衰减范围占半径的百分比（0..100）。0 = 硬边（整圈满强度），
 *   100 = 从中心就开始线性衰减到边缘 0。
 *
 * 修饰键仍可临时改方向，落笔用的是**修饰键优先、其次这个 Mode**：
 * Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长（见 brushModeFor）。
 */
export interface BrushState {
  mode: BrushModeSetting
  /** Size —— 笔刷光标大小（像素，视口里的圈就是它） */
  size: number
  /** Strength —— 一笔能刷到的权重上限（0..100） */
  strength: number
  /** Feather —— 边缘衰减占比（0 = 硬边，100 = 从中心开始衰减） */
  feather: number
  /** Normalize —— 刷过的顶点权重归一到 1；关掉则只改目标骨骼，权重和可能 ≠ 1 */
  normalize: boolean
}

/**
 * 权重修剪（Spine 的 Prune）的参数，面板见检查器「权重骨骼列表」里的「修剪权重」一行。
 *
 * - `maxInfluences`：每顶点最多保留几根骨骼。运行时与导出**固定 4 槽**
 *   （见 `compile.normalizeWeights` / `hao2dWriter`），所以这里也只允许 1~4；
 * - `threshold`：丢掉小于这个百分比（%）的权重；0 = 只按上限截断。
 *
 * 只存在工具状态里（不进文档）：这是「怎么裁」的一次性参数，不该跟着工程存档走。
 */
export interface WeightTrimState {
  maxInfluences: number
  threshold: number
}

/**
 * 权重刷的**子工具**：决定左键拖动是刷权重还是框选顶点。
 *
 * 权重刷的左键拖动本来只有一个含义（刷），要加框选就必须二选一 —— 用视口左下角的小工具条切换，
 * 而不是抢修饰键：Alt / Shift / Ctrl 已经是「减少 / 覆盖 / 平滑」。
 *
 * - `paint`：刷权重（默认）
 * - `box`：拉矩形框选顶点（Shift 追加）；框选只改选择，之后再刷只影响这些顶点
 * - `direct`：Spine 的 Direct —— 选中顶点后在视口里上下拖动，改它们在某根骨骼上的权重
 */
export type WeightSubtool = 'paint' | 'box' | 'direct'

/** 权重刷子工具图标条的顺序与文案（工具条、状态提示共用一处，改一处即可） */
export function weightSubtools(): Array<{ id: WeightSubtool; label: string; hint: string }> {
  return [
    {
      id: 'paint',
      label: t('刷权重'),
      hint: t('刷权重（默认）：按住拖动按 Mode / Strength / Feather 刷；有选中顶点时只刷这些顶点')
    },
    {
      id: 'box',
      label: t('框选顶点'),
      hint: t('框选顶点：拖出矩形选中顶点（Shift 追加）；之后刷权重只影响这些顶点，点空白处取消选择')
    },
    {
      id: 'direct',
      label: t('直接拖动'),
      hint: t('直接拖动：先在视口里点选 / 框选顶点，再按住上下拖动调整它们在这根骨骼上的权重（上=加 / 下=减）')
    }
  ]
}

/**
 * 骨骼变换小坐标轴（gizmo）的操作模式：移动 / 旋转 / 缩放 / 斜切。
 * 快捷键 W / E / R / T（按工具条从上到下的顺序连续排布）。
 */
export type GizmoMode = 'move' | 'rotate' | 'scale' | 'shear'

/**
 * 小坐标轴工具顺序（快捷键与工具栏共用，改一处即可）。
 * 文案随语言切换，所以是函数不是常量。
 */
export function gizmoOrder(): Array<{ mode: GizmoMode; key: string; label: string; hint: string }> {
  return [
    { mode: 'move', key: 'W', label: t('移动'), hint: t('移动骨骼：拖 X/Y 轴只走单轴，拖中间方块自由移动；Shift 拖动改位移（Pose 改 setup / Animate 写关键帧）') },
    { mode: 'rotate', key: 'E', label: t('旋转'), hint: t('旋转骨骼：拖圆环或骨骼本体都行') },
    { mode: 'scale', key: 'R', label: t('缩放'), hint: t('缩放骨骼：X 轴改长度、Y 轴改粗细，拖中间方块等比缩放') },
    {
      mode: 'shear',
      key: 'T',
      label: t('斜切'),
      hint: t('斜切骨骼：选中骨骼会被包围盒框住，拖动包围盒的边即可斜切（上下边横向拖改 shearY，左右边纵向拖改 shearX）')
    }
  ]
}

/**
 * 网格工具（Pose 态的「网格工具 M」）的**子工具**：决定鼠标在网格上做什么。
 *
 * 只有 `edit`（拖顶点）是常驻状态，其余四个都是临时的：在视口里按右键就回到 `edit`
 * （见 MeshSubtoolBar 与视口的右键处理）；其中 `boundary` 画完轮廓（点回起点或右键闭合）
 * 会自己回到 `edit`，因为一个网格只该有一个外边界。
 *
 * - `add`：点网格内部插入顶点（等同原来的 Alt+点击）
 * - `remove`：点顶点把它删掉（引用它的三角形就地重新三角化）
 * - `boundary`：依次点击画出网格外边界，点回起点 / 右键自动闭合；这期间视口只留图片的 region 框
 *   （旧网格线框与顶点全藏起来，落点也会被夹在框内，见 Scene.drawBoundaryFrame）
 * - `rewire`：从一个顶点拖到另一个顶点松手，在两点之间连一条线
 */
export type MeshSubtool = 'edit' | 'add' | 'remove' | 'boundary' | 'rewire'

/**
 * 子工具图标条的顺序与文案（工具条、状态提示共用一处，改一处即可）。
 * `divider` 标记「与上一项之间画一条分隔线」—— 前三个是顶点级操作，后两个是拓扑级。
 * 文案随语言切换，所以是函数不是常量。
 */
export function meshSubtools(): Array<{
  id: MeshSubtool
  label: string
  hint: string
  divider?: boolean
}> {
  return [
    {
      id: 'edit',
      label: t('编辑顶点'),
      hint: t('编辑顶点（默认）：拖动顶点改网格几何；Pose 态改的是绑定网格，贴图留在原地')
    },
    {
      id: 'add',
      label: t('添加顶点'),
      hint: t('添加顶点：点网格的边或三角形内部插入一个顶点（UV / 权重按位置插值，等同按住 Alt 点击）')
    },
    {
      id: 'remove',
      label: t('删除顶点'),
      hint: t('删除顶点：点一个顶点把它删掉，引用它的三角形会就地重新三角化补上')
    },
    {
      id: 'boundary',
      label: t('自己绘制边界'),
      hint: t('自己绘制边界：沿着轮廓依次点击（点不能超出图片的 region 框，画的时候只显示 region 框与轮廓，网格与顶点临时隐藏）；点回起点（第一个大圆点）或按右键即收尾闭合（闭合会丢弃原网格点、绑定权重与 FFD 关键帧），闭合后回到「编辑顶点」；点错了按 Ctrl+Z 撤回上一个点（此时 Ctrl+Z 只撤点，不动文档）'),
      divider: true
    },
    {
      id: 'rewire',
      label: t('自定义布线'),
      hint: t('自定义布线：从一个顶点按住拖到另一个顶点松手，即可在这两点之间连一条线（沿这条线重新三角化）')
    }
  ]
}

/**
 * 点「自己绘制边界」时那个确认弹窗的**正文**：这个子工具是整块重画，进去之前必须把
 * 「会丢什么」说清楚（撤销能救回来，但用户得先知道自己在丢什么）。
 *
 * 弹窗本体是 `ConfirmDialog`（与「新建工程 / 导出」同一套样式），触发点在 `MeshSubtoolBar`：
 * 选中项确实有东西可丢时才弹（判定见 authoringTools 的 `boundaryRedrawLoss`）。
 *
 * 文案里承诺的三件事都真的会发生，改动 `rebuildMeshBoundary` 时要同步：
 * 1. 旧顶点全部换成画的这一圈点（内部顶点直接丢弃）；
 * 2. 所有绑定权重清空（`vertices[].weights` 与 `bones` 一起清），网格回到刚性；
 * 3. 该附件在各动画里的 FFD 关键帧（时间轴上的那些帧）全部删除。
 */
export function boundaryRedrawWarning(): string {
  return t('重绘网格边线会删除当前选中图片上所有已添加的网格点，删除所有绑定的骨骼权重，并删除相对应的时间轴关键帧。\n\n您确定要手动重绘网格边线吗？')
}

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
  /**
   * 网格工具的子工具（编辑顶点 / 添加 / 删除 / 画边界 / 自定义布线）。
   * 与 `pendingWeightBone` 一样刻意与 tool 解耦：换工具 / 换 gizmo 都回到 `edit`，
   * 免得下次切回网格工具时鼠标还停在「删顶点」这种危险的语义上。
   */
  meshSubtool: MeshSubtool
  /**
   * 权重刷的子工具（刷权重 / 框选顶点）。与 `meshSubtool` 同理：换工具 / 换 gizmo 都回到 `paint`，
   * 免得下次切回权重刷时鼠标还停在「框选」上、按下去以为是刷。
   */
  weightSubtool: WeightSubtool
  /** 权重修剪参数（丢小权重 + 每顶点影响数上限） */
  trim: WeightTrimState
  /**
   * 自动权重的算法口径（见 `AutoWeightMethod`）：
   * - `heat`：逐骨骼在网格表面热扩散，结果连续（默认）；
   * - `geodesic`：沿表面算距离再按 1/d^k 分配，快但有突跳；
   * - `distance`：纯直线距离，贴身部件会串味，仅作兜底/对比。
   */
  autoMethod: AutoWeightMethod
  setTool: (tool: EditorTool) => void
  setGizmo: (mode: GizmoMode) => void
  setMeshSubtool: (subtool: MeshSubtool) => void
  setWeightSubtool: (subtool: WeightSubtool) => void
  setOverlay: (overlay: OverlayState) => void
  toggleOverlay: (key: keyof OverlayState) => void
  setBrush: (brush: Partial<BrushState>) => void
  setTrim: (trim: Partial<WeightTrimState>) => void
  setAutoMethod: (value: AutoWeightMethod) => void
  setGridDivisions: (value: number) => void
  setPendingWeightBone: (target: { slot: string; attachment: string } | null) => void
}

export const useToolStore = create<ToolState>((set, get) => ({
  tool: 'select',
  gizmo: 'move',
  overlay: { bones: true, constraints: true },
  /*
   * 笔刷参数（Mode / Size / Strength / Feather / Normalize），面板见属性最下面的「权重刷」一栏。
   * - Size 40px = 0.4 世界单位（视口里的圈就是它）；
   * - Strength 40%：一笔刷到 40% —— 一笔封顶、来回刷不会越来越浓，想一次刷满就调到 100；
   * - Feather 50%：外半边线性衰减到 0，边缘过渡自然；
   * - Normalize 默认开：刷完归一化到 1，避免出现权重和不等于 1 的顶点。
   */
  brush: { mode: 'addSubtract', size: 40, strength: 40, feather: 50, normalize: true },
  gridDivisions: 4,
  pendingWeightBone: null,
  meshSubtool: 'edit',
  weightSubtool: 'paint',
  /*
   * 修剪默认就按导出/运行时的口径来：每顶点 4 根骨骼、丢掉小于 1% 的权重。
   * 与子工具不同，它不随换工具复位 —— 用户调好的阈值应该一直用得上。
   */
  trim: { maxInfluences: 4, threshold: 1 },
  // 默认热扩散：结果连续，贴身部件不会被对侧骨骼抢走权重
  autoMethod: 'heat',

  /**
   * 换工具**不再改任何显示层**：网格线框与顶点、FFD、权重着色都由工具与选中项驱动
   *（视口把它们作为 `editMeshSlot` / `focusMeshSlot` / `weightTool` 推给场景，
   * 见 Scene.drawOverlays）。这里的 overlay 只留给「骨架 / 约束」两个纯显示开关。
   */
  setTool: (tool) => {
    /*
     * 换工具就放弃「等待点选骨骼」与两个子工具，免得换个工具后第一次点击被旧状态吃掉。
     * 权重刷子工具回到 `paint`（默认刷）—— 切走再回来时按下去是刷，而不是莫名其妙的框选。
     */
    set({ tool, pendingWeightBone: null, meshSubtool: 'edit', weightSubtool: 'paint' })
  },
  /**
   * 选择变换工具（移动/旋转/缩放/斜切）时**自动退出绘制类工具**，见 `isDrawTool`。
   */
  setGizmo: (gizmo) => {
    const tool = get().tool
    set(
      isDrawTool(tool)
        ? { gizmo, tool: 'select', pendingWeightBone: null, meshSubtool: 'edit', weightSubtool: 'paint' }
        : { gizmo, pendingWeightBone: null, meshSubtool: 'edit', weightSubtool: 'paint' }
    )
  },
  setOverlay: (overlay) => set({ overlay }),
  toggleOverlay: (key) => set({ overlay: { ...get().overlay, [key]: !get().overlay[key] } }),
  setBrush: (brush) => set({ brush: { ...get().brush, ...brush } }),
  // 夹在合法区间：上限 1~4（运行时只有 4 槽），阈值 0~100%
  setTrim: (trim) => {
    const next = { ...get().trim, ...trim }
    set({
      trim: {
        maxInfluences: Math.max(1, Math.min(4, Math.round(next.maxInfluences))),
        threshold: Math.max(0, Math.min(100, Math.round(next.threshold)))
      }
    })
  },
  setGridDivisions: (value) => set({ gridDivisions: Math.max(1, Math.min(24, Math.round(value))) }),
  setPendingWeightBone: (target) => set({ pendingWeightBone: target }),
  setMeshSubtool: (meshSubtool) => set({ meshSubtool }),
  setWeightSubtool: (weightSubtool) => set({ weightSubtool }),
  setAutoMethod: (autoMethod) => set({ autoMethod })
}))

export function currentTools(): ToolState {
  return useToolStore.getState()
}
