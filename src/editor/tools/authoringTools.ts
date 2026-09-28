import type { Vec2 } from '@core/math/matrix'
import { invert, mulPoint, mulVector } from '@core/math/matrix'
import type { EditorDocument } from '@core/model/authoring'
import type { EditorScene } from '../scene'
import type { Selection } from '../store/selectionStore'
import type { ToolState } from '../store/toolStore'
import type { EditorMode } from '../store/modeStore'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { keyBoneChannel, keyDeform } from '../commands/animationCommands'
import {
  autoWeights,
  findAttachment,
  meshVertexSamples,
  paintWeights
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

type DragKind = 'bone-rotate' | 'bone-translate' | 'bone-scale' | 'vertex' | 'paint' | 'none'

interface DragSession {
  kind: DragKind
  bone: string
  /** 骨骼世界原点（旋转 / 缩放的轴心） */
  origin: Vec2
  parentRotation: number
  inheritRotation: boolean
  /** 缩放：按下时指针到轴心的距离与骨骼起始缩放 */
  startDistance: number
  startScale: Vec2
  /** 顶点拖拽 */
  slot: string
  attachment: string
  vertex: number
  startWorld: Vec2
  /** 附件空间下的累计位移（顶点拖拽） */
  totalDelta: Vec2
  paintMode: BrushMode
  moved: boolean
}

const IDLE: DragSession = {
  kind: 'none',
  bone: '',
  origin: { x: 0, y: 0 },
  parentRotation: 0,
  inheritRotation: true,
  startDistance: 0,
  startScale: { x: 1, y: 1 },
  slot: '',
  attachment: '',
  vertex: -1,
  startWorld: { x: 0, y: 0 },
  totalDelta: { x: 0, y: 0 },
  paintMode: 'replace',
  moved: false
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
  const kind: DragKind = info.shift ? 'bone-translate' : info.alt ? 'bone-scale' : zoneToKind(hit.zone)
  const authoring = useProjectStore.getState().document.bones.find((item) => item.name === bone.name)
  const localScale = scene.runtime.skeleton.localScale
  drag = {
    ...IDLE,
    kind,
    bone: bone.name,
    origin,
    parentRotation: parent >= 0 ? scene.runtime.skeleton.worldRot[parent] : 0,
    inheritRotation: bone.inheritRotation,
    startDistance: Math.max(1e-4, Math.hypot(info.world.x - origin.x, info.world.y - origin.y)),
    startScale: {
      x: localScale ? localScale[hit.boneIndex * 2] : (authoring?.localScale.x ?? 1),
      y: localScale ? localScale[hit.boneIndex * 2 + 1] : (authoring?.localScale.y ?? 1)
    }
  }
  const label = kind === 'bone-translate' ? '移动骨骼' : kind === 'bone-scale' ? '缩放骨骼' : '旋转骨骼'
  storeHandler.begin(label)
  const suffix = host.mode === 'animate' ? '（写入关键帧）' : '（修改 setup）'
  host.status(`${label}「${bone.name}」${suffix} · 原点圈=移动 / 末端方块=缩放 / 骨骼体=旋转`)
  return true
}

function zoneToKind(zone: 'origin' | 'tip' | 'body'): DragKind {
  if (zone === 'origin') return 'bone-translate'
  if (zone === 'tip') return 'bone-scale'
  return 'bone-rotate'
}

export function toolPointerMove(host: ToolHost, info: PointerInfo): void {
  if (drag.kind === 'none') return
  drag.moved = true

  if (drag.kind === 'paint') {
    paintAt(host, info.world)
    return
  }

  if (drag.kind === 'vertex') {
    dragVertex(host, info.world)
    return
  }

  const scene = host.scene
  if (!scene.runtime) return
  const store = useProjectStore.getState()
  const animation = host.mode === 'animate' ? currentAnimationName(host) : null

  if (drag.kind === 'bone-rotate') {
    const angle = Math.atan2(info.world.y - drag.origin.y, info.world.x - drag.origin.x) * (180 / Math.PI)
    const local = drag.inheritRotation ? angle - drag.parentRotation : angle
    store.updateSilent((draft) => {
      writeBoneValue(draft, animation, host.time, drag.bone, 'rotate', local)
    })
  } else if (drag.kind === 'bone-scale') {
    // 以骨骼原点为轴心：指针到轴心的距离比 → 等比缩放
    const distance = Math.hypot(info.world.x - drag.origin.x, info.world.y - drag.origin.y)
    const factor = Math.max(0.01, distance / Math.max(1e-4, drag.startDistance))
    const next = { x: drag.startScale.x * factor, y: drag.startScale.y * factor }
    store.updateSilent((draft) => {
      writeBoneValue(draft, animation, host.time, drag.bone, 'scale', next)
    })
  } else {
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
  }

  scene.setDocument(store.document, host.selection.skin)
  scene.refresh()
}

export function toolPointerUp(host: ToolHost): void {
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
  channel: 'rotate' | 'translate' | 'scale',
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
