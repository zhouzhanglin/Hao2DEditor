import { Graphics } from 'pixi.js'
import type { Skeleton } from '@core/model/skeleton'
import type { Constraint } from '@core/model/constraints'

export interface BoneOverlayOptions {
  /** 1 世界单位对应的屏幕像素的倒数（= 1 / zoom），用于保持描边视觉宽度恒定 */
  unitsPerPixel: number
  selectedBone: number
  hoveredBone: number
  showConstraints: boolean
  showSlots: boolean
}

const COLOR_BONE = 0xf97316
const COLOR_BONE_SELECTED = 0x22d3ee
const COLOR_BONE_HOVERED = 0x0ea5e9
const COLOR_JOINT = 0xfbbf24
const COLOR_ROOT = 0x8b5cf6
const COLOR_CONSTRAINT = 0x34d399
const COLOR_LINK = 0x6b6b82

/**
 * 洋葱皮：用**另一时刻**的世界矩阵画一套暗色骨骼作为参考。
 * 只画骨骼线段（不重渲染网格），足以判断前后帧的姿态差异，开销可以忽略。
 */
export function drawGhostBones(
  g: Graphics,
  boneCount: number,
  parentIndices: readonly number[],
  matrices: Float32Array,
  unitsPerPixel: number,
  alpha: number
): void {
  for (let i = 0; i < boneCount; i++) {
    const offset = i * 16
    const x = matrices[offset + 12]
    const y = matrices[offset + 13]
    const parent = parentIndices[i]
    const px = parent >= 0 ? matrices[parent * 16 + 12] : x
    const py = parent >= 0 ? matrices[parent * 16 + 13] : y
    g.moveTo(px, py).lineTo(x, y)
  }
  g.stroke({ width: unitsPerPixel * 1.6, color: 0x8B5CF6, alpha })
}

/**
 * 骨骼线框 + 关节 + 约束目标连线（画在世界容器里，y 轴向上）。
 *
 * 描边与填充必须用**两个 Graphics**：pixi v8 中 stroke() 之后的路径仍会被后续
 * fill() 填充，混用会画出一整块覆盖角色的色斑。
 */
export function drawBoneOverlay(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  options: BoneOverlayOptions
): void {
  strokes.clear()
  fills.clear()
  const g = strokes
  const w = options.unitsPerPixel
  const boneCount = skeleton.boneCount

  const normal: number[] = []
  const selected: number[] = []
  for (let i = 0; i < boneCount; i++) {
    const o = i * 16
    const x = skeleton.world[o + 12]
    const y = skeleton.world[o + 13]
    const length = Math.max(skeleton.asset.bones[i].length, 0.0001)
    const tx = skeleton.world[o] * length + x
    const ty = skeleton.world[o + 1] * length + y
    const target = i === options.selectedBone ? selected : i === options.hoveredBone ? selected : normal
    target.push(x, y, tx, ty)
  }

  // 描边按视觉宽度分层：普通骨骼细、选中/悬停骨骼粗
  strokeSegments(g, normal, w * 1.4, COLOR_BONE, 0.95)
  strokeSegments(g, selected, w * 2.4, COLOR_BONE_SELECTED, 1)

  if (options.showSlots) {
    for (let i = 0; i < skeleton.slotCount; i++) {
      const slot = skeleton.asset.slots[i]
      if (slot.boneIndex < 0) continue
      const o = slot.boneIndex * 16
      const x = skeleton.world[o + 12]
      const y = skeleton.world[o + 13]
      const r = w * 2
      g.moveTo(x - r, y).lineTo(x + r, y)
      g.moveTo(x, y - r).lineTo(x, y + r)
      g.stroke({ width: w * 1, color: COLOR_LINK, alpha: 0.6 })
    }
  }

  // 关节与根骨骼标记（画在填充层）
  for (let i = 0; i < boneCount; i++) {
    const o = i * 16
    const x = skeleton.world[o + 12]
    const y = skeleton.world[o + 13]
    const isRoot = skeleton.asset.bones[i].parentIndex < 0
    const isSelected = i === options.selectedBone
    const r = (isSelected ? 4 : 2.6) * w
    fills.circle(x, y, r)
    fills.fill({
      color: isRoot ? COLOR_ROOT : isSelected ? COLOR_BONE_SELECTED : COLOR_JOINT,
      alpha: isRoot || isSelected ? 1 : 0.9
    })
  }

  if (options.showConstraints) drawConstraintLinks(g, skeleton, constraints, w)
}

function drawConstraintLinks(
  g: Graphics,
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  w: number
): void {
  for (const constraint of constraints) {
    if (!constraint.enabled || constraint.type === 'physics') continue
    if (constraint.targetBoneIndex < 0) continue
    const targetX = skeleton.boneWorldX(constraint.targetBoneIndex)
    const targetY = skeleton.boneWorldY(constraint.targetBoneIndex)

    for (const bone of constraint.boneIndices) {
      if (bone < 0 || bone >= skeleton.boneCount) continue
      const x = skeleton.boneWorldX(bone)
      const y = skeleton.boneWorldY(bone)
      g.moveTo(x, y).lineTo(targetX, targetY)
      g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.7 })
    }

    const size = w * 5
    g.moveTo(targetX - size, targetY).lineTo(targetX + size, targetY)
    g.moveTo(targetX, targetY - size).lineTo(targetX, targetY + size)
    g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.85 })
  }
}

function strokeSegments(
  g: Graphics,
  segments: number[],
  width: number,
  color: number,
  alpha: number
): void {
  if (segments.length === 0) return
  for (let i = 0; i < segments.length; i += 4) {
    g.moveTo(segments[i], segments[i + 1]).lineTo(segments[i + 2], segments[i + 3])
  }
  g.stroke({ width, color, alpha })
}
