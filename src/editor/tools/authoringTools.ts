import type { Vec2 } from '@core/math/matrix'
import { invert, mulPoint, mulVector, trs } from '@core/math/matrix'
import { attachmentGizmoFrame, gizmoGeometry } from '@render/picking'
import type { GizmoPart, ShearEdge } from '@render/picking'
import { GIZMO_AXIS_LENGTH } from '@render/overlays/boneOverlay'
import { RAD2DEG } from '@core/math/utils'
import type { EditorDocument } from '@core/model/authoring'
import { createAuthoringBone } from '@core/model/authoring'
import type { EditorScene } from '../scene'
import type { Selection } from '../store/selectionStore'
import { isMeshEditTool } from '../store/toolStore'
import type { ToolState } from '../store/toolStore'
import type { EditorMode } from '../store/modeStore'
import type { GizmoMode } from '../store/toolStore'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { keyBoneChannel, keyDeform } from '../commands/animationCommands'
import {
  autoWeights,
  findAttachment,
  insertMeshVertex,
  meshVertexSamples,
  paintWeights,
  patchAttachment,
  uniqueName
} from '../commands/authoringCommands'
import type { BrushMode, VertexSample } from '../commands/authoringCommands'
import type { BrushModeSetting } from '../store/toolStore'
import { fitUvField, isInteriorVertex } from '@core/mesh/triangulate'

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

type DragKind = 'bone-translate' | 'bone-create' | 'gizmo' | 'shear-box' | 'vertex' | 'paint' | 'attachment' | 'none'

/** 多骨骼拖拽：每根骨骼各自按下时的本地值（增量都按自己的起始值重算，避免累积误差） */
interface MultiBoneStart {
  name: string
  /** 按下时的本地旋转（度） */
  rot: number
  /** 按下时的本地位置（父骨骼局部空间） */
  pos: Vec2
  /** 按下时的本地缩放 */
  scale: Vec2
  /** 父骨骼世界矩阵（按下时）：把世界位移换算到这一根的父空间要用它；根骨骼为 null */
  parentWorld: Float32Array | null
}

interface DragSession {
  kind: DragKind
  bone: string
  /**
   * 这次拖拽要一起改的骨骼（旋转 / 移动 / 缩放同时作用于它们）。
   *
   * 内容 = 当前选中集合去掉「祖先也在集合里」的子孙（见 `pickDragRoots`）：父骨骼动了，
   * 子骨骼本来就会跟着动，再写一遍子骨骼的本地值等于动双倍。单根选中时就是它自己，
   * 走的写入路径与以前完全一致。
   */
  bones: MultiBoneStart[]
  /** 骨骼世界原点（旋转 / 缩放的轴心） */
  origin: Vec2
  parentRotation: number
  inheritRotation: boolean
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
  origin: { x: 0, y: 0 },
  parentRotation: 0,
  inheritRotation: true,
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
  totalDelta: { x: 0, y: 0 },
  uvField: null,
  paintMode: 'replace',
  moved: false,
  paintStarted: false,
  lastPaint: { x: 0, y: 0 },
  createStart: { x: 0, y: 0 },
  createEnd: { x: 0, y: 0 },
  createParent: '',
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
  // 落在空白处一律建在根层 —— 选中态不参与，避免误挂到上次选中的骨骼下面。
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
      endpoint
        ? `已吸附到「${parent}」的骨骼端点：拖动决定长度与方向，松开生成（一根接一根就是骨骼链）`
        : parent
          ? `从「${parent}」接着画：拖动决定长度与方向，松开生成（可以一根接一根拖成骨骼链）`
          : '拖动决定长度与方向，松开生成骨骼（建在根层；从骨骼上起笔才会挂到它下面）'
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
     * Pose 工具的顶点**只让位于真正的骨骼手柄**：指针落在骨骼**原点圈**（移动手柄）
     * 或小坐标轴上时才优先抓骨骼 —— 与本工程「附件与骨骼重叠时骨骼优先」同一原则，
     * 否则骨骼原点旁边只要有顶点，骨骼就再也抓不起来了。
     *
     * 不能拿 `pickBoneHandleAt` 的结果一概而论：它在没命中原点圈时会回退到**骨骼本体**
     * （那是留给「点骨骼体 = 旋转」的），而骨骼本体常常整条压在网格顶点上 ——
     * 那样顶点就永远拖不动（实测：离原点圈 29px 的顶点照样被判成骨骼）。
     */
    const boneHandle = tools.tool === 'pose' ? scene.pickBoneHandleAt(info.world.x, info.world.y) : null
    const onGizmo = tools.tool === 'pose' && scene.pickGizmoAt(info.world.x, info.world.y) !== null
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
    // 没抓到顶点：顶点工具到此为止；Pose 工具继续，让骨骼 / 操作器接管
    if (tools.tool !== 'pose') return false
  }

  // 斜切模式：包围盒优先。鼠标落在包围盒的边上拖动 → 沿该方向掰轴
  // （bone 工具已经在上面按「画骨骼」处理并 return，走到这里的只剩选择工具）
  if (tools.tool === 'select' && tools.gizmo === 'shear') {
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

  // 小坐标轴优先：它是选中骨骼的操作器，点中就必须由它接管
  if (tools.tool === 'select') {
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
    // 骨骼命中时不抢选附件，交给下面的骨骼分支处理
    const att = hit ? null : scene.pickAttachmentAt(info.world.x, info.world.y)
    if (att) {
      const isNew = att.slot !== sel.slot || att.attachment !== sel.attachment
      if (isNew) useSelectionStore.getState().selectAttachment(att.slot, att.attachment)
      if (host.mode === 'pose') {
        beginAttachmentGizmoDrag(host, att.slot, att.attachment, 'center', 'move', info.world)
        if (isNew) host.status(`已选中附件「${att.attachment}」（${att.slot}），拖动即可移动`)
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
  if (!hit) return false
  const bone = scene.runtime.asset.bones[hit.boneIndex]
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

  const offset = hit.boneIndex * 16
  const origin: Vec2 = { x: scene.runtime.skeleton.world[offset + 12], y: scene.runtime.skeleton.world[offset + 13] }
  const parent = bone.parentIndex
  // 骨骼**本体**上也直接响应当前变换模式（中心 = 整体：自由移动 / 旋转 / 等比缩放），
  // 不用非得精准抓到小坐标轴的细手柄；斜切则提示去拖包围盒的边。
  if (hit.zone !== 'origin') {
    if (tools.gizmo === 'shear') {
      host.status(`斜切骨骼「${bone.name}」：拖动斜切包围盒的边（上下边横向拖 / 左右边纵向拖）`)
      return true
    }
    return beginGizmoDrag(host, hit.boneIndex, bone.name, 'center', info.world)
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
    parentRotation: parent >= 0 ? skeleton.worldRot[parent] : 0,
    inheritRotation: bone.inheritRotation,
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
 * 从选中集合里挑出**真正要写本地值的骨骼**：祖先也在集合里的那些要剔除。
 *
 * 父骨骼旋转 / 平移时子骨骼本来就会跟着动，再给子骨骼写一遍它自己的本地值 = 动双倍。
 * 剔除之后剩下的互不为祖先，一起改就是一次刚体式的整体变换。
 */
export function pickDragRoots(
  names: readonly string[],
  parentOf: (name: string) => string | undefined
): string[] {
  return names.filter((name) => {
    const seen = new Set<string>([name])
    let parent = parentOf(name)
    while (parent) {
      if (names.includes(parent)) return false
      // 脏数据（父子成环）时直接停下，别让这里转不出来
      if (seen.has(parent)) break
      seen.add(parent)
      parent = parentOf(parent)
    }
    return true
  })
}

/** 收集这次拖拽要一起改的骨骼：当前选中集合（锁定 / 找不到的剔除）+ 按下的这根 */
function collectDragBones(host: ToolHost, boneName: string): MultiBoneStart[] {
  const bundle = host.scene.runtime
  if (!bundle) return []
  const skeleton = bundle.skeleton
  const asset = bundle.asset
  const indexOf = (name: string): number => bundle.boneIndex[name] ?? -1
  const parentOf = (name: string): string | undefined => {
    const index = indexOf(name)
    if (index < 0) return undefined
    const parentIndex = asset.bones[index].parentIndex
    return parentIndex >= 0 ? asset.bones[parentIndex].name : undefined
  }
  // 直接读 store：视口按下时可能刚把点击的骨骼选上，host 里的 selection 是按下那一刻的快照
  const current = useSelectionStore.getState()
  const selected = current.kind === 'bone' ? current.bones : []
  // 按下的那根一定参与（视口里点骨骼体会先把它选上，但保险起见再兜一次）
  const names = selected.includes(boneName) ? selected : [...selected, boneName]

  const out: MultiBoneStart[] = []
  for (const name of pickDragRoots(names, parentOf)) {
    const index = indexOf(name)
    if (index < 0 || boneLocked(name)) continue
    const parentIndex = asset.bones[index].parentIndex
    out.push({
      name,
      rot: skeleton.localRot[index],
      pos: { x: skeleton.localPos[index * 2], y: skeleton.localPos[index * 2 + 1] },
      scale: { x: skeleton.localScale[index * 2], y: skeleton.localScale[index * 2 + 1] },
      parentWorld:
        parentIndex >= 0 ? skeleton.world.slice(parentIndex * 16, parentIndex * 16 + 16) : null
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
  drag = {
    ...IDLE,
    kind: 'gizmo',
    bone: boneName,
    bones,
    origin,
    parentRotation: parent >= 0 ? skeleton.worldRot[parent] : 0,
    inheritRotation: bone.inheritRotation,
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
  drag = {
    ...IDLE,
    kind: 'shear-box',
    bone: boneName,
    origin: { x: box.corners[0].x, y: box.corners[0].y },
    parentRotation: parent >= 0 ? skeleton.worldRot[parent] : 0,
    inheritRotation: bone.inheritRotation,
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
  host.status(`斜切骨骼「${boneName}」${suffix} · 拖动包围盒${edgeLabel}`)
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

  useProjectStore.getState().updateSilent((draft) => {
    writeBoneValue(draft, animation, host.time, drag.bone, 'shear', next)
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
    const angle = Math.atan2(ry, rx) * (180 / Math.PI)
    const local = drag.inheritRotation ? angle - drag.parentRotation : angle
    /*
     * 多选：取相对**按下时**的角度增量，加到每根选中骨骼自己的起始旋转上。
     * 角度是局部量，增量可以直接相加；「祖先也在集合里」的子孙已在 collectDragBones 里剔除，
     * 所以不会出现「父骨骼转一次 + 自己再转一次」的双倍。
     */
    const delta = local - drag.startLocal.rot
    store.updateSilent((draft) => {
      for (const item of drag.bones) {
        writeBoneValue(draft, animation, host.time, item.name, 'rotate', item.rot + delta)
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
    // 多选：`moved` 是按下那根骨骼**父空间**里的位移，先换成世界位移，再各自换算进自己的父空间
    const worldDelta = drag.parentWorld
      ? mulVector(drag.parentWorld, { x: next.x - start.x, y: next.y - start.y })
      : { x: next.x - start.x, y: next.y - start.y }
    store.updateSilent((draft) => {
      for (const item of drag.bones) {
        // 根骨骼没有父矩阵 → 父空间就是世界空间（与 beginGizmoDrag 的约定一致）
        const delta = item.parentWorld
          ? mulVector(invert(item.parentWorld), worldDelta)
          : worldDelta
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
    host.scene.setViewState({
      pendingBone: { x1: drag.createStart.x, y1: drag.createStart.y, x2: end.x, y2: end.y }
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
  /*
   * 多选：按下那根照旧「原点吸到指针」（拖原点圈的原有手感），其余骨骼按**同一世界位移**
   * 各自换算进自己的父空间 —— 这样它们跟着走，不会被指针位置拽得乱跳。
   */
  const pointerDelta = { x: local.x - drag.startPointerLocal.x, y: local.y - drag.startPointerLocal.y }
  const worldDelta = drag.parentWorld ? mulVector(drag.parentWorld, pointerDelta) : pointerDelta
  store.updateSilent((draft) => {
    for (const item of drag.bones) {
      if (item.name === drag.bone) {
        writeBoneValue(draft, animation, host.time, item.name, 'translate', local)
        continue
      }
      const delta = item.parentWorld ? mulVector(invert(item.parentWorld), worldDelta) : worldDelta
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
  // 画骨骼：松开即生成（长度 / 角度按拖拽的两点算），并把新骨骼选中，方便接着拖下一根
  if (drag.kind === 'bone-create') {
    const session = drag
    drag = { ...IDLE }
    host.scene.setViewState({ pendingBone: null })
    storeHandler.end()
    createBoneFromDrag(host, session.createStart, session.createEnd, session.createParent)
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
 * 偏差稍大时（超过骨骼体的拾取半径）更是连父子关系都建不上，直接掉到根层。
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
 * 否则一律建在根层。
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
  return ''
}

/**
 * 按拖拽的两点生成骨骼：起点转换成父骨骼局部坐标、长度取两点距离、
 * 角度取连线方向再扣掉父骨骼的世界旋转（对应 inheritRotation / inheritScale 的语义）。
 */
function createBoneFromDrag(host: ToolHost, start: Vec2, end: Vec2, parent: string): void {
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

  useSelectionStore.getState().selectBone(created)
  scene.setDocument(useProjectStore.getState().document, host.selection.skin)
  scene.refresh()
  host.status(
    `已新建骨骼「${created}」${parent ? `，挂在「${parent}」下` : '（根骨骼）'} · 长度 ${length.toFixed(2)}`
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

export type { VertexSample }
