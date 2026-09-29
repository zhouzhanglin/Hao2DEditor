import type { Vec2 } from '@core/math/matrix'
import { invert, mulPoint, mulVector } from '@core/math/matrix'
import { gizmoGeometry } from '@render/picking'
import type { GizmoPart, ShearEdge } from '@render/picking'
import { RAD2DEG } from '@core/math/utils'
import type { EditorDocument } from '@core/model/authoring'
import { createAuthoringBone } from '@core/model/authoring'
import type { EditorScene } from '../scene'
import type { Selection } from '../store/selectionStore'
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
  uniqueName
} from '../commands/authoringCommands'
import type { BrushMode, VertexSample } from '../commands/authoringCommands'

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

type DragKind = 'bone-translate' | 'bone-create' | 'gizmo' | 'shear-box' | 'vertex' | 'paint' | 'none'

interface DragSession {
  kind: DragKind
  bone: string
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
  paintMode: BrushMode
  moved: boolean
  /** 新建骨骼：起点（已吸附）、当前终点与父骨骼名，松开时按起点→终点生成 */
  createStart: Vec2
  createEnd: Vec2
  createParent: string
}

const IDLE: DragSession = {
  kind: 'none',
  bone: '',
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
  paintMode: 'replace',
  moved: false,
  createStart: { x: 0, y: 0 },
  createEnd: { x: 0, y: 0 },
  createParent: ''
}

let drag: DragSession = { ...IDLE }

export function isDragging(): boolean {
  return drag.kind !== 'none'
}

/** 指针按下：返回 true 表示工具已接管（调用方不要再做默认选择逻辑） */
export function toolPointerDown(host: ToolHost, info: PointerInfo): boolean {
  const { tools, scene } = host
  if (!scene.runtime) return false

  if (tools.tool === 'weight') {
    const bone = host.selection.kind === 'bone' ? host.selection.bone : ''
    if (!bone) {
      host.status('请先在层级树里选中要刷权重的骨骼')
      return true
    }
    if (host.mode !== 'pose') {
      host.status('权重刷只在 Pose 状态可用（动画状态的角色姿态不是绑定姿态）')
      return true
    }
    drag = { ...IDLE, kind: 'paint', bone, paintMode: tools.brush.mode }
    storeHandler.begin('权重刷')
    paintAt(host, info.world)
    return true
  }

  // 绑骨骼工具：在视口里拖拽「画」骨骼（连续绑定）。
  // 起点落在已有骨骼上就吸附到它的轴线并以它为父；落在空白处则接在当前选中骨骼下面，
  // 于是拖完一根接着拖下一根，自然就接成一条骨骼链。
  if (tools.tool === 'bone') {
    if (host.mode !== 'pose') {
      host.status('骨骼属于绑定数据：切到 Pose 状态再画')
      return true
    }
    const parent = resolveCreateParent(host, info.world)
    const start = snapToBoneAxis(host, info.world)
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
      parent
        ? `从「${parent}」接着画：拖动决定长度与方向，松开生成（可以一根接一根拖成骨骼链）`
        : '拖动决定长度与方向，松开生成骨骼'
    )
    return true
  }

  if (tools.tool === 'ffd' || tools.tool === 'mesh') {
    const vertex = scene.pickVertexAt(info.world.x, info.world.y)
    if (!vertex) return false
    const resolved = resolveVertex(host, vertex.vertexIndex)
    if (!resolved || resolved.vertex < 0) {
      host.status('该顶点不支持编辑（Region 请先转为网格）')
      return true
    }
    drag = {
      ...IDLE,
      kind: 'vertex',
      slot: resolved.slot,
      attachment: resolved.attachment,
      vertex: resolved.vertex,
      startWorld: { ...info.world }
    }
    storeHandler.begin(tools.tool === 'ffd' && host.mode === 'animate' ? '编辑 FFD' : '编辑网格顶点')
    useSelectionStore.getState().select({
      kind: 'attachment',
      slot: resolved.slot,
      attachment: resolved.attachment,
      vertices: [vertex.vertexIndex]
    })
    host.status(`顶点 #${resolved.vertex}（${resolved.slot} / ${resolved.attachment}）`)
    return true
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

  // 选择 / 骨骼 / 插槽 / 约束：点中骨骼即开始拖拽
  // 手柄分区：原点圈 = 移动、末端方块 = 缩放、骨骼体 = 旋转；
  // Shift 仍可强制移动、Alt 强制缩放（与旧习惯兼容）。
  const hit = scene.pickBoneHandleAt(info.world.x, info.world.y)
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
  if (tools.tool === 'constraint' && selection.kind === 'constraint') {
    useProjectStore.getState().update('设置约束目标', (draft) => {
      const target = draft.constraints.find((item) => item.name === selection.constraint)
      if (target) target.target = bone.name
    })
    host.status(`约束「${selection.constraint}」的目标设为骨骼「${bone.name}」`)
    return true
  }
  if (tools.tool === 'slot') {
    const slot = scene.runtime.asset.slots.find((item) => item.boneIndex === hit.boneIndex)
    if (slot) {
      selection.selectSlot(slot.name)
      host.status(`选中插槽「${slot.name}」`)
      return true
    }
  }

  selection.selectBone(bone.name)

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
  drag = {
    ...IDLE,
    kind: 'bone-translate',
    bone: bone.name,
    origin,
    parentRotation: parent >= 0 ? scene.runtime.skeleton.worldRot[parent] : 0,
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
  drag = {
    ...IDLE,
    kind: 'gizmo',
    bone: boneName,
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
  host.status(`${label}骨骼「${boneName}」${suffix} · ${partLabel}`)
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
    store.updateSilent((draft) => {
      writeBoneValue(draft, animation, host.time, drag.bone, 'rotate', local)
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
    store.updateSilent((draft) => {
      writeBoneValue(draft, animation, host.time, drag.bone, 'translate', next)
    })
  } else {
    // 缩放（斜切不走小坐标轴，由包围盒拖拽 dragShearBox 处理）
    const next = { x: drag.startLocal.scale.x, y: drag.startLocal.scale.y }
    if (part === 'x') {
      next.x = drag.startLocal.scale.x * axisFactor(rx * drag.axisDir.x + ry * drag.axisDir.y, drag.startProject)
    } else if (part === 'y') {
      next.y = drag.startLocal.scale.y * axisFactor(rx * drag.axisPerp.x + ry * drag.axisPerp.y, drag.startProject)
    } else {
      const factor = axisFactor(Math.hypot(rx, ry), drag.startDistance)
      next.x = drag.startLocal.scale.x * factor
      next.y = drag.startLocal.scale.y * factor
    }
    store.updateSilent((draft) => {
      writeBoneValue(draft, animation, host.time, drag.bone, 'scale', next)
    })
  }

  const after = useProjectStore.getState()
  scene.setDocument(after.document, host.selection.skin)
  scene.refresh()
}

export function toolPointerMove(host: ToolHost, info: PointerInfo): void {
  if (drag.kind === 'none') return
  drag.moved = true

  if (drag.kind === 'paint') {
    paintAt(host, info.world)
    return
  }

  if (drag.kind === 'bone-create') {
    const end = snapToBoneAxis(host, info.world)
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
  store.updateSilent((draft) => {
    writeBoneValue(draft, animation, host.time, drag.bone, 'translate', local)
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

/** 新骨骼的父级：起点命中的骨骼 > 当前选中骨骼 > 根骨骼 */
function resolveCreateParent(host: ToolHost, world: Vec2): string {
  const bundle = host.scene.runtime
  const hit = host.scene.pickBoneAt(world.x, world.y)
  if (hit && bundle) {
    const name = bundle.asset.bones[hit.boneIndex]?.name ?? ''
    if (name) return name
  }
  return host.selection.kind === 'bone' ? host.selection.bone : ''
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

/** 自动权重（工具选项面板按钮调用）：需要先选中骨骼与附件 */
export function runAutoWeights(host: ToolHost, falloff: number): number {
  const scene = host.scene
  const bundle = scene.runtime
  if (!bundle || host.mode !== 'pose') return 0
  const bone = host.selection.kind === 'bone' ? host.selection.bone : ''
  if (!bone) return 0

  const samples = samplesFor(host, host.selection.slot, host.selection.attachment)
  if (samples.length === 0) return 0

  // 候选骨骼：被选中骨骼 + 它的直接子骨骼（简单且符合直觉的局部影响范围）
  const candidates = candidateBones(host, bone)
  const segments = candidates.map((item) => {
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

  let touched = 0
  useProjectStore.getState().update('自动权重', (draft) => {
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
  const selected = host.selection.slot !== '' && host.selection.attachment !== ''
  const samples = samplesFor(host, host.selection.slot, host.selection.attachment, !selected)
  if (samples.length === 0) return
  const brush = host.tools.brush
  let touched = 0
  useProjectStore.getState().updateSilent((draft) => {
    touched = paintWeights(draft, samples, drag.bone, world, brush.radius / 100, brush.strength, drag.paintMode)
  })
  if (touched === 0) return
  const store = useProjectStore.getState()
  host.scene.setDocument(store.document, host.selection.skin)
  host.scene.refresh()
  host.status(`已为 ${touched} 个顶点刷上「${drag.bone}」的权重`)
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

  const editBind = host.tools.tool === 'mesh' || host.mode !== 'animate'
  const store = useProjectStore.getState()

  if (editBind) {
    store.updateSilent((draft) => {
      const attachment = findAttachment(draft, drag.slot, drag.attachment)
      const vertex = attachment?.vertices[drag.vertex]
      if (!vertex) return
      vertex.x += delta.x - drag.totalDelta.x
      vertex.y += delta.y - drag.totalDelta.y
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

function candidateBones(host: ToolHost, bone: string): Array<{ name: string; index: number }> {
  const bundle = host.scene.runtime
  if (!bundle) return []
  const result: Array<{ name: string; index: number }> = []
  const push = (name: string): void => {
    const index = bundle.boneIndex[name]
    if (index !== undefined) result.push({ name, index })
  }
  push(bone)
  for (const child of bundle.asset.bones) {
    if (child.parentIndex === bundle.boneIndex[bone]) push(child.name)
  }
  return result
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
