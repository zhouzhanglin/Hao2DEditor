import type { Skeleton } from '@core/model/skeleton'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { AttachmentData } from '@core/model/types'

/**
 * 骨骼手柄在屏幕上的半径（px）。渲染（boneOverlay）与拾取（pickBoneHandle）
 * 共用同一组数值，改一处即可保持一致。
 */
export const BONE_ORIGIN_RADIUS = 6
export const BONE_TIP_RADIUS = 7

export interface BoneHit {
  boneIndex: number
  distance: number
}

/**
 * 骨骼上的操作区：
 * - `origin`：骨骼原点的关节圈（拖动 = 移动）
 * - `tip`：骨骼末端的手柄（拖动 = 缩放）
 * - `body`：骨骼本体（拖动 = 旋转）
 */
export type BoneHandleZone = 'origin' | 'tip' | 'body'

export interface BoneHandleHit {
  boneIndex: number
  zone: BoneHandleZone
  distance: number
}

/** 单根骨骼的手柄判定：原点圈优先于末端手柄（同一根上两者都不远时，移动更常用） */
function handleZoneOf(
  skeleton: Skeleton,
  index: number,
  x: number,
  y: number,
  handleRadius: number
): BoneHandleHit | null {
  const o = index * 16
  const bx = skeleton.world[o + 12]
  const by = skeleton.world[o + 13]
  const originDistance = Math.hypot(x - bx, y - by)
  if (originDistance <= handleRadius) return { boneIndex: index, zone: 'origin', distance: originDistance }

  const length = skeleton.asset.bones[index].length
  if (length < 1e-4) return null
  const tx = skeleton.world[o] * length + bx
  const ty = skeleton.world[o + 1] * length + by
  const tipDistance = Math.hypot(x - tx, y - ty)
  if (tipDistance <= handleRadius) return { boneIndex: index, zone: 'tip', distance: tipDistance }
  return null
}

/**
 * 骨骼手柄拾取：优先命中原点圈与末端手柄（两者都是屏幕恒定大小，
 * 由调用方按 zoom 换算成世界半径传入），都没有命中时回退到骨骼本体。
 *
 * `preferredBone`（通常是当前选中骨骼）优先判定：骨骼是头尾相接的，
 * 父骨骼的末端手柄会与子骨骼的原点圈落在同一点，不区分就会误判到父骨骼。
 */
export function pickBoneHandle(
  skeleton: Skeleton,
  x: number,
  y: number,
  tolerance: number,
  handleRadius: number,
  preferredBone = -1
): BoneHandleHit | null {
  if (preferredBone >= 0 && preferredBone < skeleton.boneCount) {
    const preferred = handleZoneOf(skeleton, preferredBone, x, y, handleRadius)
    if (preferred) return preferred
  }

  let best: BoneHandleHit | null = null
  for (let i = 0; i < skeleton.boneCount; i++) {
    if (i === preferredBone) continue
    const hit = handleZoneOf(skeleton, i, x, y, handleRadius)
    if (hit && (!best || hit.distance < best.distance)) best = hit
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
