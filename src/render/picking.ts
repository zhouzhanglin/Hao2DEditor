import type { Skeleton } from '@core/model/skeleton'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { AttachmentData } from '@core/model/types'

/**
 * 骨骼原点圈在屏幕上的半径（px）。渲染（boneOverlay）与拾取（pickBoneHandle）
 * 共用同一数值，改一处即可保持一致。
 */
export const BONE_ORIGIN_RADIUS = 6

/**
 * 骨骼变换小坐标轴（gizmo）：中心 + 局部 X / Y 轴。
 * 轴按屏幕恒定长度绘制，因此这里的轴向是世界单位向量，长度由调用方按 zoom 换算。
 */
export interface GizmoGeometry {
  /** 中心（骨骼原点） */
  ox: number
  oy: number
  /** 局部 X 轴方向（世界单位向量，含 shear/旋转/缩放朝向） */
  dx: number
  dy: number
  /** 局部 Y 轴方向（世界单位向量） */
  px: number
  py: number
  /** 轴长（世界单位） */
  len: number
  /** X 轴端点 */
  tx: number
  ty: number
  /** Y 轴端点 */
  sx: number
  sy: number
}

/** 用显式的中心与轴向组装 gizmo 几何（骨骼与附件操作器共用） */
export function gizmoFrameAt(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  px: number,
  py: number,
  axisLength: number
): GizmoGeometry {
  const len = Math.max(1e-6, axisLength)
  return { ox, oy, dx, dy, px, py, len, tx: ox + dx * len, ty: oy + dy * len, sx: ox + px * len, sy: oy + py * len }
}

export function gizmoGeometry(skeleton: Skeleton, index: number, axisLength: number): GizmoGeometry | null {
  if (index < 0 || index >= skeleton.boneCount) return null
  const o = index * 16
  const ox = skeleton.world[o + 12]
  const oy = skeleton.world[o + 13]
  const ax = skeleton.world[o]
  const ay = skeleton.world[o + 1]
  const bx = skeleton.world[o + 4]
  const by = skeleton.world[o + 5]
  const normA = Math.hypot(ax, ay)
  const normB = Math.hypot(bx, by)
  // 局部轴退化（缩放为 0）时退回默认朝向，避免画不出来 / 除零
  const dx = normA > 1e-9 ? ax / normA : 1
  const dy = normA > 1e-9 ? ay / normA : 0
  const px = normB > 1e-9 ? bx / normB : -dy
  const py = normB > 1e-9 ? by / normB : dx
  return gizmoFrameAt(ox, oy, dx, dy, px, py, axisLength)
}

/** 附件操作器几何：gizmo 几何 + 两个轴向的「世界长度」（骨骼×附件缩放，拖动换算用） */
export interface AttachmentGizmoGeometry extends GizmoGeometry {
  axisScaleA: number
  axisScaleB: number
}

/**
 * 附件操作器的几何：中心 = 附件 position 的世界位置，
 * 轴向 = 附件自身旋转叠加在宿主骨骼的世界基向量上。
 * 调用方按 zoom 把屏幕尺寸换算成 `axisLength`（世界单位）。
 */
export function attachmentGizmoFrame(
  skeleton: Skeleton,
  boneIndex: number,
  position: { x: number; y: number },
  rotation: number,
  axisLength: number
): AttachmentGizmoGeometry | null {
  if (boneIndex < 0 || boneIndex >= skeleton.boneCount) return null
  const o = boneIndex * 16
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // 附件原点：骨骼世界矩阵 · position
  const ox = skeleton.world[o] * position.x + skeleton.world[o + 4] * position.y + skeleton.world[o + 12]
  const oy = skeleton.world[o + 1] * position.x + skeleton.world[o + 5] * position.y + skeleton.world[o + 13]
  // 附件局部轴（骨骼空间里旋转 rotation 后的 X/Y）变换到世界
  const ax = skeleton.world[o] * cos + skeleton.world[o + 4] * sin
  const ay = skeleton.world[o + 1] * cos + skeleton.world[o + 5] * sin
  const bx = -skeleton.world[o] * sin + skeleton.world[o + 4] * cos
  const by = -skeleton.world[o + 1] * sin + skeleton.world[o + 5] * cos
  const normA = Math.hypot(ax, ay)
  const normB = Math.hypot(bx, by)
  const dx = normA > 1e-9 ? ax / normA : 1
  const dy = normA > 1e-9 ? ay / normA : 0
  const px = normB > 1e-9 ? bx / normB : -dy
  const py = normB > 1e-9 ? by / normB : dx
  const frame = gizmoFrameAt(ox, oy, dx, dy, px, py, axisLength)
  return { ...frame, axisScaleA: normA, axisScaleB: normB }
}

/** 通用 gizmo 拾取（骨骼与附件操作器共用） */
export function pickGizmoFrame(
  frame: GizmoGeometry,
  x: number,
  y: number,
  centerRadius: number,
  axisTolerance: number
): GizmoPart | null {
  if (Math.hypot(x - frame.ox, y - frame.oy) <= centerRadius) return 'center'
  if (distanceToSegment(x, y, frame.ox, frame.oy, frame.tx, frame.ty) <= axisTolerance) return 'x'
  if (distanceToSegment(x, y, frame.ox, frame.oy, frame.sx, frame.sy) <= axisTolerance) return 'y'
  return null
}

export type GizmoPart = 'center' | 'x' | 'y'

/**
 * 小坐标轴拾取：中心方块 → X 轴 → Y 轴。
 * 中心优先，因为两个轴都从中心出发，重叠区应视为「一起变换」。
 */
export function pickGizmo(
  skeleton: Skeleton,
  index: number,
  x: number,
  y: number,
  axisLength: number,
  centerRadius: number,
  axisTolerance: number
): GizmoPart | null {
  const g = gizmoGeometry(skeleton, index, axisLength)
  if (!g) return null
  if (Math.hypot(x - g.ox, y - g.oy) <= centerRadius) return 'center'
  if (distanceToSegment(x, y, g.ox, g.oy, g.tx, g.ty) <= axisTolerance) return 'x'
  if (distanceToSegment(x, y, g.ox, g.oy, g.sx, g.sy) <= axisTolerance) return 'y'
  return null
}

/** 斜切包围盒的四条边 */
export type ShearEdge = 'left' | 'right' | 'top' | 'bottom'

/**
 * 斜切包围盒的边拾取。四角按 `(minX,maxY) → (maxX,maxY) → (maxX,minY) → (minX,minY)`
 * 的顺序传入（世界坐标），返回命中最近的一条边。
 */
export function pickShearEdge(
  corners: readonly Vec2Like[],
  x: number,
  y: number,
  tolerance: number
): ShearEdge | null {
  if (corners.length < 4) return null
  const edges: Array<{ name: ShearEdge; a: number; b: number }> = [
    { name: 'top', a: 0, b: 1 },
    { name: 'right', a: 1, b: 2 },
    { name: 'bottom', a: 2, b: 3 },
    { name: 'left', a: 3, b: 0 }
  ]
  let best: { name: ShearEdge; distance: number } | null = null
  for (const edge of edges) {
    const p = corners[edge.a]
    const q = corners[edge.b]
    const distance = distanceToSegment(x, y, p.x, p.y, q.x, q.y)
    if (distance > tolerance) continue
    if (!best || distance < best.distance) best = { name: edge.name, distance }
  }
  return best?.name ?? null
}

export interface Vec2Like {
  x: number
  y: number
}

export interface BoneHit {
  boneIndex: number
  distance: number
}

/**
 * 骨骼上的操作区：
 * - `origin`：骨骼原点的关节圈（拖动 = 移动）
 * - `body`：骨骼本体（拖动 = 旋转）
 *
 * 缩放不再单独放手柄：交给选中骨骼上的小坐标轴（gizmo）的 X / Y 轴。
 */
export type BoneHandleZone = 'origin' | 'body'

export interface BoneHandleHit {
  boneIndex: number
  zone: BoneHandleZone
  distance: number
}

/**
 * 骨骼拾取：先看原点圈（移动，屏幕恒定大小，由调用方按 zoom 换算半径），
 * 都没命中时回退到骨骼本体（旋转）。
 *
 * `preferredBone`（通常是当前选中骨骼）优先判定：骨骼是头尾相接的，
 * 父骨骼的末端与子骨骼的原点落在同一点，不区分就会误判到父骨骼。
 */
export function pickBoneHandle(
  skeleton: Skeleton,
  x: number,
  y: number,
  tolerance: number,
  handleRadius: number,
  preferredBone = -1
): BoneHandleHit | null {
  const distanceToOrigin = (index: number): number => {
    const o = index * 16
    return Math.hypot(x - skeleton.world[o + 12], y - skeleton.world[o + 13])
  }

  if (preferredBone >= 0 && preferredBone < skeleton.boneCount) {
    const distance = distanceToOrigin(preferredBone)
    if (distance <= handleRadius) return { boneIndex: preferredBone, zone: 'origin', distance }
  }

  let best: BoneHandleHit | null = null
  for (let i = 0; i < skeleton.boneCount; i++) {
    if (i === preferredBone) continue
    const distance = distanceToOrigin(i)
    if (distance <= handleRadius && (!best || distance < best.distance)) {
      best = { boneIndex: i, zone: 'origin', distance }
    }
  }
  if (best) return best

  const body = pickBone(skeleton, x, y, tolerance)
  return body ? { boneIndex: body.boneIndex, zone: 'body', distance: body.distance } : null
}

export interface VertexHit {
  vertexIndex: number
  distance: number
}

/**
 * 最近骨骼拾取：把鼠标位置换算到骨骼线段上的最短距离，
 * 命中阈值内取最近的一根（根骨骼优先，便于选中短骨骼）。
 */
export function pickBone(skeleton: Skeleton, x: number, y: number, tolerance: number): BoneHit | null {
  let best: BoneHit | null = null
  for (let i = 0; i < skeleton.boneCount; i++) {
    const o = i * 16
    const bx = skeleton.world[o + 12]
    const by = skeleton.world[o + 13]
    const length = skeleton.asset.bones[i].length
    const tx = skeleton.world[o] * Math.max(length, 0.0001) + bx
    const ty = skeleton.world[o + 1] * Math.max(length, 0.0001) + by

    let distance = distanceToSegment(x, y, bx, by, tx, ty)
    // 关节本身更容易被点到
    distance = Math.min(distance, Math.hypot(x - bx, y - by))
    if (distance > tolerance) continue
    if (!best || distance < best.distance) best = { boneIndex: i, distance }
  }
  return best
}

/** 顶点拾取：在共享顶点缓冲里找最近的顶点 */
export function pickVertex(
  result: MeshBuildResult | null,
  x: number,
  y: number,
  tolerance: number
): VertexHit | null {
  if (!result || result.vertexCount === 0) return null
  let best: VertexHit | null = null
  for (let i = 0; i < result.vertexCount; i++) {
    const distance = Math.hypot(x - result.positions[i * 2], y - result.positions[i * 2 + 1])
    if (distance > tolerance) continue
    if (!best || distance < best.distance) best = { vertexIndex: i, distance }
  }
  return best
}

/** 取顶点对应的附件（用于权重显示 / 换装） */
export function attachmentOfVertex(
  skeleton: Skeleton,
  result: MeshBuildResult,
  vertexIndex: number,
  resolve: (slotIndex: number, displayIndex: number) => AttachmentData | null
): AttachmentData | null {
  if (vertexIndex < 0 || vertexIndex >= result.vertexCount) return null
  const slotIndex = result.sourceSlot[vertexIndex]
  if (slotIndex < 0 || slotIndex >= skeleton.slotCount) return null
  return resolve(slotIndex, skeleton.slotDisplayIndex[slotIndex])
}

export interface AttachmentHit {
  slotIndex: number
  /** 命中的包围盒面积（越小 = 越「贴脸」，叠放时优先选它） */
  area: number
}

/**
 * 点选附件：用 mesh 的世界顶点按插槽分组做包围盒测试（含 `tolerance` 外扩），
 * 命中多个时取包围盒**面积最小**的 —— 小图叠在大图上时优先选到小图。
 * mesh 只包含「当前显示」的附件，所以不可见的 display 不会被点到。
 */
export function pickAttachmentAt(
  result: MeshBuildResult | null,
  x: number,
  y: number,
  tolerance: number
): AttachmentHit | null {
  if (!result || result.vertexCount === 0) return null
  const boxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()
  for (let i = 0; i < result.vertexCount; i++) {
    const slot = result.sourceSlot[i]
    const px = result.positions[i * 2]
    const py = result.positions[i * 2 + 1]
    const box = boxes.get(slot)
    if (box) {
      if (px < box.minX) box.minX = px
      if (py < box.minY) box.minY = py
      if (px > box.maxX) box.maxX = px
      if (py > box.maxY) box.maxY = py
    } else {
      boxes.set(slot, { minX: px, minY: py, maxX: px, maxY: py })
    }
  }
  let best: AttachmentHit | null = null
  for (const [slotIndex, box] of boxes) {
    if (x < box.minX - tolerance || x > box.maxX + tolerance) continue
    if (y < box.minY - tolerance || y > box.maxY + tolerance) continue
    const area = Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY)
    if (!best || area < best.area) best = { slotIndex, area }
  }
  return best
}

export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 1e-9) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}
