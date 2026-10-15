import type { Vec2 } from '@core/math/matrix'
import { invert, mulPoint, mulVector, trs } from '@core/math/matrix'
import { attachmentGizmoFrame, gizmoGeometry } from '@render/picking'
import type { GizmoPart, ShearEdge } from '@render/picking'
import { GIZMO_AXIS_LENGTH } from '@render/overlays/boneOverlay'
import { RAD2DEG } from '@core/math/utils'
import type { EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, rootBoneName } from '@core/model/authoring'
import { attachmentFrameBox } from '@core/model/types'
import type { EditorScene } from '../scene'
import type { Selection } from '../store/selectionStore'
import { isMeshEditTool } from '../store/toolStore'
import type { ToolState } from '../store/toolStore'
import type { EditorMode } from '../store/modeStore'
import type { GizmoMode } from '../store/toolStore'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { keyBoneChannel, keyDeform } from '../commands/animationCommands'
// 「画骨骼时把鼠标下的插槽带过来」复用层级树拖放插槽的同一套命令（会换算附件位置，画面不跳）
import { moveSlot, validateSlotMove } from '../commands/hierarchyCommands'
import type { MoveResult } from '../commands/hierarchyCommands'
import {
  autoWeights,
  deleteMeshVertex,
  findAttachment,
  insertMeshVertex,
  meshVertexSamples,
  paintWeights,
  patchAttachment,
  uniqueName,
  weightBonesOf
} from '../commands/authoringCommands'
import type { BrushMode, VertexSample } from '../commands/authoringCommands'
import type { BrushModeSetting, MeshSubtool } from '../store/toolStore'
import { MESH_SUBTOOLS, useToolStore } from '../store/toolStore'
import { fitUvField, isInteriorVertex, polygonUvs, triangulatePolygon } from '@core/mesh/triangulate'

export interface PointerInfo {
  world: Vec2
  shift: boolean
  ctrl: boolean
  alt: boolean
}

export interface ToolHost {
  scene: EditorScene
  selection: Selection
  tools: ToolState
  mode: EditorMode
  time: number
  status: (text: string) => void
}

type DragKind =
  | 'bone-translate'
  | 'bone-create'
  | 'gizmo'
  | 'shear-box'
  | 'vertex'
  | 'paint'
  | 'attachment'
  /** 网格子工具「自定义布线」：从一个顶点拖到另一个顶点，松手连线 */
  | 'mesh-rewire'
  | 'none'

/** 多骨骼拖拽：每根骨骼各自按下时的本地值（增量都按自己的起始值重算，避免累积误差） */
interface MultiBoneStart {
  name: string
  /** 按下时的本地旋转（度） */
  rot: number
  /** 按下时的本地位置（父骨骼局部空间） */
  pos: Vec2
  /** 按下时的本地缩放 */
  scale: Vec2
  /** 按下时的本地斜切（度） */
  shear: Vec2
}

interface DragSession {
  kind: DragKind
  bone: string
  /**
   * 这次拖拽要一起改的骨骼（旋转 / 移动 / 缩放 / 斜切同时作用于它们）。
   *
   * 每根骨骼都**各自**在自己的本地值上加同一个增量 —— 谁也不替谁代劳：
   * 父子同选时子骨骼会自己再转 / 再移一次，这正是「分别变换」的语义。
   * 单根选中时就是它自己，写入路径与以前完全一致。
   */
  bones: MultiBoneStart[]
  /**
   * 旋转增量记账（单位：度，都是在父空间里量的指针角）。
   *
   * - `lastAngle`：上一帧指针绕**骨骼原点**的角度，用来取帧间增量；
   * - `sweep`：本次拖拽累计转过的角度 —— 每帧只把「这一帧转了多少」累加上去。
   *
   * 旋转按「指针转了多少度」加减，而不是「指针指到哪就转到哪」：抓在旋转圈任意位置按下，
   * 骨骼都不会先跳到指针方向。逐帧累计（而不是拿当前角减起始角）是因为 `atan2` 会在 ±180°
   * 回绕：一次划过 60° 若直接相减，可能算成 −300°；逐帧增量配合回绕修正则连续转几圈都不受影响。
   */
  lastAngle: number
  sweep: number
  /** 骨骼世界原点（旋转 / 缩放的轴心） */
  origin: Vec2
  /** gizmo 拖拽：模式 + 抓到的部位（中心 / X 轴 / Y 轴），以及按下时的骨骼本地值 */
  gizmoMode: GizmoMode
  gizmoPart: GizmoPart
  startLocal: { pos: Vec2; rot: number; scale: Vec2; shear: Vec2 }
  parentWorld: Float32Array | null
  /** 骨骼局部 X / Y 轴在**父骨骼局部空间**中的单位方向（平移要在这个空间里分解） */
  localAxisX: Vec2
  localAxisY: Vec2
  /** 按下时指针在父骨骼局部空间的位置：平移要扣掉它，否则骨骼会先跳到指针下 */
  startPointerLocal: Vec2
  /** 斜切包围盒拖拽：命中的边 + 按下时的局部包围盒（决定该边的坐标） */
  shearEdge: ShearEdge
  shearBox: { minX: number; minY: number; maxX: number; maxY: number } | null
  /** 缩放：按下时指针到轴心的距离与骨骼起始缩放 */
  startDistance: number
  startScale: Vec2
  /** 缩放轴向（x 沿骨骼 / y 垂直骨骼 / both 等比）与抓取点在轴上的投影 */
  scaleAxis: 'x' | 'y' | 'both'
  axisDir: Vec2
  axisPerp: Vec2
  startProject: number
  /** 顶点拖拽 */
  slot: string
  attachment: string
  vertex: number
  startWorld: Vec2
  /**
   * 指针的当前世界坐标（按下时先记成起点）。
   * 只有「自定义布线」用得上：松手时 `toolPointerUp` 拿不到坐标，得靠这里记的落点去找目标顶点。
   */
  lastWorld: Vec2
  /** 附件空间下的累计位移（顶点拖拽） */
  totalDelta: Vec2
  /**
   * 顶点拖拽的 UV 重算场（拖动开始时按邻居拟合出的原映射）。
   * Pose 态拖**内部**顶点时用它把新位置的 UV 反算出来，贴图内容原地不动；
   * 边缘顶点 / Animate 态（写的是 FFD 帧）为 null，UV 保持原样。
   */
  uvField: ((x: number, y: number) => { u: number; v: number }) | null
  paintMode: BrushMode
  moved: boolean
  /**
   * 权重刷是否已经真正开刷（第一次移动）。
   *
   * 撤销事务要等到这时才开：单击只是「选中顶点看权重」，不该留下一条空的撤销记录
   *（History.end 无条件入栈，没有内容变化也不会被丢弃）。
   */
  paintStarted: boolean
  /**
   * 上一次落笔的世界坐标（权重刷）。
   *
   * 叠加**按移动距离推进**（见 moveActiveDrag）：同一段路径，快拖和慢拖叠出来的次数一致 ——
   * 否则叠加次数取决于鼠标事件频率，手感会随速度飘（慢慢挪会一遍遍叠加、飞快划过反而只叠一两次）。
   */
  lastPaint: Vec2
  /** 新建骨骼：起点（已吸附）、当前终点与父骨骼名，松开时按起点→终点生成 */
  createStart: Vec2
  createEnd: Vec2
  createParent: string
  /**
   * 新建骨骼时鼠标所在的插槽（拖到哪个插槽上就记哪个，视口里同时高亮它）。
   * 松开后这个插槽会挂到新骨骼下面；没命中 / 命中锁定插槽时为空串。
   */
  createTargetSlot: string
  /** 附件操作器：宿主骨骼索引 + 按下时的 setup 值 + 被拖轴的局部 / 世界方向 */
  attBoneIndex: number
  attStart: { position: Vec2; rotation: number; scale: Vec2 }
  attAxisLocal: Vec2
  attAxisWorld: Vec2
  attAxisScale: number
  attStartAngle: number
}

const IDLE: DragSession = {
  kind: 'none',
  bone: '',
  bones: [],
  lastAngle: 0,
  sweep: 0,
  origin: { x: 0, y: 0 },

  startDistance: 0,
  startScale: { x: 1, y: 1 },
  gizmoMode: 'move',
  gizmoPart: 'center',
  startLocal: { pos: { x: 0, y: 0 }, rot: 0, scale: { x: 1, y: 1 }, shear: { x: 0, y: 0 } },
  parentWorld: null,
  localAxisX: { x: 1, y: 0 },
  localAxisY: { x: 0, y: 1 },
  startPointerLocal: { x: 0, y: 0 },
  shearEdge: 'top',
  shearBox: null,
  scaleAxis: 'both',
  axisDir: { x: 1, y: 0 },
  axisPerp: { x: 0, y: 1 },
  startProject: 0,
  slot: '',
  attachment: '',
  vertex: -1,
  startWorld: { x: 0, y: 0 },
  lastWorld: { x: 0, y: 0 },
  totalDelta: { x: 0, y: 0 },
  uvField: null,
  paintMode: 'replace',
  moved: false,
  paintStarted: false,
  lastPaint: { x: 0, y: 0 },
  createStart: { x: 0, y: 0 },
  createEnd: { x: 0, y: 0 },
  createParent: '',
  createTargetSlot: '',
  attBoneIndex: -1,
  attStart: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  attAxisLocal: { x: 1, y: 0 },
  attAxisWorld: { x: 1, y: 0 },
  attAxisScale: 1,
  attStartAngle: 0
}

let drag: DragSession = { ...IDLE }

export function isDragging(): boolean {
  return drag.kind !== 'none'
}

/**
 * 权重刷的笔刷模式由**修饰键**决定（参数面板已移除），对应 Unity 2D Animation 的
 * Weight Brush「Mode」三项：
 *
 * | 修饰键 | 模式 | Unity 里的对应 |
 * | --- | --- | --- |
 * | 不按 | `add` 增加 | Add and Subtract（加半边） |
 * | **Alt** | `subtract` 减少 | Add and Subtract（减半边） |
 * | **Shift** | `replace` 覆盖 | ——（本工程额外保留的方向） |
 * | **Ctrl** | `smooth` 平滑 | **Smooth**（朝邻居平均） |
 * | **Ctrl+Shift** | `grow` 只加已受影响顶点 | **Grow and Shrink**（生长侧；配 Alt 即收缩） |
 *
 * 光标样式、半径圈颜色与真正落笔都走这一个出处 —— 三者说的必须是同一件事，
 * 否则会出现「光标画的是减号、实际却在加权重」这种最难受的错配。
 */
export function brushModeFor(
  info: { alt: boolean; shift: boolean; ctrl?: boolean },
  base: BrushMode = 'add'
): BrushMode {
  if (info.ctrl && info.shift) return info.alt ? 'subtract' : 'grow'
  if (info.ctrl) return 'smooth'
  if (info.alt) return 'subtract'
  if (info.shift) return 'replace'
  return base
}

/** Unity Weight Brush 的「Mode」下拉 → 落笔模式（没按修饰键时就用它） */
export function baseBrushMode(mode: BrushModeSetting): BrushMode {
  if (mode === 'growShrink') return 'grow'
  if (mode === 'smooth') return 'smooth'
  return 'add'
}

/** 状态栏里的动作名（与 brushModeFor 一一对应） */
export const BRUSH_ACTION: Record<BrushMode, string> = {
  add: '增加',
  grow: '增长',
  subtract: '减少',
  replace: '覆盖',
  smooth: '平滑'
}

/** 指针按下：返回 true 表示工具已接管（调用方不要再做默认选择逻辑） */
export function toolPointerDown(host: ToolHost, info: PointerInfo): boolean {
  const { tools, scene } = host
  if (!scene.runtime) return false

  if (tools.tool === 'weight') {
    /*
     * 单击 = **选中顶点**（属性检查器随即显示它的权重），拖动才刷权重。
     *
     * 两个细节别漏：
     * - 选顶点**不看有没有选中骨骼** —— 「这个顶点绑了哪几根骨骼」本来就不需要先挑一根骨骼；
     * - 撤销事务挪到真正开刷时才开（见 moveActiveDrag），否则纯点击会留下一条空的「权重刷」记录。
     */
    const hit = scene.pickVertexAt(info.world.x, info.world.y)
    const ref = hit ? scene.vertexRefAt(hit.vertexIndex) : null
    if (hit && ref) {
      useSelectionStore.getState().select({
        kind: 'attachment',
        slot: ref.slot,
        attachment: ref.attachment,
        vertices: [hit.vertexIndex],
        vertex: ref.vertex
      })
    }
    const vertexLabel = ref ? `顶点 #${ref.vertex}（${ref.slot} / ${ref.attachment}）` : null
    /*
     * 刷哪根骨骼取自 store 的 `bone` 字段（**不看 kind**）：选中顶点会把 kind 改成
     * attachment，若仍按 kind 判定，点完顶点就没法接着拖刷了 —— 而「先选骨骼、再点顶点、
     * 拖一下刷它」正是权重工具的常态用法。骨骼名会写在状态栏里，不会悄悄刷错骨骼。
     */
    const paintMode = brushModeFor(info, baseBrushMode(tools.brush.mode))
    const bone = useSelectionStore.getState().bone
    // 平滑平均的是「全部骨骼」的权重，不需要目标骨骼；其余模式必须先在层级树里选一根
    if (!bone && paintMode !== 'smooth') {
      host.status(
        vertexLabel
          ? `${vertexLabel}：在层级树里选一根骨骼后按住拖动即可刷权重`
          : '请先在层级树里选中要刷权重的骨骼'
      )
      return true
    }
    if (host.mode !== 'pose') {
      host.status('权重刷只在 Pose 状态可用（动画状态的角色姿态不是绑定姿态）')
      return true
    }
    /*
     * 只刷**选中的那个网格**（与官方工具「刷选中的网格」一致）。
     * 原来没选附件时会对整个角色的顶点生效 —— 那既不直观，也容易在别的部件上留下看不见的改动。
     */
    if (!useSelectionStore.getState().slot || !useSelectionStore.getState().attachment) {
      host.status('先在层级树里选中要刷权重的网格附件（Region 请先转为网格）')
      return true
    }
    // 平滑平均的是全部骨骼的权重，说「刷某根骨骼」会误导
    const action =
      paintMode === 'smooth' ? '平滑权重（朝邻居平均）' : `${BRUSH_ACTION[paintMode]}「${bone}」的权重`
    const target = paintMode === 'smooth' ? `权重刷` : `权重刷「${bone}」`
    host.status(
      vertexLabel
        ? `${vertexLabel}：按住拖动${action}`
        : `${target}：按住拖动${action}` +
            `（Mode ${tools.brush.mode} / Size ${tools.brush.size}px / Hardness ${tools.brush.hardness}` +
            `${tools.brush.normalize ? '' : ' / Normalize 关'}；临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长）`
    )
    drag = { ...IDLE, kind: 'paint', bone, paintMode, lastPaint: { ...info.world } }
    return true
  }

  // 绑骨骼工具：在视口里拖拽「画」骨骼（连续绑定）。
  // 起点落在已有骨骼上就吸附到它的轴线并以它为父（明确的「接着画」意图）；
  // 落在空白处一律挂在层级根骨骼 root 下 —— 选中态不参与，避免误挂到上次选中的骨骼下面。
  if (tools.tool === 'bone') {
    if (host.mode !== 'pose') {
      host.status('骨骼属于绑定数据：切到 Pose 状态再画')
      return true
    }
    // 端点吸附优先（「接着上一根画」）：精确接到末端 / 根端那个点上，并把该骨骼作为父级
    const endpoint = snapToBoneEndpoint(host, info.world)
    const parent = endpoint ? endpoint.bone : resolveCreateParent(host, info.world)
    const start = endpoint ? endpoint.point : snapToBoneAxis(host, info.world)
    drag = {
      ...IDLE,
      kind: 'bone-create',
      createParent: parent,
      createStart: start,
      createEnd: start
    }
    scene.setViewState({ pendingBone: { x1: start.x, y1: start.y, x2: start.x, y2: start.y } })
    storeHandler.begin('新建骨骼')
    host.status(
      (endpoint
        ? `已吸附到「${parent}」的骨骼端点：拖动决定长度与方向，松开生成（一根接一根就是骨骼链）`
        : parent
          ? `从「${parent}」接着画：拖动决定长度与方向，松开生成（可以一根接一根拖成骨骼链）`
          : '拖动决定长度与方向，松开生成骨骼（挂在根骨骼下；从骨骼上起笔才会挂到它下面）') +
        '；拖到插槽上松手会把该插槽挂过来（锁定中的插槽除外）'
    )
    return true
  }

  /*
   * 网格类工具（顶点工具 / Pose 工具）都从「抓顶点」开始，但拖动的含义不同：
   *   - 顶点工具 ffd：拖**几何**（Pose 改绑定网格 / Animate 写 FFD 帧），贴图留在原地
   *   - Pose 工具 pose：**只移动顶点**（几何），UV 不重算、贴图不跟着跑
   * 另外 Pose 工具没抓到顶点时要**继续往下走** —— 骨骼/操作器拖拽也得能用（见 applyCarry），
   * 顶点工具则到此为止（它的活只有顶点）。
   */
  if (isMeshEditTool(tools.tool)) {
    /*
     * 网格子工具（左下角图标条切出来的添加 / 删除 / 画边界 / 布线）先接管：
     * 它们的点击语义与「拖顶点」完全不同，而且只在 Pose 态可用（见 meshSubtoolPointerDown）。
     */
    if (tools.tool === 'ffd' && tools.meshSubtool !== 'edit' && meshSubtoolPointerDown(host, info)) return true
    /*
     * Pose 工具的顶点**只让位于真正的骨骼手柄**：指针落在骨骼**原点圈**（移动手柄）、
     * 小坐标轴、或斜切包围盒的边上时才优先抓骨骼 —— 与本工程「附件与骨骼重叠时骨骼优先」
     * 同一原则，否则骨骼原点旁边只要有顶点，骨骼就再也抓不起来了。
     *
     * 不能拿 `pickBoneHandleAt` 的结果一概而论：它在没命中原点圈时会回退到**骨骼本体**
     * （那是留给「点骨骼体 = 旋转」的），而骨骼本体常常整条压在网格顶点上 ——
     * 那样顶点就永远拖不动（实测：离原点圈 29px 的顶点照样被判成骨骼）。
     *
     * 斜切模式没有小坐标轴（`pickGizmoAt` 在 shear 下恒返回 null），可拖的骨骼手柄
     * 就是包围盒的边，所以这里要按模式分开判。
     */
    const boneHandle = tools.tool === 'pose' ? scene.pickBoneHandleAt(info.world.x, info.world.y) : null
    const onGizmo =
      tools.tool === 'pose' &&
      (tools.gizmo === 'shear'
        ? scene.pickShearEdgeAt(info.world.x, info.world.y) !== null
        : scene.pickGizmoAt(info.world.x, info.world.y) !== null)
    const bonePriority = boneHandle?.zone === 'origin' || onGizmo
    const vertex = bonePriority ? null : scene.pickVertexAt(info.world.x, info.world.y)
    if (vertex) {
      const resolved = resolveVertex(host, vertex.vertexIndex)
      if (!resolved || resolved.vertex < 0) {
        host.status('该顶点不支持编辑（Region 请先转为网格）')
        return true
      }
      const poseEdit = tools.tool === 'pose'
      drag = {
        ...IDLE,
        kind: 'vertex',
        slot: resolved.slot,
        attachment: resolved.attachment,
        vertex: resolved.vertex,
        startWorld: { ...info.world },
        // 顶点工具在 Pose 态先按邻居拟合 UV 场，拖动时把 UV 反算回原映射（贴图留在原地）；
        // Pose 工具**只移动顶点**、不碰 UV，所以不给场。
        uvField:
          host.mode === 'animate' || poseEdit
            ? null
            : prepareUvField(resolved.slot, resolved.attachment, resolved.vertex)
      }
      storeHandler.begin(host.mode === 'animate' ? '编辑 FFD' : poseEdit ? '移动顶点' : '编辑网格顶点')
      useSelectionStore.getState().select({
        kind: 'attachment',
        slot: resolved.slot,
        attachment: resolved.attachment,
        vertices: [vertex.vertexIndex],
        // 附件内下标：属性检查器靠它显示这个顶点的权重（共享下标只能给叠加层画标记）
        vertex: resolved.vertex
      })
      host.status(`顶点 #${resolved.vertex}（${resolved.slot} / ${resolved.attachment}）`)
      return true
    }
    /*
     * 没抓到顶点：看看是否点在了某个 display 上（含已转网格的 Mesh）。
     * 点中就直接选中它，使其顶点可见可编辑 —— 否则在网格工具下点别的 Mesh 永远选不中，
     * 只能去层级树里点，很别扭。命中骨骼手柄 / 约束准星时仍让骨骼优先（与选择工具一致）。
     */
    const hitBone = scene.pickBoneHandleAt(info.world.x, info.world.y)
    const constraintHit = hitBone ? -1 : scene.constraintTargetIndexAt(info.world.x, info.world.y)
    const effectiveHit = hitBone ?? (constraintHit >= 0 ? { boneIndex: constraintHit, zone: 'origin' as const, distance: 0 } : null)
    const att = effectiveHit ? null : scene.pickAttachmentAt(info.world.x, info.world.y)
    if (att && slotLocked(att.slot)) {
      host.status(`插槽「${att.slot}」已锁定：在层级树里解锁后才能选中`)
      return true
    }
    if (att) {
      const sel = host.selection
      if (att.slot !== sel.slot || att.attachment !== sel.attachment) {
        useSelectionStore.getState().selectAttachment(att.slot, att.attachment)
        host.status(`已选中附件「${att.attachment}」（${att.slot}）：可编辑其顶点`)
      }
      return true
    }
    // 没抓到顶点也没点中 display：顶点工具到此为止；Pose 工具继续，让骨骼 / 操作器接管
    if (tools.tool !== 'pose') return false
  }

  // 斜切模式：包围盒优先。鼠标落在包围盒的边上拖动 → 沿该方向掰轴
  // （bone 工具已经在上面按「画骨骼」处理并 return，走到这里的只剩选择工具与 Pose 工具）
  if ((tools.tool === 'select' || tools.tool === 'pose') && tools.gizmo === 'shear') {
    const edge = scene.pickShearEdgeAt(info.world.x, info.world.y)
    const selectedName = scene.state.selectedBone
    if (edge && selectedName && !boneLocked(selectedName)) {
      if (beginShearBoxDrag(host, selectedName, edge, info.world)) return true
    }
    if (edge && selectedName && boneLocked(selectedName)) {
      host.status(`骨骼「${selectedName}」已锁定，先解锁再编辑`)
      return true
    }
  }

  /*
   * 小坐标轴优先：它是选中骨骼的操作器，点中就必须由它接管。
   *
   * **Pose 工具也要放行**：视口在 Pose 工具下照常画操作器（`showGizmo` 含 pose，
   * 见 ViewportCanvas），画的就得能拖 —— 否则轴/圆环这些手柄全是点不动的假手柄
   *（只剩骨骼本体与原点圈能用）。顶点的抢占已经在上面让开了这条路（见 `onGizmo`）。
   */
  if (tools.tool === 'select' || tools.tool === 'pose') {
    const part = scene.pickGizmoAt(info.world.x, info.world.y)
    const selectedName = scene.state.selectedBone
    const selectedIndex = selectedName ? (scene.runtime.boneIndex[selectedName] ?? -1) : -1
    if (part && selectedIndex >= 0) {
      if (!beginGizmoDrag(host, selectedIndex, selectedName, part, info.world)) return true
      return true
    }
  }

  // 骨骼拾取先算出来：附件与骨骼重叠时**骨骼优先**（否则压在骨骼上的图片会把点击全吃掉，
  // 想选骨骼只能绕开图片，很难点）
  const hit = scene.pickBoneHandleAt(info.world.x, info.world.y)
  /*
   * 约束准星兜底（骨骼层关掉时 pickBoneHandleAt 恒空）：命中按「点中目标骨骼的原点圈」
   * 处理 —— 选中它并直接进入移动拖拽，与拖骨骼原点同一交互。必须排在附件拾取**前面**：
   * IK 节点（脚 / 手的 IK 把手）几乎都压在角色图片上，不抢先的话点准星选中的永远是图片
   */
  const constraintHit = hit ? -1 : scene.constraintTargetIndexAt(info.world.x, info.world.y)
  const effectiveHit = hit ?? (constraintHit >= 0 ? { boneIndex: constraintHit, zone: 'origin' as const, distance: 0 } : null)

  // 附件操作器 / 点选附件：选中附件后，小坐标轴画在附件上（中心橙色区分骨骼）
  if (tools.tool === 'select') {
    const sel = host.selection
    // 已选中附件的操作器保持最高优先级（它是明确的操作意图，画在附件中心）
    if (sel.kind === 'attachment' && sel.slot && sel.attachment) {
      const part = scene.pickAttachmentGizmoAt(info.world.x, info.world.y)
      if (part) {
        beginAttachmentGizmoDrag(host, sel.slot, sel.attachment, part, host.tools.gizmo, info.world)
        return true
      }
    }
    // 骨骼 / 约束准星命中时不抢选附件，交给下面的骨骼分支处理
    const att = effectiveHit ? null : scene.pickAttachmentAt(info.world.x, info.world.y)
    // 锁定的插槽在视口里不响应点选（占位拦下并说明原因，别让人以为「点坏了」）
    if (att && slotLocked(att.slot)) {
      host.status(`插槽「${att.slot}」已锁定：在层级树里解锁后才能选中`)
      return true
    }
    if (att) {
      const isNew = att.slot !== sel.slot || att.attachment !== sel.attachment
      if (isNew) useSelectionStore.getState().selectAttachment(att.slot, att.attachment)
      if (host.mode === 'pose') {
        /*
         * 点附件本体 = 按**当前小坐标轴模式**拖（与点骨骼本体同一规则：见下面的 beginGizmoDrag）。
         * 早先这里把模式写死成 'move'，于是不论切到移动 / 旋转 / 缩放 / 斜切，
         * 拖附件都只是平移 —— 看起来就像「什么工具都能拖动它」。
         *
         * 斜切不支持附件（与「斜切模式下不画附件操作器」一致，见 scene.drawOverlays），
         * 这里只提示、不起拖拽，避免出现「拖了但看不出在斜切」的假交互。
         */
        const mode = host.tools.gizmo
        if (mode === 'shear') {
          host.status(`斜切不支持附件：「${att.attachment}」请用移动 / 旋转 / 缩放，或斜切它所在的骨骼`)
        } else {
          beginAttachmentGizmoDrag(host, att.slot, att.attachment, 'center', mode, info.world)
          if (isNew) host.status(`已选中附件「${att.attachment}」（${att.slot}）：拖动即可${GIZMO_LABEL[mode]}`)
        }
        return true
      }
      if (isNew) {
        host.status(`已选中附件「${att.attachment}」（${att.slot}）：位置属于绑定数据，切到 Pose 态才能拖动`)
      }
      return true
    }
  }

  // 选择 / 骨骼 / 插槽 / 约束：点中骨骼即开始拖拽
  // 手柄分区：原点圈 = 移动、末端方块 = 缩放、骨骼体 = 旋转；
  // Shift 仍可强制移动、Alt 强制缩放（与旧习惯兼容）。
  if (!effectiveHit) return false
  const bone = scene.runtime.asset.bones[effectiveHit.boneIndex]
  if (!bone) return false
  // 锁定状态存在编辑期模型上（Runtime 模型没有该字段）
  const authoringBone = useProjectStore.getState().document.bones.find((item) => item.name === bone.name)
  if (authoringBone?.locked) {
    host.status(`骨骼「${bone.name}」已锁定，先解锁再编辑`)
    return true
  }

  const selection = useSelectionStore.getState()

  // 点在**已选中**的骨骼上就保留整个多选（拖动 = 带着其它选中骨骼一起动）；
  // 点别的骨骼才改成单选它 —— 与层级树里点行的规则一致
  if (!selection.bones.includes(bone.name)) selection.selectBone(bone.name)

  const offset = effectiveHit.boneIndex * 16
  const origin: Vec2 = { x: scene.runtime.skeleton.world[offset + 12], y: scene.runtime.skeleton.world[offset + 13] }
  const parent = bone.parentIndex
  // 骨骼**本体**上也直接响应当前变换模式（中心 = 整体：自由移动 / 旋转 / 等比缩放），
  // 不用非得精准抓到小坐标轴的细手柄；斜切则提示去拖包围盒的边。
  // 约束准星命中时 zone 是 origin（见上面的兜底）→ 走下面的移动拖拽
  if (effectiveHit.zone !== 'origin') {
    if (tools.gizmo === 'shear') {
      host.status(`斜切骨骼「${bone.name}」：拖动斜切包围盒的边（上下边横向拖 / 左右边纵向拖）`)
      return true
    }
    return beginGizmoDrag(host, effectiveHit.boneIndex, bone.name, 'center', info.world)
  }
  const skeleton = scene.runtime.skeleton
  const parentWorld = parent >= 0 ? skeleton.world.slice(parent * 16, parent * 16 + 16) : null
  drag = {
    ...IDLE,
    kind: 'bone-translate',
    bone: bone.name,
    bones: collectDragBones(host, bone.name),
    origin,
    parentWorld,
    startPointerLocal: parentWorld ? mulPoint(invert(parentWorld), info.world) : { x: info.world.x, y: info.world.y },
    startDistance: Math.max(1e-4, Math.hypot(info.world.x - origin.x, info.world.y - origin.y))
  }
  storeHandler.begin('移动骨骼')
  const suffix = host.mode === 'animate' ? '（写入关键帧）' : '（修改 setup）'
  host.status(`移动骨骼「${bone.name}」${suffix} · 拖动骨骼原点圆圈`)
  return true
}

/**
 * 轴向缩放倍数：抓取点到轴心的投影距离之比。
 * 允许拖过轴心变成负值（= 镜像翻转），但不允许停在 0 附近（骨骼会退化成看不见）。
 */
function axisFactor(current: number, start: number): number {
  if (Math.abs(start) < 1e-4) return 1
  const raw = current / start
  if (Math.abs(raw) < 0.02) return raw < 0 ? -0.02 : 0.02
  return raw
}

/** 骨骼锁定时不允许通过小坐标轴改动（返回 false 表示被拦下） */
function boneLocked(name: string): boolean {
  const bone = useProjectStore.getState().document.bones.find((item) => item.name === name)
  return bone?.locked === true
}

/**
 * 插槽是否锁定：锁上后**视口里点不中它**（附件 / 显示都不可选、不可拖）。
 * 层级树里仍然可以选中 / 改属性 / 解锁 —— 锁的只是「在视口里随手点选」这条路。
 */
export function slotLocked(name: string): boolean {
  const slot = useProjectStore.getState().document.slots.find((item) => item.name === name)
  return slot?.locked === true
}

/**
 * 把角度差收进 (-180, 180]。
 *
 * `atan2` 的返回值在 ±180° 处断开：指针从 170° 划到 −170°（实际是 +20°）直接相减会得到 −340°。
 * 逐帧取增量时先过一遍这里，旋转就不会在跨越那条线时突然倒转一大圈。
 */
export function wrapDegrees(degrees: number): number {
  return ((degrees % 360) + 540) % 360 - 180
}

/** 收集这次拖拽要一起改的骨骼：当前选中集合（锁定 / 找不到的剔除）+ 按下的这根 */
function collectDragBones(host: ToolHost, boneName: string): MultiBoneStart[] {
  const bundle = host.scene.runtime
  if (!bundle) return []
  const skeleton = bundle.skeleton
  // 直接读 store：视口按下时可能刚把点击的骨骼选上，host 里的 selection 是按下那一刻的快照
  const current = useSelectionStore.getState()
  const selected = current.kind === 'bone' ? current.bones : []
  // 按下的那根一定参与（视口里点骨骼体会先把它选上，但保险起见再兜一次）
  const names = selected.includes(boneName) ? selected : [...selected, boneName]

  const out: MultiBoneStart[] = []
  for (const name of names) {
    const index = bundle.boneIndex[name] ?? -1
    if (index < 0 || boneLocked(name)) continue
    out.push({
      name,
      rot: skeleton.localRot[index],
      pos: { x: skeleton.localPos[index * 2], y: skeleton.localPos[index * 2 + 1] },
      scale: { x: skeleton.localScale[index * 2], y: skeleton.localScale[index * 2 + 1] },
      shear: { x: skeleton.localShear[index * 2], y: skeleton.localShear[index * 2 + 1] }
    })
  }
  return out
}

/**
 * 按下小坐标轴：记录按下时的骨骼本地值（位移 / 旋转 / 缩放 / 斜切）与轴向，
 * 之后每次移动都以**按下时的值**为基准重算，避免增量累积误差。
 */
function beginGizmoDrag(
  host: ToolHost,
  boneIndex: number,
  boneName: string,
  part: GizmoPart,
  world: Vec2
): boolean {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle) return true
  if (boneLocked(boneName)) {
    host.status(`骨骼「${boneName}」已锁定，先解锁再编辑`)
    return true
  }
  const bone = bundle.asset.bones[boneIndex]
  const skeleton = bundle.skeleton
  const geometry = gizmoGeometry(skeleton, boneIndex, 0)
  if (!bone || !geometry) return true

  const origin: Vec2 = { x: geometry.ox, y: geometry.oy }
  const mode = host.tools.gizmo
  const axisVector = part === 'y' ? { x: geometry.px, y: geometry.py } : { x: geometry.dx, y: geometry.dy }
  const parent = bone.parentIndex
  const startLocal = {
    pos: { x: skeleton.localPos[boneIndex * 2], y: skeleton.localPos[boneIndex * 2 + 1] },
    rot: skeleton.localRot[boneIndex],
    scale: { x: skeleton.localScale[boneIndex * 2], y: skeleton.localScale[boneIndex * 2 + 1] },
    shear: { x: skeleton.localShear[boneIndex * 2], y: skeleton.localShear[boneIndex * 2 + 1] }
  }
  // 局部轴向（父空间）：与 core/math/fk.ts 的约定一致 —— X 轴角 = rot + shearX，Y 轴角 = rot + 90 + shearY
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180
  const xAngle = toRad(startLocal.rot + startLocal.shear.x)
  const yAngle = toRad(startLocal.rot + 90 + startLocal.shear.y)
  /** 指针在父骨骼局部空间的按下位置（平移用；根骨骼没有父矩阵，就是世界坐标） */
  const parentWorld = parent >= 0 ? skeleton.world.slice(parent * 16, parent * 16 + 16) : null
  const startPointerLocal = parentWorld ? mulPoint(invert(parentWorld), world) : { x: world.x, y: world.y }
  const bones = collectDragBones(host, boneName)
  /*
   * 旋转基准角 = 按下时指针相对**骨骼原点**的角度，在父空间里量（与骨骼本地旋转同一个空间）。
   * 之后每帧只累计「这一帧转了多少」→ 抓着旋转圈任意位置按下，骨骼都不会先跳一下。
   */
  const startAngle =
    Math.atan2(startPointerLocal.y - startLocal.pos.y, startPointerLocal.x - startLocal.pos.x) *
    (180 / Math.PI)
  drag = {
    ...IDLE,
    kind: 'gizmo',
    bone: boneName,
    bones,
    lastAngle: startAngle,
    origin,
    gizmoMode: mode,
    gizmoPart: part,
    startLocal,
    parentWorld,
    localAxisX: { x: Math.cos(xAngle), y: Math.sin(xAngle) },
    localAxisY: { x: Math.cos(yAngle), y: Math.sin(yAngle) },
    startPointerLocal,
    startDistance: Math.max(1e-4, Math.hypot(world.x - origin.x, world.y - origin.y)),
    startProject: (world.x - origin.x) * axisVector.x + (world.y - origin.y) * axisVector.y,
    axisDir: { x: geometry.dx, y: geometry.dy },
    axisPerp: { x: geometry.px, y: geometry.py },
    startScale: { x: skeleton.localScale[boneIndex * 2], y: skeleton.localScale[boneIndex * 2 + 1] },
    scaleAxis: part === 'center' ? 'both' : part
  }
  const label = GIZMO_LABEL[mode]
  storeHandler.begin(label)
  const suffix = host.mode === 'animate' ? '（写入关键帧）' : '（修改 setup）'
  const partLabel = part === 'center' ? '整体' : `${part.toUpperCase()} 轴`
  const together = bones.length > 1 ? `（同时作用于 ${bones.length} 根选中骨骼）` : ''
  host.status(`${label}骨骼「${boneName}」${suffix} · ${partLabel}${together}`)
  return true
}

/**
 * 按下斜切包围盒的某条边：记录按下时的骨骼本地值、包围盒（该边的坐标）与指针位置。
 *
 * 斜切量的推导（父空间里，局部轴角 = rot + shearX / rot + 90 + shearY）：
 * - 拖「上/下边」横向移动 Δ → 点 (0, h) 的横向位移 = -h·sin(shearY) → shearY = -Δ/h
 * - 拖「左/右边」纵向移动 Δ → 点 (w, 0) 的纵向位移 =  w·sin(shearX) → shearX =  Δ/w
 * 所以被拖的那条边会 1:1 跟着指针走，符合"拉框"的直觉。
 */
function beginShearBoxDrag(host: ToolHost, boneName: string, edge: ShearEdge, world: Vec2): boolean {
  const scene = host.scene
  const bundle = scene.runtime
  const box = scene.shearBoxAt()
  if (!bundle || !box) return false
  const boneIndex = bundle.boneIndex[boneName] ?? -1
  if (boneIndex < 0) return false
  const bone = bundle.asset.bones[boneIndex]
  const skeleton = bundle.skeleton
  const parent = bone.parentIndex
  const startLocal = {
    pos: { x: skeleton.localPos[boneIndex * 2], y: skeleton.localPos[boneIndex * 2 + 1] },
    rot: skeleton.localRot[boneIndex],
    scale: { x: skeleton.localScale[boneIndex * 2], y: skeleton.localScale[boneIndex * 2 + 1] },
    shear: { x: skeleton.localShear[boneIndex * 2], y: skeleton.localShear[boneIndex * 2 + 1] }
  }
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180
  const xAngle = toRad(startLocal.rot + startLocal.shear.x)
  const yAngle = toRad(startLocal.rot + 90 + startLocal.shear.y)
  const parentWorld = parent >= 0 ? skeleton.world.slice(parent * 16, parent * 16 + 16) : null
  const bones = collectDragBones(host, boneName)
  drag = {
    ...IDLE,
    kind: 'shear-box',
    bone: boneName,
    bones,
    origin: { x: box.corners[0].x, y: box.corners[0].y },
    startLocal,
    parentWorld,
    localAxisX: { x: Math.cos(xAngle), y: Math.sin(xAngle) },
    localAxisY: { x: Math.cos(yAngle), y: Math.sin(yAngle) },
    startPointerLocal: parentWorld ? mulPoint(invert(parentWorld), world) : { x: world.x, y: world.y },
    shearEdge: edge,
    shearBox: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }
  }
  storeHandler.begin('斜切骨骼')
  const suffix = host.mode === 'animate' ? '（写入关键帧）' : '（修改 setup）'
  const edgeLabel = edge === 'top' ? '上边' : edge === 'bottom' ? '下边' : edge === 'left' ? '左边' : '右边'
  const together = bones.length > 1 ? `（同时作用于 ${bones.length} 根选中骨骼）` : ''
  host.status(`斜切骨骼「${boneName}」${suffix} · 拖动包围盒${edgeLabel}${together}`)
  return true
}

/** 斜切包围盒拖拽：按被拖的边把位移折算成 shearX / shearY（度） */
function dragShearBox(host: ToolHost, world: Vec2): void {
  const scene = host.scene
  const box = drag.shearBox
  if (!box) return
  const animation = host.mode === 'animate' ? currentAnimationName(host) : null
  const pointerLocal = drag.parentWorld ? mulPoint(invert(drag.parentWorld), world) : { x: world.x, y: world.y }
  const moved = {
    x: pointerLocal.x - drag.startPointerLocal.x,
    y: pointerLocal.y - drag.startPointerLocal.y
  }
  const next = { x: drag.startLocal.shear.x, y: drag.startLocal.shear.y }

  // 分母下限 24px：包围盒很扁时（比如一条肢体）不能让灵敏度爆炸
  const minScale = scene.viewport.pixelsToWorld(24)
  if (drag.shearEdge === 'left' || drag.shearEdge === 'right') {
    // 左右边纵向拖动 → 掰 X 轴（分母是该边的局部 x，符号自带方向）
    const edgeX = drag.shearEdge === 'right' ? box.maxX : box.minX
    const along = moved.x * drag.localAxisY.x + moved.y * drag.localAxisY.y
    const denominator = Math.max(Math.abs(edgeX), minScale) * (edgeX < 0 ? -1 : 1)
    next.x = clampShear(drag.startLocal.shear.x + (along / denominator) * RAD2DEG)
  } else {
    // 上下边横向拖动 → 掰 Y 轴
    const edgeY = drag.shearEdge === 'top' ? box.maxY : box.minY
    const along = moved.x * drag.localAxisX.x + moved.y * drag.localAxisX.y
    const denominator = Math.max(Math.abs(edgeY), minScale) * (edgeY < 0 ? -1 : 1)
    next.y = clampShear(drag.startLocal.shear.y - (along / denominator) * RAD2DEG)
  }

  // 被拖那根的增量（度）：每根选中骨骼各自加到自己的起始斜切上（各自夹在 ±85° 内）
  const delta = { x: next.x - drag.startLocal.shear.x, y: next.y - drag.startLocal.shear.y }
  useProjectStore.getState().updateSilent((draft) => {
    for (const item of drag.bones) {
      writeBoneValue(draft, animation, host.time, item.name, 'shear', {
        x: clampShear(item.shear.x + delta.x),
        y: clampShear(item.shear.y + delta.y)
      })
    }
  })
  const after = useProjectStore.getState()
  scene.setDocument(after.document, host.selection.skin)
  scene.refresh()
}

/**
 * 斜切上限 ±85°：再往上两根局部轴会重合（矩阵退化，骨骼被压成一条线），
 * 而且在手感上也没有意义。超过就停在边界，保持单调不翻面。
 */
function clampShear(degrees: number): number {
  return Math.max(-85, Math.min(85, degrees))
}

const GIZMO_LABEL: Record<GizmoMode, string> = {
  move: '移动',
  rotate: '旋转',
  scale: '缩放',
  shear: '斜切'
}

/** 小坐标轴拖拽：按模式与轴向写入骨骼本地值 */
function dragGizmo(host: ToolHost, world: Vec2): void {
  const scene = host.scene
  if (!scene.runtime) return
  const store = useProjectStore.getState()
  const animation = host.mode === 'animate' ? currentAnimationName(host) : null
  const { gizmoMode: mode, gizmoPart: part } = drag
  const rx = world.x - drag.origin.x
  const ry = world.y - drag.origin.y
  // 指针在父骨骼局部空间的位置，以及相对**按下点**的位移
  // （父空间：位移与旋转都存这个空间；根骨骼没有父矩阵，就是世界坐标）
  const pointerLocal = drag.parentWorld ? mulPoint(invert(drag.parentWorld), world) : { x: world.x, y: world.y }
  const moved = {
    x: pointerLocal.x - drag.startPointerLocal.x,
    y: pointerLocal.y - drag.startPointerLocal.y
  }

  if (mode === 'rotate') {
    /*
     * 旋转按**指针绕骨骼原点的角度变化**加减，不是「指到哪就转到哪」：
     * 每帧只累计这一帧转过的角度（`wrapDegrees` 修掉 atan2 的 ±180° 回绕），
     * 每根选中骨骼各自在**自己按下时的旋转**上加这个增量 —— 抓在旋转圈任意位置按下都不会先跳一下，
     * 连续转好几圈也不会被打断，每一度都由鼠标实际划过的弧决定。
     *
     * 增量在**父空间**里量（与骨骼本地旋转同一个空间），所以写进每根骨骼的本地值是对得上的。
     */
    const angle =
      Math.atan2(pointerLocal.y - drag.startLocal.pos.y, pointerLocal.x - drag.startLocal.pos.x) *
      (180 / Math.PI)
    drag.sweep += wrapDegrees(angle - drag.lastAngle)
    drag.lastAngle = angle
    store.updateSilent((draft) => {
      for (const item of drag.bones) {
        writeBoneValue(draft, animation, host.time, item.name, 'rotate', item.rot + drag.sweep)
      }
    })
  } else if (mode === 'move') {
    // 位移存在**父骨骼局部空间**里，位移量相对按下点算（否则骨骼会先跳到指针底下）
    // 拖 X 轴 = 沿骨骼方向平移，拖 Y 轴 = 沿垂直方向平移，拖中心 = 自由平移
    const start = drag.startLocal.pos
    let next = { x: start.x + moved.x, y: start.y + moved.y }
    if (part !== 'center') {
      // 只保留沿该轴的分量：拖 X 轴就只沿骨骼方向走，Y 方向完全不动
      const axis = part === 'y' ? drag.localAxisY : drag.localAxisX
      const along = moved.x * axis.x + moved.y * axis.y
      next = { x: start.x + axis.x * along, y: start.y + axis.y * along }
    }
    // 多选：同一个位移增量（按下那根骨骼父空间里的位移）加到每根选中骨骼各自的本地位置上
    const delta = { x: next.x - start.x, y: next.y - start.y }
    store.updateSilent((draft) => {
      for (const item of drag.bones) {
        writeBoneValue(draft, animation, host.time, item.name, 'translate', {
          x: item.pos.x + delta.x,
          y: item.pos.y + delta.y
        })
      }
    })
  } else {
    // 缩放（斜切不走小坐标轴，由包围盒拖拽 dragShearBox 处理）
    // 各轴**因子**对所有选中骨骼是同一个，乘到每根自己按下时的缩放上（缩放是局部量）
    let factorX = 1
    let factorY = 1
    if (part === 'x') {
      factorX = axisFactor(rx * drag.axisDir.x + ry * drag.axisDir.y, drag.startProject)
    } else if (part === 'y') {
      factorY = axisFactor(rx * drag.axisPerp.x + ry * drag.axisPerp.y, drag.startProject)
    } else {
      factorX = axisFactor(Math.hypot(rx, ry), drag.startDistance)
      factorY = factorX
    }
    store.updateSilent((draft) => {
      for (const item of drag.bones) {
        writeBoneValue(draft, animation, host.time, item.name, 'scale', {
          x: item.scale.x * factorX,
          y: item.scale.y * factorY
        })
      }
    })
  }

  const after = useProjectStore.getState()
  scene.setDocument(after.document, host.selection.skin)
  scene.refresh()
}

/**
 * 按下附件操作器：记录按下时的 setup 值（position / rotation / scale）与被拖轴，
 * 之后每次移动都以**按下时的值**为基准重算（与骨骼 gizmo 一致，避免增量累积误差）。
 */
function beginAttachmentGizmoDrag(
  host: ToolHost,
  slotName: string,
  attachmentName: string,
  part: GizmoPart,
  mode: GizmoMode,
  world: Vec2
): boolean {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle) return false
  // 插槽锁定 = 视口里不可选中 / 不可拖（与骨骼锁一致：拦下并说明原因）
  if (slotLocked(slotName)) {
    host.status(`插槽「${slotName}」已锁定：在层级树里解锁后才能拖动`)
    return true
  }
  const doc = useProjectStore.getState().document
  const slot = doc.slots.find((item) => item.name === slotName)
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!slot || !attachment) return false
  const boneIndex = bundle.boneIndex[slot.bone] ?? -1
  if (boneIndex < 0) return false

  const frame = attachmentGizmoFrame(
    bundle.skeleton,
    boneIndex,
    attachment.position,
    attachment.rotation,
    scene.viewport.pixelsToWorld(GIZMO_AXIS_LENGTH)
  )
  if (!frame) return false

  const radians = (attachment.rotation * Math.PI) / 180
  // 被拖轴在**骨骼局部空间**的单位方向（position 就存在这个空间里）
  const axisLocal =
    part === 'y'
      ? { x: -Math.sin(radians), y: Math.cos(radians) }
      : { x: Math.cos(radians), y: Math.sin(radians) }
  // 同一轴的世界方向 + 该方向上的综合缩放（把世界距离换算回局部距离）
  const axisWorld = part === 'y' ? { x: frame.px, y: frame.py } : { x: frame.dx, y: frame.dy }
  const axisScale = part === 'y' ? frame.axisScaleB : frame.axisScaleA

  drag = {
    ...IDLE,
    kind: 'attachment',
    slot: slotName,
    attachment: attachmentName,
    origin: { x: frame.ox, y: frame.oy },
    startWorld: { ...world },
    gizmoMode: mode,
    gizmoPart: part,
    attBoneIndex: boneIndex,
    attStart: {
      position: { ...attachment.position },
      rotation: attachment.rotation,
      scale: { ...attachment.scale }
    },
    attAxisLocal: axisLocal,
    attAxisWorld: axisWorld,
    attAxisScale: Math.max(1e-6, axisScale),
    attStartAngle: (Math.atan2(world.y - frame.oy, world.x - frame.ox) * 180) / Math.PI,
    startProject: (world.x - frame.ox) * axisWorld.x + (world.y - frame.oy) * axisWorld.y,
    startDistance: Math.hypot(world.x - frame.ox, world.y - frame.oy)
  }
  storeHandler.begin(mode === 'rotate' ? '旋转附件' : mode === 'scale' ? '缩放附件' : '移动附件')
  return true
}

/** 附件操作器拖拽：把指针变化写回附件的 setup 值（position / rotation / scale，相对宿主骨骼） */
function dragAttachmentGizmo(host: ToolHost, world: Vec2): void {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle) return
  const rx = world.x - drag.origin.x
  const ry = world.y - drag.origin.y
  const mode = drag.gizmoMode
  const part = drag.gizmoPart
  const start = drag.attStart

  let position = start.position
  let rotation = start.rotation
  let scale = start.scale

  if (mode === 'rotate') {
    const angle = (Math.atan2(ry, rx) * 180) / Math.PI
    rotation = start.rotation + (angle - drag.attStartAngle)
  } else if (mode === 'scale') {
    scale = { x: start.scale.x, y: start.scale.y }
    const project = rx * drag.attAxisWorld.x + ry * drag.attAxisWorld.y
    if (part === 'x') {
      scale.x = start.scale.x * axisFactor(project, drag.startProject)
    } else if (part === 'y') {
      scale.y = start.scale.y * axisFactor(project, drag.startProject)
    } else {
      const factor = axisFactor(Math.hypot(rx, ry), drag.startDistance)
      scale.x = start.scale.x * factor
      scale.y = start.scale.y * factor
    }
  } else {
    // 位置存在**宿主骨骼局部空间**里；拖中心 = 自由移动，拖轴 = 只沿该轴
    const boneWorld = bundle.skeleton.world.slice(drag.attBoneIndex * 16, drag.attBoneIndex * 16 + 16)
    if (part === 'center') {
      const delta = mulVector(invert(boneWorld), {
        x: world.x - drag.startWorld.x,
        y: world.y - drag.startWorld.y
      })
      position = { x: start.position.x + delta.x, y: start.position.y + delta.y }
    } else {
      const project = rx * drag.attAxisWorld.x + ry * drag.attAxisWorld.y
      const along = (project - drag.startProject) / drag.attAxisScale
      position = {
        x: start.position.x + drag.attAxisLocal.x * along,
        y: start.position.y + drag.attAxisLocal.y * along
      }
    }
  }

  useProjectStore.getState().updateSilent((draft) => {
    patchAttachment(draft, drag.slot, drag.attachment, (attachment) => {
      attachment.position = position
      attachment.rotation = rotation
      attachment.scale = scale
    })
  })
  const after = useProjectStore.getState()
  scene.setDocument(after.document, host.selection.skin)
  scene.refresh()
}

/*
 * ─────────────────── Pose 工具拖骨骼：让蒙皮跟着骨骼走 ───────────────────
 *
 * 背景：本工程的绑定是**每次编辑骨骼后用当前 setup 反算**的（compile.ts：
 * `vBind = setupWorld[slotBone] · TRS(att) · v`、`L_k = inverse(setupWorld[b_k]) · vBind`），
 * 骨骼一动绑定跟着变，网格被**锁在世界坐标上**（实测：拖 spear3 位移 0.4，网格位移 0）。
 * 那套语义适合「改骨架但别动美术」；Pose 工具要的是反过来的效果。
 *
 * 做法：拖拽期间把受影响网格的顶点按骨骼世界增量重新落位（烘焙进绑定网格），
 * 于是渲染跟着骨骼走，而文档依然自洽（绑定网格与新的骨骼姿态匹配，可撤销、可导出）。
 *
 * 每个顶点的落位（与运行期蒙皮的线性混合一致）：
 *   bind  = LOCAL_old · v                    // 拖拽开始时的世界位置
 *   moved = lerp(bind, Δ · bind, w)          // w = 顶点落在被拖骨骼**子树**上的权重和
 *   v'    = inv(LOCAL_new) · moved           // 换回附件局部空间
 * 其中 Δ = Wnew[B] · inv(Wold[B])、LOCAL = W[slotBone] · TRS(att)。
 * w=0 的顶点一点不动，w=1 的随骨骼刚性移动，中间按权重插值。
 */

interface CarryMesh {
  slot: string
  attachment: string
  /** 插槽宿主骨骼下标（LOCAL 用它） */
  slotBoneIndex: number
  /** 拖拽开始时的顶点（每次移动都从它重算，避免误差累积） */
  vertices: Vec2[]
  /** 每个顶点在被拖骨骼子树上的权重和 */
  weights: number[]
}

interface CarrySession {
  /**
   * 归属的拖拽会话（用 `drag` **对象身份**比较）。
   *
   * 不能用 `drag.startWorld` 之类字段当令牌：那些字段来自 `{...IDLE}` 展开，
   * 对原点圈拖拽是**共享引用**，令牌永远相等 → 快照永不刷新，第二段拖拽会沿用
   * 第一段的 world 基线，把两次位移累积到同一次落位里（实测 0.3 的拖拽落成 0.7）。
   * `drag` 本身每段拖拽都是新对象（`drag = {...IDLE, ...}`），身份可靠。
   */
  token: DragSession
  boneIndex: number
  worldBefore: Float32Array
  meshes: CarryMesh[]
}

let carry: CarrySession | null = null

/** 该骨骼（或其祖先）是否是被拖骨骼 —— 子树里的骨骼刚性跟随，世界增量相同 */
function inBoneSubtree(
  bones: ReadonlyArray<{ parentIndex: number }>,
  index: number,
  root: number
): boolean {
  let current = index
  for (let guard = 0; guard < bones.length; guard++) {
    if (current === root) return true
    if (current < 0 || current >= bones.length) return false
    current = bones[current].parentIndex
  }
  return false
}

/** 拖拽开始时抓一份快照：会被骨骼带动的网格 + 它们的原始顶点与权重和 */
function beginCarry(host: ToolHost, boneName: string, token: DragSession): CarrySession | null {
  const bundle = host.scene.runtime
  if (!bundle) return null
  const root = bundle.boneIndex[boneName]
  if (root === undefined) return null
  const bones = bundle.asset.bones
  const doc = useProjectStore.getState().document
  const meshes: CarryMesh[] = []

  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      const slotIndex = bundle.slotIndex[skinSlot.slot] ?? -1
      if (slotIndex < 0) continue
      const slotBoneIndex = bundle.asset.slots[slotIndex]?.boneIndex ?? -1
      for (const attachment of skinSlot.attachments) {
        if (attachment.vertices.length === 0) continue
        const weights: number[] = []
        let affected = false
        for (const vertex of attachment.vertices) {
          let sum = 0
          for (const weight of vertex.weights) {
            const index = bundle.boneIndex[weight.bone]
            if (index === undefined) continue
            if (inBoneSubtree(bones, index, root)) sum += weight.weight
          }
          weights.push(sum)
          if (sum > 1e-6) affected = true
        }
        if (!affected) continue
        meshes.push({
          slot: skinSlot.slot,
          attachment: attachment.name,
          slotBoneIndex,
          vertices: attachment.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
          weights
        })
      }
    }
  }
  if (meshes.length === 0) return null
  return { token, boneIndex: root, worldBefore: Float32Array.from(bundle.skeleton.world), meshes }
}

/** 按当前骨骼姿态重算网格顶点（每次移动都从快照重算，幂等） */
function applyCarry(host: ToolHost): void {
  const session = carry
  const bundle = host.scene.runtime
  if (!session || !bundle) return
  const world = bundle.skeleton.world
  if (world.length !== session.worldBefore.length) return

  const slice = (buffer: Float32Array, index: number): Float32Array =>
    buffer.subarray(index * 16, index * 16 + 16)
  const invWoldRoot = invert(slice(session.worldBefore, session.boneIndex))

  // 先算，确认真有变化再写 —— 免得每帧都触发一次文档更新 + 重编译
  const updates: Array<{ slot: string; attachment: string; positions: Vec2[] }> = []
  for (const mesh of session.meshes) {
    const attachments = []
    for (const skin of useProjectStore.getState().document.skins) {
      const found = skin.slots.find((item) => item.slot === mesh.slot)
      if (found) attachments.push(...found.attachments)
    }
    const attachment = attachments.find((item) => item.name === mesh.attachment)
    if (!attachment) continue
    const attTrs = trs(
      attachment.position.x,
      attachment.position.y,
      attachment.rotation,
      attachment.scale.x,
      attachment.scale.y
    )
    const invAttTrs = invert(attTrs)
    const oldLocal = slice(session.worldBefore, mesh.slotBoneIndex)
    const newLocal = slice(world, mesh.slotBoneIndex)
    const invWnewRoot = invert(slice(world, mesh.slotBoneIndex))

    const positions: Vec2[] = []
    let changed = false
    attachment.vertices.forEach((vertex, i) => {
      const w = mesh.weights[i] ?? 0
      const source = mesh.vertices[i]
      if (w <= 1e-6 || !source) {
        positions.push({ x: vertex.x, y: vertex.y })
        return
      }
      // bind = LOCAL_old · v
      const bind = mulPoint(oldLocal, mulPoint(attTrs, source))
      // Δ · bind = Wnew[B] · inv(Wold[B]) · bind
      const moved = mulPoint(slice(world, session.boneIndex), mulPoint(invWoldRoot, bind))
      const mixed = { x: bind.x + (moved.x - bind.x) * w, y: bind.y + (moved.y - bind.y) * w }
      // v' = inv(LOCAL_new) · mixed
      const next = mulPoint(invAttTrs, mulPoint(invWnewRoot, mixed))
      if (Math.abs(next.x - vertex.x) > 1e-7 || Math.abs(next.y - vertex.y) > 1e-7) changed = true
      positions.push(next)
    })
    if (changed) updates.push({ slot: mesh.slot, attachment: mesh.attachment, positions })
  }
  if (updates.length === 0) return

  const store = useProjectStore.getState()
  store.updateSilent((draft) => {
    for (const update of updates) {
      const attachment = findAttachment(draft, update.slot, update.attachment)
      if (!attachment) continue
      attachment.vertices.forEach((vertex, i) => {
        const next = update.positions[i]
        if (!next) return
        vertex.x = next.x
        vertex.y = next.y
      })
    }
  })
  host.scene.setDocument(store.document, host.selection.skin)
  host.scene.refresh()
}

/** 骨头拖拽（含子树的刚性跟随）才需要「网格跟随」；其它拖拽一律清掉快照 */
function beginCarryIfNeeded(host: ToolHost): void {
  const isBoneDrag = drag.kind === 'gizmo' || drag.kind === 'bone-translate' || drag.kind === 'shear-box'
  if (!isBoneDrag || host.tools.tool !== 'pose' || !drag.bone) {
    carry = null
    return
  }
  if (carry && carry.token === drag) return
  carry = beginCarry(host, drag.bone, drag)
}

export function toolPointerMove(host: ToolHost, info: PointerInfo): void {
  if (drag.kind === 'none') return
  drag.moved = true
  // 顺序很关键：先按拖拽开始时的姿态抓快照，再应用这次移动，最后按新姿态落位网格
  beginCarryIfNeeded(host)
  moveActiveDrag(host, info)
  applyCarry(host)
}

/** 拖拽分发（从 toolPointerMove 拆出来，好让「网格跟随」在前后统一处理） */
function moveActiveDrag(host: ToolHost, info: PointerInfo): void {
  // 自定义布线：只拖一条橡皮筋，不动任何几何
  if (drag.kind === 'mesh-rewire') {
    rewireDragMove(host, info.world)
    return
  }

  if (drag.kind === 'paint') {
    /*
     * 按**移动距离**节流：不足 2 屏幕像素就不再叠加。
     * 不节流时叠加次数取决于鼠标事件频率 —— 慢慢挪会反复叠同一片、飞快划过只叠一两次，
     * 同一段手势手感随速度飘。官方的刷子是「走到哪刷到哪」，与速度无关。
     * 首次移动（按下后的第一下）不节流，保证点住拖一下就有反馈。
     */
    if (drag.paintStarted) {
      const step = host.scene.viewport.pixelsToWorld(2)
      const moved = Math.hypot(info.world.x - drag.lastPaint.x, info.world.y - drag.lastPaint.y)
      if (moved < step) return
    } else {
      // 撤销事务在**第一次真正开刷**时才开：单击只是选中顶点看权重，不该留下空的撤销记录
      drag.paintStarted = true
      storeHandler.begin('权重刷')
    }
    drag.lastPaint = { ...info.world }
    paintAt(host, info.world)
    return
  }

  if (drag.kind === 'bone-create') {
    // 收笔同样吸端点：拖到目标骨骼的根端 / 末端时精确对接（端点优先于轴线投影）
    const end = snapToBoneEndpoint(host, info.world)?.point ?? snapToBoneAxis(host, info.world)
    drag.createEnd = end
    /*
     * 鼠标下的插槽：用与**选择工具悬停**同一套拾取（`pickAttachmentAt` + `hoveredDisplay`），
     * 一眼看出「松手后哪个插槽会挂到新骨骼下面」。锁定的插槽按点不中处理（不高亮、不带过来）。
     */
    const under = host.scene.pickAttachmentAt(info.world.x, info.world.y)
    const target = under && !slotLocked(under.slot) ? under : null
    drag.createTargetSlot = target ? target.slot : ''
    host.scene.setViewState({
      pendingBone: { x1: drag.createStart.x, y1: drag.createStart.y, x2: end.x, y2: end.y },
      hoveredDisplay: target
    })
    host.scene.markDirty()
    return
  }

  if (drag.kind === 'vertex') {
    dragVertex(host, info.world)
    return
  }

  if (drag.kind === 'gizmo') {
    dragGizmo(host, info.world)
    return
  }

  if (drag.kind === 'attachment') {
    dragAttachmentGizmo(host, info.world)
    return
  }

  if (drag.kind === 'shear-box') {
    dragShearBox(host, info.world)
    return
  }

  // 剩下只有「拖原点圈移动骨骼」这一种直接拖拽（旋转/缩放/斜切都走小坐标轴）
  const scene = host.scene
  if (!scene.runtime) return
  const store = useProjectStore.getState()
  const animation = host.mode === 'animate' ? currentAnimationName(host) : null
  const skeleton = scene.runtime.skeleton
  const bone = scene.runtime.asset.bones.find((item) => item.name === drag.bone)
  if (!bone) return
  const parentOffset = bone.parentIndex * 16
  const local = bone.parentIndex >= 0
    ? mulPoint(invert(skeleton.world.slice(parentOffset, parentOffset + 16)), info.world)
    : info.world
  // 多选：同一个位移增量（按下那根骨骼父空间里的位移）加到每根选中骨骼各自的本地位置上
  const delta = { x: local.x - drag.startPointerLocal.x, y: local.y - drag.startPointerLocal.y }
  store.updateSilent((draft) => {
    for (const item of drag.bones) {
      writeBoneValue(draft, animation, host.time, item.name, 'translate', {
        x: item.pos.x + delta.x,
        y: item.pos.y + delta.y
      })
    }
  })

  scene.setDocument(store.document, host.selection.skin)
  scene.refresh()
}

export function toolPointerUp(host: ToolHost): void {
  // 自定义布线：松开即连线（落在同一个顶点上等于没连，会报一声）
  if (drag.kind === 'mesh-rewire') {
    const session = drag
    drag = { ...IDLE }
    rewireDragEnd(host, session)
    return
  }

  // 画骨骼：松开即生成（长度 / 角度按拖拽的两点算），并把新骨骼选中，方便接着拖下一根
  if (drag.kind === 'bone-create') {
    const session = drag
    drag = { ...IDLE }
    // 预览与插槽高亮一起收掉；鼠标下的插槽（若没被锁）随后挂到新骨骼下
    host.scene.setViewState({ pendingBone: null, hoveredDisplay: null })
    storeHandler.end()
    createBoneFromDrag(
      host,
      session.createStart,
      session.createEnd,
      session.createParent,
      session.createTargetSlot
    )
    return
  }

  if (drag.kind !== 'none') {
    storeHandler.end()
    if (drag.moved && drag.kind !== 'paint') {
      const store = useProjectStore.getState()
      host.scene.setDocument(store.document, host.selection.skin)
      host.scene.refresh()
    }
  }
  drag = { ...IDLE }
}

/**
 * 端点吸附半径（屏幕像素）。比骨骼体的拾取半径（8px）大不少：
 * 「从上一根的末端接着画」是最常见的意图，值得放宽容错 ——
 * 判定用欧氏距离，斜向偏差（如右下各偏 10px）实际就是 14px，
 * 半径太紧会让「明明点在末端上」的操作失败。
 * 也不宜再大：正常长度的骨骼两端吸附圈不会碰到中部（分支要在中段起笔）。
 */
const BONE_ENDPOINT_SNAP_PIXELS = 20

/**
 * 起笔 / 收笔点靠近任意骨骼的**根端或末端**时，精确吸附到那个端点。
 *
 * 「接着上一根画骨骼链」必须接在**末端那个点**上，只投影到轴线是不够的：
 * 投影点会落在离末端还差鼠标偏移量的地方，链节之间就有肉眼可见的缝；
 * 偏差稍大时（超过骨骼体的拾取半径）更是连「接着画」的父子关系都建不上，退化成挂在根骨骼下。
 */
function snapToBoneEndpoint(
  host: ToolHost,
  world: Vec2
): { point: Vec2; bone: string } | null {
  const bundle = host.scene.runtime
  if (!bundle) return null
  const radius = host.scene.viewport.pixelsToWorld(BONE_ENDPOINT_SNAP_PIXELS)
  const bones = bundle.asset.bones
  let best: { point: Vec2; bone: string; distance: number } | null = null
  for (let index = 0; index < bones.length; index++) {
    const offset = index * 16
    const ox = bundle.skeleton.world[offset + 12]
    const oy = bundle.skeleton.world[offset + 13]
    // 末端 = 原点沿骨骼 x 轴走一个 length（矩阵首列含缩放，直接用即可）
    const points = [
      { x: ox, y: oy },
      { x: ox + bundle.skeleton.world[offset] * bones[index].length, y: oy + bundle.skeleton.world[offset + 1] * bones[index].length }
    ]
    for (const point of points) {
      const distance = Math.hypot(point.x - world.x, point.y - world.y)
      if (distance <= radius && (!best || distance < best.distance)) {
        best = { point, bone: bones[index].name, distance }
      }
    }
  }
  return best ? { point: best.point, bone: best.bone } : null
}

/**
 * 起点落在骨骼上就吸附到它的轴线（把点投影到骨骼线段并夹在两端之间），
 * 这样从某根骨骼身上拉出来的新骨骼一定和它连在一起，而不是浮在旁边的空中。
 */
function snapToBoneAxis(host: ToolHost, world: Vec2): Vec2 {
  const bundle = host.scene.runtime
  if (!bundle) return { ...world }
  const hit = host.scene.pickBoneAt(world.x, world.y)
  if (!hit) return { ...world }
  const offset = hit.boneIndex * 16
  const skeleton = bundle.skeleton
  const ox = skeleton.world[offset + 12]
  const oy = skeleton.world[offset + 13]
  const ax = skeleton.world[offset]
  const ay = skeleton.world[offset + 1]
  const length2 = ax * ax + ay * ay
  if (length2 < 1e-9) return { ...world }
  const t = ((world.x - ox) * ax + (world.y - oy) * ay) / length2
  const clamped = Math.max(0, Math.min(1, t))
  return { x: ox + ax * clamped, y: oy + ay * clamped }
}

/**
 * 新骨骼的父级：**只看起点是否落在某根骨骼上**（「从这根骨骼接着画」的明确意图），
 * 否则挂在层级根骨骼 root 下（`rootBoneName`）—— 其他骨骼都必须待在 root 之下。
 *
 * 空骨架（连 root 都没有）才会返回空串：那时这根新骨骼自己就是后来的顶层根骨骼。
 *
 * 这里**刻意不看当前选中骨骼**：画骨骼工具下选中态不参与建档，
 * 否则「上次选中的骨骼」会静默成为新骨骼的父级，很容易不小心把骨骼挂错地方。
 */
function resolveCreateParent(host: ToolHost, world: Vec2): string {
  const bundle = host.scene.runtime
  const hit = host.scene.pickBoneAt(world.x, world.y)
  if (hit && bundle) {
    const name = bundle.asset.bones[hit.boneIndex]?.name ?? ''
    if (name) return name
  }
  // 运行时骨骼数据不带 parent，找不出层级根 —— 去编辑期模型里找
  return rootBoneName(useProjectStore.getState().document.bones)
}

/**
 * 按拖拽的两点生成骨骼：起点转换成父骨骼局部坐标、长度取两点距离、
 * 角度取连线方向再扣掉父骨骼的世界旋转（对应 inheritRotation / inheritScale 的语义）。
 */
function createBoneFromDrag(
  host: ToolHost,
  start: Vec2,
  end: Vec2,
  parent: string,
  targetSlot = ''
): void {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle) return
  const dx = end.x - start.x
  const dy = end.y - start.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1e-3) {
    host.status('拖动距离太短，未生成骨骼')
    return
  }

  const parentIndex = parent ? bundle.boneIndex[parent] ?? -1 : -1
  const parentRotation = parentIndex >= 0 ? bundle.skeleton.worldRot[parentIndex] : 0
  const parentScale = parentIndex >= 0
    ? Math.hypot(bundle.skeleton.world[parentIndex * 16], bundle.skeleton.world[parentIndex * 16 + 1])
    : 1
  const localStart = parent
    ? scene.worldToBoneLocal(parent, start.x, start.y) ?? { x: start.x, y: start.y }
    : { x: start.x, y: start.y }
  const worldAngle = (Math.atan2(dy, dx) * 180) / Math.PI
  const length = Math.max(0.02, distance / (parentScale > 1e-6 ? parentScale : 1))

  let created = ''
  useProjectStore.getState().update('新建骨骼', (draft) => {
    created = uniqueName(draft.bones.map((item) => item.name), 'bone')
    draft.bones.push(
      createAuthoringBone({
        name: created,
        parent,
        localPosition: localStart,
        rotation: worldAngle - parentRotation,
        length
      })
    )
  })
  if (!created) return

  // 先把新骨骼刷进场景：世界矩阵有了，下面换宿主才能按它换算附件位置
  scene.setDocument(useProjectStore.getState().document, host.selection.skin)
  scene.refresh()

  /*
   * 鼠标下的插槽跟过来：挂到新骨骼下 —— 走的是**层级树拖放插槽的同一套命令**
   *（`moveSlot` + 世界矩阵），插槽里的附件位置会按「旧宿主 → 新宿主」换算一次，
   * 画面上的位置不会因为换骨骼而跳一下。
   */
  let moved = ''
  let note = ''
  if (targetSlot) {
    const check = validateSlotMove(useProjectStore.getState().document, targetSlot, created)
    if (!check.ok) note = ` · ${check.message}`
    else {
      let result: MoveResult = check
      useProjectStore.getState().update('插槽挂到新骨骼', (draft) => {
        result = moveSlot(draft, targetSlot, created, null, {
          worldMatrixOf: (name) => scene.worldMatrixOf(name)
        })
      })
      if (result.ok) moved = targetSlot
      else note = ` · ${result.message}`
    }
  }

  useSelectionStore.getState().selectBone(created)
  scene.setDocument(useProjectStore.getState().document, host.selection.skin)
  scene.refresh()
  host.status(
    `已新建骨骼「${created}」${parent ? `，挂在「${parent}」下` : '（根骨骼）'} · 长度 ${length.toFixed(2)}` +
      (moved ? ` · 插槽「${moved}」已挂到它下面` : note)
  )
}

/**
 * 自动权重（检查器「权重骨骼列表」的按钮调用）：只对**列表里绑定的骨骼**算权重。
 *
 * 按网格上显式绑定的骨骼集合来算 —— 列表外的骨骼不会被算进来，列表内每根都参与竞争
 *（就近者权重高）。骨骼线段按当前姿态取（Pose 态即绑定姿态）。
 */
export function runAutoWeightsForBones(
  host: ToolHost,
  slotName: string,
  attachmentName: string,
  boneNames: readonly string[],
  falloff: number
): number {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle || host.mode !== 'pose' || boneNames.length === 0) return 0
  const samples = samplesFor(host, slotName, attachmentName)
  if (samples.length === 0) return 0

  const segments = boneNames
    .map((name) => ({ name, index: bundle.boneIndex[name] ?? -1 }))
    .filter((item) => item.index >= 0)
    .map((item) => {
      const offset = item.index * 16
      const ox = bundle.skeleton.world[offset + 12]
      const oy = bundle.skeleton.world[offset + 13]
      const length = Math.max(0.001, bundle.asset.bones[item.index].length)
      const angle = (bundle.skeleton.worldRot[item.index] * Math.PI) / 180
      return {
        name: item.name,
        ax: ox,
        ay: oy,
        bx: ox + Math.cos(angle) * length,
        by: oy + Math.sin(angle) * length
      }
    })
  if (segments.length === 0) return 0

  let touched = 0
  useProjectStore.getState().update('自动权重（绑定骨骼）', (draft) => {
    touched = autoWeights(draft, samples, segments, { falloff, maxBones: 4 })
  })
  scene.setDocument(useProjectStore.getState().document, host.selection.skin)
  scene.refresh()
  return touched
}

const storeHandler = {
  begin(label: string): void {
    useProjectStore.getState().beginTransaction(label)
  },
  end(): void {
    useProjectStore.getState().endTransaction()
  }
}

function writeBoneValue(
  draft: EditorDocument,
  animation: string | null,
  time: number,
  bone: string,
  channel: 'rotate' | 'translate' | 'scale' | 'shear',
  value: number | Vec2
): void {
  if (animation) {
    const target = draft.animations.find((item) => item.name === animation)
    if (target) {
      keyBoneChannel(target, bone, channel, time, value)
      return
    }
  }
  const boneData = draft.bones.find((item) => item.name === bone)
  if (!boneData) return
  if (channel === 'rotate') boneData.rotation = typeof value === 'number' ? value : 0
  else if (channel === 'translate' && typeof value !== 'number') {
    boneData.localPosition = { x: value.x, y: value.y }
  } else if (channel === 'scale' && typeof value !== 'number') {
    boneData.localScale = { x: value.x, y: value.y }
  } else if (channel === 'shear' && typeof value !== 'number') {
    boneData.localShear = { x: value.x, y: value.y }
  }
}

function currentAnimationName(host: ToolHost): string | null {
  const name = host.scene.currentAnimation
  return name
}

function paintAt(host: ToolHost, world: Vec2): void {
  /*
   * 只刷**选中的那个附件**（与官方工具「刷选中的网格」一致）。
   * `anySlot` 传 false：附件对不上就一个顶点都不取 —— 原来没选附件时会把整个角色的顶点
   * 都刷上，等于在看不见的地方改了数据。
   */
  const samples = samplesFor(host, host.selection.slot, host.selection.attachment, false)
  if (samples.length === 0) return
  const brush = host.tools.brush
  let touched = 0
  useProjectStore.getState().updateSilent((draft) => {
    touched = paintWeights(
      draft,
      samples,
      drag.bone,
      world,
      brush.size / 100,
      brush.hardness / 100,
      drag.paintMode,
      brush.normalize
    )
  })
  if (touched === 0) return
  const store = useProjectStore.getState()
  host.scene.setDocument(store.document, host.selection.skin)
  host.scene.refresh()
  // 平滑动的是「全部骨骼」的权重，说刷某根骨骼会误导
  host.status(
    drag.paintMode === 'smooth'
      ? `已平滑 ${touched} 个顶点的权重`
      : `已为 ${touched} 个顶点刷上「${drag.bone}」的权重`
  )
}

/**
 * 为「Pose 态拖动网格内部顶点」准备 UV 重算场：用该顶点**邻居**的
 * （附件空间位置 → UV）对应关系，拟合出这块网格原来的位置→UV 映射。
 *
 * 返回 null 表示不该重算 UV：边缘顶点（移动它们本来就要拉伸 / 裁剪贴图）、
 * 非网格附件，或样本退化（邻居太少 / 几乎共线）。
 */
function prepareUvField(
  slot: string,
  attachmentName: string,
  vertexIndex: number
): ((x: number, y: number) => { u: number; v: number }) | null {
  const attachment = findAttachment(useProjectStore.getState().document, slot, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return null
  if (!isInteriorVertex(attachment.triangles, vertexIndex)) return null

  const neighbours = new Set<number>()
  for (let t = 0; t + 2 < attachment.triangles.length; t += 3) {
    const triangle = [attachment.triangles[t], attachment.triangles[t + 1], attachment.triangles[t + 2]]
    if (!triangle.includes(vertexIndex)) continue
    for (const index of triangle) if (index !== vertexIndex) neighbours.add(index)
  }
  return fitUvField(
    [...neighbours].map((index) => ({
      x: attachment.vertices[index].x,
      y: attachment.vertices[index].y,
      u: attachment.uvs[index * 2],
      v: attachment.uvs[index * 2 + 1]
    }))
  )
}

function dragVertex(host: ToolHost, world: Vec2): void {
  const scene = host.scene
  const bundle = scene.runtime
  const mesh = scene.meshResult
  if (!bundle || !mesh) return

  const slotIndex = bundle.slotIndex[drag.slot] ?? -1
  if (slotIndex < 0) return
  const target = scene.attachmentAt(slotIndex, bundle.skeleton.slotDisplayIndex[slotIndex])
  if (!target) return
  // AttachmentData.vertices 是 (x,y) 扁平数组，顶点数需要除以 2
  const vertexCount = Math.floor(target.vertices.length / 2)

  // 世界位移 → 附件空间位移（用附件的世界矩阵做方向变换）
  const attachmentWorld = scene.attachmentWorldAt(slotIndex)
  const deltaWorld: Vec2 = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y }
  const delta = attachmentWorld ? mulVector(invert(attachmentWorld), deltaWorld) : deltaWorld

  // 顶点工具只有一个：Pose 态改绑定网格，Animate 态写 FFD 帧
  const editBind = host.mode !== 'animate'
  const store = useProjectStore.getState()

  /*
   * Pose 工具：**只改贴图坐标（UV）**，几何顶点一点不动。
   *
   * 语义与顶点工具正好相反 —— 顶点工具是「贴图不动、拖几何（再反算 UV）」，
   * 这里是「几何不动、拖贴图」：把世界位移换算进附件空间，再按附件显示尺寸归一化成
   * UV 增量（v 轴已翻转、方向与 y 一致，见 AttachmentData 的说明）。
   */
  /*
   * Pose 工具与顶点工具在这里**走同一条路**：都只挪几何顶点。
   *
   * 唯一的差别在 `uvField`（拖拽开始时按工具决定）：顶点工具在 Pose 态会先按邻居
   * 拟合出 UV 场，拖动时把 UV 反算回原映射（贴图留在原地，不跟着顶点跑）；
   * Pose 工具的 `uvField` 是 null —— 顶点挪到哪就是哪，UV 一个分量都不改。
   */
  if (editBind) {
    store.updateSilent((draft) => {
      const attachment = findAttachment(draft, drag.slot, drag.attachment)
      const vertex = attachment?.vertices[drag.vertex]
      if (!vertex || !attachment) return
      vertex.x += delta.x - drag.totalDelta.x
      vertex.y += delta.y - drag.totalDelta.y
      // 内部顶点：UV 跟着新位置重算。网格顶点只要满足「UV = 原映射在该位置的值」，
      // 贴图整块就不变形 —— 所以拖到哪就把那里的 UV 算出来（贴图原地不动）；
      // 否则 UV 留在原处，会把贴图从拖动点「拽」出尖角
      if (drag.uvField && attachment.uvs.length >= drag.vertex * 2 + 2) {
        const uv = drag.uvField(vertex.x, vertex.y)
        attachment.uvs[drag.vertex * 2] = uv.u
        attachment.uvs[drag.vertex * 2 + 1] = uv.v
      }
    })
  } else {
    const base = currentOffsets(store.document, scene.currentAnimation, drag.slot, drag.attachment, host.time, vertexCount)
    store.updateSilent((draft) => {
      const offsets = [...base]
      const index = drag.vertex * 2
      if (index + 1 >= offsets.length) return
      offsets[index] += delta.x - drag.totalDelta.x
      offsets[index + 1] += delta.y - drag.totalDelta.y
      const animation = draft.animations.find((item) => item.name === scene.currentAnimation)
      if (animation) keyDeform(animation, drag.slot, drag.attachment, host.time, offsets)
    })
  }

  drag.totalDelta = delta
  scene.setDocument(store.document, host.selection.skin)
  scene.refresh()
}

/** 取当前时刻的 FFD 基准偏移：优先用同时间点的关键帧，否则补零 */
function currentOffsets(
  doc: EditorDocument,
  animationName: string | null,
  slot: string,
  attachmentName: string,
  time: number,
  vertexCount: number
): number[] {
  const animation = doc.animations.find((item) => item.name === animationName)
  const track = animation?.deforms.find((item) => item.slot === slot && item.attachment === attachmentName)
  const frame = track?.frames.find((item) => Math.abs(item.time - time) < 1e-3)
  if (frame && frame.offsets.length >= vertexCount * 2) return [...frame.offsets]
  return new Array<number>(vertexCount * 2).fill(0)
}


/** 收集目标附件的顶点样本（setup 世界坐标） */
function samplesFor(host: ToolHost, slot: string, attachment: string, anySlot = false): VertexSample[] {
  const scene = host.scene
  const bundle = scene.runtime
  const mesh = scene.meshResult
  if (!bundle || !mesh) return []
  const restrict = !anySlot && slot !== '' && attachment !== ''
  return meshVertexSamples(mesh, (slotIndex, vertex) => {
    const slotData = bundle.asset.slots[slotIndex]
    if (!slotData) return null
    const display = bundle.skeleton.slotDisplayIndex[slotIndex]
    const current = scene.attachmentAt(slotIndex, display)
    if (!current) return null
    if (restrict && (slotData.name !== slot || current.name !== attachment)) return null
    return { slot: slotData.name, attachment: current.name, vertex }
  })
}

/** 共享顶点下标 → 附件顶点（权重 / FFD 工具用） */
function resolveVertex(host: ToolHost, vertexIndex: number): { slot: string; attachment: string; vertex: number } | null {
  const bundle = host.scene.runtime
  const mesh = host.scene.meshResult
  if (!bundle || !mesh || vertexIndex < 0 || vertexIndex >= mesh.vertexCount) return null
  const slotIndex = mesh.sourceSlot[vertexIndex]
  const slotData = bundle.asset.slots[slotIndex]
  if (!slotData) return null
  const display = bundle.skeleton.slotDisplayIndex[slotIndex]
  const current = host.scene.attachmentAt(slotIndex, display)
  if (!current) return null
  return { slot: slotData.name, attachment: current.name, vertex: mesh.sourceVertex[vertexIndex] }
}

/* --------------------------------------------------------------------------------------------- *
 * 网格子工具（Pose 态的「网格工具 M」）：添加 / 删除顶点、绘制边界、自定义布线
 *
 * 图标条在视口左下角（`MeshSubtoolBar`），这里只负责「鼠标按下之后做什么」。三个约定：
 * 1. 只作用于**当前选中的那个网格附件**（Region 得先转成网格）；
 * 2. 只在 **Pose 态**可用 —— 它改的是绑定网格；Animate 态动网格写的是 FFD 帧，语义完全不同；
 * 3. 拓扑类操作（删点 / 重画边界 / 布线）改完都整份重建场景（顶点数与索引都变了）。
 * --------------------------------------------------------------------------------------------- */

/** 子工具作用的网格附件（选中项 + 文档里的真实数据） */
interface MeshTarget {
  slot: string
  attachment: string
  data: NonNullable<ReturnType<typeof findAttachment>>
}

/** 子工具的显示名（状态提示用，文案与图标条共用 `MESH_SUBTOOLS`） */
function meshSubtoolLabel(subtool: MeshSubtool): string {
  return MESH_SUBTOOLS.find((item) => item.id === subtool)?.label ?? '网格子工具'
}

/** 当前选中的网格附件；没选中 / 不是网格 → null */
function meshTargetOf(host: ToolHost): MeshTarget | null {
  const selection = host.selection
  if (selection.kind !== 'attachment' || !selection.slot || !selection.attachment) return null
  const data = findAttachment(useProjectStore.getState().document, selection.slot, selection.attachment)
  if (!data || data.type !== 'mesh') return null
  return { slot: selection.slot, attachment: selection.attachment, data }
}

/** 拓扑改动后把文档喂回场景：顶点数 / 索引都变了，必须整份重建（与 Alt+插点同一套） */
function meshSubtoolSync(host: ToolHost): void {
  host.scene.setDocument(useProjectStore.getState().document, host.selection.skin)
  host.scene.refresh()
}

/**
 * 网格子工具的鼠标按下。返回 true 表示这次点击已被子工具吃掉（调用方别再走默认选择逻辑）。
 */
export function meshSubtoolPointerDown(host: ToolHost, info: PointerInfo): boolean {
  const subtool = host.tools.meshSubtool
  if (subtool === 'edit') return false
  const target = meshTargetOf(host)
  if (!target) {
    host.status(`「${meshSubtoolLabel(subtool)}」要先选中一个网格附件（Region 可右键「转为网格」再改）`)
    return true
  }
  if (host.mode !== 'pose') {
    host.status(`「${meshSubtoolLabel(subtool)}」改的是绑定网格：请切到 Pose 状态（Animate 态拖顶点写的是 FFD 帧）`)
    return true
  }
  switch (subtool) {
    case 'add':
      return addMeshVertexByTool(host, target, info.world)
    case 'remove':
      return removeMeshVertexByTool(host, target, info.world)
    case 'boundary':
      return boundaryPointerDown(host, target, info.world)
    case 'rewire':
      return rewirePointerDown(host, target, info.world)
    default:
      return false
  }
}

/**
 * 网格子工具的光标移动（没在拖拽时）：画边界更新橡皮筋；删顶点 / 布线高亮指到的顶点，
 * 让「这一下会点到谁」提前看得见。
 */
export function meshSubtoolHover(host: ToolHost, world: Vec2): void {
  const subtool = host.tools.meshSubtool
  const scene = host.scene
  if (subtool === 'boundary') {
    const path = scene.state.pendingMeshPath
    if (!path) return
    const local = scene.worldToAttachmentLocal(path.slot, path.attachment, world.x, world.y)
    if (!local) return
    // 橡皮筋末端也夹进 region 框：画出来的那个落点就是松手会真正落下的位置
    const target = meshTargetOf(host)
    const cursor =
      target && target.slot === path.slot && target.attachment === path.attachment
        ? clampToFrame(meshFrameBox(target.data), local)
        : local
    scene.setViewState({ pendingMeshPath: { ...path, cursor } })
    return
  }
  if (subtool === 'remove' || subtool === 'rewire') {
    const hit = scene.pickVertexAt(world.x, world.y)
    const next = hit ? hit.vertexIndex : -1
    if (scene.state.hoveredVertex !== next) scene.setViewState({ hoveredVertex: next })
  }
}

/**
 * 右键退出网格子工具：正在画边界的话**先收尾闭合**（把最后一个点连回第一个点），
 * 其余情况就是把没落地的临时状态清掉（包括刚拖到一半的布线）。调用方随后把 `meshSubtool` 切回 `edit`。
 */
export function meshSubtoolCancel(host: ToolHost): boolean {
  if (host.tools.meshSubtool === 'boundary' && host.scene.state.pendingMeshPath) return closeMeshBoundary(host)
  drag = { ...IDLE }
  host.scene.setViewState({ pendingMeshPath: null, hoveredVertex: -1 })
  return false
}

/** 「添加顶点」：点一下就插一个（等同原来的 Alt+点击） */
function addMeshVertexByTool(host: ToolHost, target: MeshTarget, world: Vec2): boolean {
  const local = host.scene.worldToAttachmentLocal(target.slot, target.attachment, world.x, world.y)
  if (!local) {
    host.status('插入位置不在附件上：点在网格覆盖的区域内')
    return true
  }
  let created: number | null = null
  // runCommand：点不在网格内部时草稿丢掉，不留空的撤销记录
  useProjectStore.getState().runCommand('插入网格顶点', (draft) => {
    const index = insertMeshVertex(draft, target.slot, target.attachment, local as Vec2)
    if (index === null) return false
    created = index
  })
  const index = created as number | null
  if (index === null) {
    host.status('该位置不在网格内部：点在网格覆盖的区域内才能插入顶点')
    return true
  }
  meshSubtoolSync(host)
  useSelectionStore.getState().selectVertices([index])
  host.status(`已插入顶点 #${index}（UV 与权重按位置插值；落在网格线上会把那条边一分为二）`)
  return true
}

/** 「删除顶点」：点一个顶点把它删掉（引用它的三角形就地重新三角化补上） */
function removeMeshVertexByTool(host: ToolHost, target: MeshTarget, world: Vec2): boolean {
  const hit = host.scene.pickVertexAt(world.x, world.y)
  const ref = hit ? resolveVertex(host, hit.vertexIndex) : null
  if (!ref || ref.slot !== target.slot || ref.attachment !== target.attachment) {
    host.status('删除顶点：对准要删的顶点再点（网格至少得留 3 个顶点）')
    return true
  }
  let removed = false
  // runCommand：删不动（会剩不到一个三角形）时不写撤销记录
  useProjectStore.getState().runCommand('删除网格顶点', (draft) => {
    const ok = deleteMeshVertex(draft, ref.slot, ref.attachment, ref.vertex)
    if (!ok) return false
    removed = true
  })
  if (!removed) {
    host.status('删不掉：网格至少得保留 3 个顶点')
    return true
  }
  meshSubtoolSync(host)
  host.status(`已删除顶点 #${ref.vertex}（引用它的三角形就地重新三角化补上）`)
  return true
}

/**
 * 「自己绘制边界」：一次点击落一个点。
 * 已经有 3 个点时，点在起点附近（10 屏幕像素内）就算**闭合**，等价右键收尾。
 *
 * 落点会被 `clampToFrame` 夹进**图片的 region 框**里：边界不允许画到图片范围之外
 *（这也是视口里画那个虚框（见 Scene.drawBoundaryFrame）的原因 —— 夹过之后点停在框边上，
 * 用户一眼能看出「这一下贴边了」）。
 */
function boundaryPointerDown(host: ToolHost, target: MeshTarget, world: Vec2): boolean {
  const scene = host.scene
  const local = scene.worldToAttachmentLocal(target.slot, target.attachment, world.x, world.y)
  if (!local) {
    host.status('边界点要落在附件所在的插槽上')
    return true
  }
  const point = clampToFrame(meshFrameBox(target.data), local)
  const clamped = point.x !== local.x || point.y !== local.y
  const path = scene.state.pendingMeshPath
  const mine = path && path.slot === target.slot && path.attachment === target.attachment ? path.points : []
  // 闭合判定用**夹过之后**的位置：鼠标贴着框边挪到起点附近时也得能闭合
  if (mine.length >= 3 && nearMeshPathStart(scene, target.slot, mine[0], point)) {
    // 点回起点 = 闭合：边界画成了就退出「绘制边界」（右键那条路退出见 ViewportCanvas）
    if (closeMeshBoundary(host)) useToolStore.getState().setMeshSubtool('edit')
    return true
  }
  /*
   * 夹过之后可能正好压在上一个点上（在框外同一条边上连点几下最典型）：零长度的边毫无意义，
   * 还会让收尾时的耳切切出退化三角形，这种一下直接丢掉。
   */
  if (mine.length > 0 && tooCloseToLast(scene, target.slot, mine[mine.length - 1], point)) {
    host.status('这个点离上一个点太近，没有落下')
    return true
  }

  const points = [...mine, point]
  scene.setViewState({
    pendingMeshPath: { slot: target.slot, attachment: target.attachment, points, cursor: point }
  })
  const suffix = clamped ? '；该点在图片范围外，已贴到最近的框边' : ''
  host.status(
    points.length < 3
      ? `边界点 ${points.length}：继续点（至少 3 个点，点回起点或右键收尾）；点错了按 Ctrl+Z 撤回上一个${suffix}`
      : `边界点 ${points.length}：点回起点（第一个大圆点）或按右键收尾闭合；点错了按 Ctrl+Z 撤回上一个${suffix}`
  )
  return true
}

/** 世界坐标是否落在折线起点的「闭合圈」里（10 屏幕像素内，缩放到哪都点得中） */
function nearMeshPathStart(scene: EditorScene, slotName: string, first: Vec2, local: Vec2): boolean {
  const matrix = scene.attachmentWorldByName(slotName)
  if (!matrix) return false
  const anchor = mulPoint(matrix, first)
  const cursor = mulPoint(matrix, local)
  return Math.hypot(anchor.x - cursor.x, anchor.y - cursor.y) <= scene.viewport.pixelsToWorld(10)
}

/** 两个附件空间的点在世界里是否近到「几乎是同一个」（2 屏幕像素内），比较时按附件的实际大小缩放 */
function tooCloseToLast(scene: EditorScene, slotName: string, last: Vec2, next: Vec2): boolean {
  const matrix = scene.attachmentWorldByName(slotName)
  if (!matrix) return false
  const a = mulPoint(matrix, last)
  const b = mulPoint(matrix, next)
  return Math.hypot(a.x - b.x, a.y - b.y) <= scene.viewport.pixelsToWorld(2)
}

/**
 * 附件的**原图框**（region 范围，附件局部空间）：绘制边界时用它画范围提示
 *（Scene.drawBoundaryFrame）与把落点夹进来 —— 两边共用同一个 `attachmentFrameBox`。
 */
function meshFrameBox(data: MeshTarget['data']): { center: Vec2; size: Vec2 } {
  return attachmentFrameBox(data)
}

/** 把点夹进原图框里：绘制边界时不允许跑出图片范围（框尺寸无效时原样返回） */
function clampToFrame(box: { center: Vec2; size: Vec2 }, point: Vec2): Vec2 {
  const halfX = box.size.x * 0.5
  const halfY = box.size.y * 0.5
  if (halfX <= 1e-6 || halfY <= 1e-6) return point
  return {
    x: Math.min(box.center.x + halfX, Math.max(box.center.x - halfX, point.x)),
    y: Math.min(box.center.y + halfY, Math.max(box.center.y - halfY, point.y))
  }
}

/**
 * 收尾「绘制边界」：把画好的多边形换成这个网格的新外边界。
 *
 * 顶点换成画的点、三角形重新耳切、UV 由**原网格的「位置 → UV」拟合结果**反算 ——
 * 于是「重画外形」时贴图停在原位，不会跟着跳（拟合不出来才退回包围盒映射）。
 * 代价是原**内部顶点会被丢弃**（任意凹边界 + 保留内部点需要约束三角化，这里不做），
 * 而且**绑定权重与 FFD 关键帧一起清掉**：这条路的语义就是「整块重画」，用户点工具时
 * 已经被确认框告知过（见 MeshSubtoolBar 的 BOUNDARY_REDRAW_WARNING）。
 */
export function closeMeshBoundary(host: ToolHost): boolean {
  return closeMeshBoundaryOn(host.scene, host.status)
}

/**
 * 收尾「绘制边界」，只需要场景 + 状态提示（图标条在视口外，拿不到 ToolHost，走这个入口）。
 */
export function closeMeshBoundaryOn(scene: EditorScene, status: (message: string) => void): boolean {
  const path = scene.state.pendingMeshPath
  scene.setViewState({ pendingMeshPath: null, hoveredVertex: -1 })
  if (!path || path.points.length < 3) {
    if (path) status('绘制边界已取消：至少要 3 个点才围得成一个边界；已回到「编辑顶点」')
    return false
  }
  let built: { vertices: number; triangles: number } | null = null
  // 用 runCommand：重建失败（点共线 / 已不是网格）时**不写撤销记录**，免得白留一条空的
  useProjectStore.getState().runCommand('重绘网格边界', (draft) => {
    const rebuilt = rebuildMeshBoundary(draft, path.slot, path.attachment, path.points)
    if (!rebuilt) return false
    built = rebuilt
  })
  const result = built as { vertices: number; triangles: number } | null
  if (!result) {
    status('边界重建失败：这 3 个点几乎共线，或附件已经不是网格了')
    return false
  }
  scene.setDocument(useProjectStore.getState().document, useSelectionStore.getState().skin)
  scene.refresh()
  status(
    `已按新边界重建网格：${result.vertices} 个顶点 / ${result.triangles} 个三角面（贴图停在原位；原网格点、绑定权重与 FFD 关键帧已清除，要蒙皮请重新绑骨骼并算权重）；已回到「编辑顶点」`
  )
  return true
}

/**
 * 「重绘网格边线」会丢什么 —— 图标条（`MeshSubtoolBar`）据此决定进这个子工具前要不要弹确认：
 * **选中项是网格、而且确实有东西可丢**才弹，空网格 / 没选中网格不打扰用户。
 */
export interface BoundaryRedrawLoss {
  slot: string
  attachment: string
  /** 会被替换掉的旧网格点数 */
  vertices: number
  /** 会被清掉的绑定骨骼数（0 = 从没绑过权重） */
  bones: number
  /** 会被删掉的 FFD 关键帧数 */
  ffdFrames: number
  /** 这些 FFD 帧散布在几个动画里（0 = 没有 FFD 帧） */
  ffdAnims: number
}

/**
 * 选中项「重画边界会真的丢东西」时返回明细，否则 null（没选中附件 / 不是网格 / 三个数组都空）。
 *
 * 三处计数与 `rebuildMeshBoundary` 实际清掉的东西一一对应（旧点数、`bones`、该附件的 FFD 帧），
 * 改那边记得同步这里；确认框拿它把「这次会丢多少」直接写出来。
 */
export function boundaryRedrawLoss(): BoundaryRedrawLoss | null {
  const selection = useSelectionStore.getState()
  if (selection.kind !== 'attachment' || !selection.slot || !selection.attachment) return null
  const { slot, attachment: name } = selection
  const doc = useProjectStore.getState().document
  const attachment = findAttachment(doc, slot, name)
  if (!attachment || attachment.type !== 'mesh') return null

  const bones = weightBonesOf(attachment).length
  let ffdFrames = 0
  let ffdAnims = 0
  for (const animation of doc.animations) {
    let count = 0
    for (const track of animation.deforms) {
      if (track.slot === slot && track.attachment === name) count += track.frames.length
    }
    if (count > 0) {
      ffdFrames += count
      ffdAnims += 1
    }
  }

  const vertices = attachment.vertices.length
  if (vertices === 0 && bones === 0 && ffdFrames === 0) return null
  return { slot, attachment: name, vertices, bones, ffdFrames, ffdAnims }
}

/**
 * 「自己绘制边界」进行中按 Ctrl+Z / 点菜单「撤销」的语义：**撤回上一个已落的点**，
 * 而不是撤销文档命令（App.tsx 的 `edit:undo` 会先问这里）。
 *
 * 为什么必须接管：落下的点只活在视图状态里（`pendingMeshPath`，不进历史），而此刻历史栈顶
 * 多半是「转为网格」这类**把网格造出来**的命令 —— 真让它撤销，正在画边界的那个网格就没了。
 * 所以这个状态下整条 Ctrl+Z 都归这边：点还没落下时也吃掉，只提示一句（要撤销文档请先退出子工具）。
 *
 * 返回 true = 这次撤销已被吃掉，调用方**不要**再走 `projectStore.undo`。
 */
export function undoMeshBoundaryPoint(scene: EditorScene, status?: (message: string) => void): boolean {
  // `boundaryTarget` 有值 == 正处在「自己绘制边界」（Pose + 网格工具 + 该子工具 + 选中网格）：
  // 拿它当开关，就不必再从图标条 / store 那边取一遍子工具状态
  if (!scene.state.boundaryTarget) return false
  const path = scene.state.pendingMeshPath
  const points = path ? path.points.slice(0, -1) : []
  // 点全部撤完就退回「还没开始画」：橡皮筋收掉（region 框会留着，接着点就行）
  scene.setViewState({ pendingMeshPath: points.length > 0 && path ? { ...path, points } : null })
  if (!path || path.points.length === 0) {
    status?.('还没有落下边界点；要撤销文档命令，请先退出「自己绘制边界」')
  } else if (points.length === 0) {
    status?.('已撤回最后一个边界点：重新开始点（点回起点或右键收尾）')
  } else {
    status?.(`已撤回上一个边界点：还剩 ${points.length} 个（继续点 / 点回起点 / 右键收尾）`)
  }
  return true
}

/**
 * 用画好的多边形重画网格外边界（见 `closeMeshBoundary` 的说明）。
 * 返回 null 表示没改（点太少 / 共线 / 已不是网格），此时**不碰文档**。
 */
export function rebuildMeshBoundary(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  points: readonly Vec2[]
): { vertices: number; triangles: number } | null {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh' || points.length < 3) return null
  const triangles = triangulatePolygon(points)
  if (triangles.length < 3) return null
  // 样本只服务「位置 → UV」拟合，权重不再往下带（见下）
  const sources = attachment.vertices.map((vertex, index) => ({
    x: vertex.x,
    y: vertex.y,
    u: attachment.uvs[index * 2] ?? 0,
    v: attachment.uvs[index * 2 + 1] ?? 0
  }))
  const field = fitUvField(sources)
  const fallback = polygonUvs(points, attachment.size)
  /*
   * 新顶点**不带任何权重**：位置整圈换过了，就近继承会把权重绑到用户根本没画到的骨骼上，
   * 形变比「没有蒙皮」更离谱；而这一步用户点工具时已经确认过（确认框里明说了会删权重）。
   * 顶点与绑定列表一起清空 → 网格回到「只跟着插槽走」的刚性状态（与未加权网格同一套渲染）。
   */
  attachment.vertices = points.map((point) => ({ x: point.x, y: point.y, weights: [] }))
  attachment.bones = []
  attachment.uvs = points.flatMap((point, index) => {
    if (!field) return [fallback[index * 2] ?? 0, fallback[index * 2 + 1] ?? 0]
    const mapped = field(point.x, point.y)
    return [mapped.u, mapped.v]
  })
  attachment.triangles = triangles
  // 顶点全在边界上 → hull = 顶点数；edges 按「成对下标」存一圈外轮廓
  attachment.hull = points.length
  attachment.edges = points.flatMap((_, index) => [index, (index + 1) % points.length])
  // 顶点数变了：旧 FFD 关键帧按满顶点长度存 offsets，留着会整体错位 —— 全部清掉
  // （这正是确认框里说的「删除相对应的时间轴关键帧」；同 autoGenerateRegionMesh）
  for (const animation of doc.animations) {
    animation.deforms = animation.deforms.filter(
      (track) => !(track.slot === slotName && track.attachment === attachmentName)
    )
  }
  return { vertices: attachment.vertices.length, triangles: triangles.length / 3 }
}

/** 「自定义布线」按下：抓住线段起点那个顶点开始拖 */
function rewirePointerDown(host: ToolHost, target: MeshTarget, world: Vec2): boolean {
  const hit = host.scene.pickVertexAt(world.x, world.y)
  const ref = hit ? resolveVertex(host, hit.vertexIndex) : null
  if (!ref || ref.slot !== target.slot || ref.attachment !== target.attachment) {
    host.status('自定义布线：从网格的一个顶点上按住，拖到另一个顶点上松手')
    return true
  }
  const from = target.data.vertices[ref.vertex]
  if (!from) return true
  drag = {
    ...IDLE,
    kind: 'mesh-rewire',
    slot: target.slot,
    attachment: target.attachment,
    vertex: ref.vertex,
    startWorld: { ...world },
    lastWorld: { ...world }
  }
  // 拖拽期间不动文档（只有一条橡皮筋），连线在松手时一次 update 完成 ——
  // 不需要 begin / end 事务：那样等于替同一次改动记两条撤销（其中一条还是空的）
  const start = { x: from.x, y: from.y }
  host.scene.setViewState({
    pendingMeshPath: { slot: target.slot, attachment: target.attachment, points: [start], cursor: start }
  })
  host.status(`从顶点 #${ref.vertex} 拖到另一个顶点：松手即在这两点之间连一条线`)
  return true
}

/** 「自定义布线」拖拽中：橡皮筋跟着指针走 */
function rewireDragMove(host: ToolHost, world: Vec2): void {
  drag.lastWorld = { ...world }
  const path = host.scene.state.pendingMeshPath
  if (!path) return
  const local = host.scene.worldToAttachmentLocal(path.slot, path.attachment, world.x, world.y)
  if (local) host.scene.setViewState({ pendingMeshPath: { ...path, cursor: local } })
}

/** 「自定义布线」松手：落在**另一个**顶点上才连线（沿这条线重新三角化） */
function rewireDragEnd(host: ToolHost, session: DragSession): void {
  const scene = host.scene
  scene.setViewState({ pendingMeshPath: null })
  const target = meshTargetOf(host)
  if (!target || target.slot !== session.slot || target.attachment !== session.attachment) return
  const hit = scene.pickVertexAt(session.lastWorld.x, session.lastWorld.y)
  const ref = hit ? resolveVertex(host, hit.vertexIndex) : null
  if (!ref || ref.slot !== session.slot || ref.attachment !== session.attachment || ref.vertex === session.vertex) {
    host.status('自定义布线：要落到**另一个**顶点上才会连线，这次什么都没改')
    return
  }
  // runCommand：连线跑不通（已经连着 / 没横穿内部）时草稿直接丢掉，不留空的撤销记录
  const committed = useProjectStore
    .getState()
    .runCommand('自定义布线', (draft) =>
      connectMeshVertices(draft, session.slot, session.attachment, session.vertex, ref.vertex)
    )
  if (!committed) {
    host.status('这两点之间连不上：已经连着线了，或这条线没有横穿网格内部')
    return
  }
  meshSubtoolSync(host)
  host.status(`已在顶点 #${session.vertex} 与 #${ref.vertex} 之间连上线（只重排这条通道上的三角形）`)
}

/** 二维叉积（判点在直线哪一侧 / 求交点参数都用它） */
function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx
}

/**
 * 在顶点 a、b 之间连一条线（自定义布线）：沿线段 a→b 把**经过的三角形**切开，
 * 让这条线成为真正的三角边 —— 只重排这条「通道」上的三角形，其余区域一个面都不动。
 *
 * 三步：
 * ① **走一遍**：从 a 出发，每次穿过一条边进入相邻面，直到走进含 b 的面，收集这条通道上的所有面；
 * ② **取外圈**：只被通道里**一个**面用到的边就是通道的外轮廓，把它们串成一个环；
 * ③ **拆环重切**：环在 a、b 处拆成两条链（各是 a…b 的一条简单多边形），分别耳切，
 *    两条链各自都带 a–b 这条边，于是「a–b 成为三角边」自动成立。
 *
 * 返回 false = 这条线已经有 / 走不通（线段正好擦过某个顶点等退化情况），此时**不动文档**。
 */
export function connectMeshVertices(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  a: number,
  b: number
): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return false
  const vertices = attachment.vertices
  const triangles = attachment.triangles
  const faceCount = Math.floor(triangles.length / 3)
  if (a === b || a < 0 || b < 0 || a >= vertices.length || b >= vertices.length) return false
  if (faceCount === 0) return false

  const keyOf = (i: number, j: number): number => (i < j ? i * 65536 + j : j * 65536 + i)
  for (let face = 0; face < faceCount; face++) {
    const corners = [triangles[face * 3], triangles[face * 3 + 1], triangles[face * 3 + 2]]
    if (corners.includes(a) && corners.includes(b)) return false
  }
  // 边 → 用到它的面（走通道与「谁在外圈」都靠它）
  const owners = new Map<number, number[]>()
  for (let face = 0; face < faceCount; face++) {
    for (let k = 0; k < 3; k++) {
      const key = keyOf(triangles[face * 3 + k], triangles[face * 3 + ((k + 1) % 3)])
      const list = owners.get(key)
      if (list) list.push(face)
      else owners.set(key, [face])
    }
  }

  const start = vertices[a]
  const end = vertices[b]
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return false
  /** 点在直线 a→b 的哪一侧（>0 / <0 / =0 在线上） */
  const sideOf = (point: Vec2): number => dx * (point.y - start.y) - dy * (point.x - start.x)

  // ① 起点面：包含 a、且 a→b 的方向落在它这个角里面（线段一离开 a 就进这个面）
  let face = -1
  for (let candidate = 0; candidate < faceCount; candidate++) {
    const corners = [triangles[candidate * 3], triangles[candidate * 3 + 1], triangles[candidate * 3 + 2]]
    if (!corners.includes(a)) continue
    const others = corners.filter((index) => index !== a)
    const cu = cross2(vertices[others[0]].x - start.x, vertices[others[0]].y - start.y, dx, dy)
    const cv = cross2(vertices[others[1]].x - start.x, vertices[others[1]].y - start.y, dx, dy)
    if (cu === 0 || cv === 0) return false // 线段刚好沿着这个面的边：退化
    if (cu * cv < 0) {
      face = candidate
      break
    }
  }
  if (face < 0) return false

  const crossed: number[] = []
  const visited = new Set<number>()
  let entryT = -1
  for (let guard = 0; face >= 0; guard++) {
    if (guard > faceCount + 4 || visited.has(face)) return false // 打转：数据坏了，别动它
    visited.add(face)
    crossed.push(face)
    const corners = [triangles[face * 3], triangles[face * 3 + 1], triangles[face * 3 + 2]]
    if (corners.includes(b)) break
    // 出口 = 这个面里「参数 t 比入口大」的那条穿越边（凸面内至多一条）
    let exitFace = -1
    let exitT = Infinity
    for (let k = 0; k < 3; k++) {
      const i = corners[k]
      const j = corners[(k + 1) % 3]
      if (i === a || j === a || i === b || j === b) continue // 起止点所在的边不是出口
      const pi = vertices[i]
      const pj = vertices[j]
      const si = sideOf(pi)
      const sj = sideOf(pj)
      if (si === 0 || sj === 0) return false // 线段正好擦过第三个顶点：退化
      if (si * sj > 0) continue
      const ex = pj.x - pi.x
      const ey = pj.y - pi.y
      const denom = cross2(dx, dy, ex, ey)
      if (denom === 0) continue
      const t = cross2(pi.x - start.x, pi.y - start.y, ex, ey) / denom
      if (t <= 0 || t >= 1 || t <= entryT + 1e-9 || t >= exitT) continue
      exitT = t
      exitFace = owners.get(keyOf(i, j))?.find((other) => other !== face) ?? -1
    }
    if (exitFace < 0) return false // 走到网格边界外了：这条线连不通
    entryT = exitT
    face = exitFace
  }

  // ② 通道外圈：只被通道里一个面用到的边
  const outline: Array<[number, number]> = []
  const links = new Map<number, number[]>()
  const link = (from: number, to: number): void => {
    const list = links.get(from)
    if (list) list.push(to)
    else links.set(from, [to])
  }
  for (const crossedFace of crossed) {
    const corners = [triangles[crossedFace * 3], triangles[crossedFace * 3 + 1], triangles[crossedFace * 3 + 2]]
    for (let k = 0; k < 3; k++) {
      const i = corners[k]
      const j = corners[(k + 1) % 3]
      const shared = (owners.get(keyOf(i, j)) ?? []).filter((other) => visited.has(other)).length
      if (shared > 1) continue
      outline.push([i, j])
      link(i, j)
      link(j, i)
    }
  }
  // ③ 串成环（从 a 出发，绕一圈回到 a），再在 b 处拆成两条链
  const loop: number[] = [a]
  const used = new Set<number>([a])
  let cursor = a
  while (used.size <= outline.length) {
    const next = (links.get(cursor) ?? []).find((candidate) => !used.has(candidate))
    if (next === undefined) break
    loop.push(next)
    used.add(next)
    cursor = next
  }
  const indexB = loop.indexOf(b)
  if (indexB <= 0 || loop.length < 4) return false
  const chains = [loop.slice(0, indexB + 1), [...loop.slice(indexB), a]]
  if (chains.some((chain) => chain.length < 3)) return false

  // 绕向对齐原网格：三角化统一按逆时针出，这里按原面的符号翻一下，免得新面「翻面」
  const orientationOf = (i0: number, i1: number, i2: number): number => {
    const p0 = vertices[i0]
    const p1 = vertices[i1]
    const p2 = vertices[i2]
    return Math.sign((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y))
  }
  const base = orientationOf(triangles[0], triangles[1], triangles[2]) || 1
  const added: number[] = []
  for (const chain of chains) {
    const local = triangulatePolygon(chain.map((index) => vertices[index]))
    for (let t = 0; t + 2 < local.length; t += 3) {
      const i0 = chain[local[t]]
      const i1 = chain[local[t + 1]]
      const i2 = chain[local[t + 2]]
      if (orientationOf(i0, i1, i2) === base) added.push(i0, i1, i2)
      else added.push(i0, i2, i1)
    }
  }
  if (added.length === 0) return false

  const kept: number[] = []
  for (let face2 = 0; face2 < faceCount; face2++) {
    if (visited.has(face2)) continue
    kept.push(triangles[face2 * 3], triangles[face2 * 3 + 1], triangles[face2 * 3 + 2])
  }
  // 只换 triangles：新增的是一条**内部**线，外轮廓（edges / hull）一点没变。
  // 别把 a-b 塞进 edges —— 那是「外环成对下标」，多一对会让导出时按 edges 走的外环串不回去
  attachment.triangles = [...kept, ...added]
  return true
}

export type { VertexSample }
