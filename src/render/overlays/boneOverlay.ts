import { Graphics } from 'pixi.js'
import type { Skeleton } from '@core/model/skeleton'
import type { Constraint } from '@core/model/constraints'
import { BONE_ORIGIN_RADIUS, BONE_TIP_RADIUS } from '@render/picking'

export interface BoneOverlayOptions {
  /** 1 世界单位对应的屏幕像素的倒数（= 1 / zoom），用于保持描边视觉宽度恒定 */
  unitsPerPixel: number
  selectedBone: number
  hoveredBone: number
  showConstraints: boolean
  showSlots: boolean
  /** 需要画成空心的骨骼名（来自编辑期模型的 hollow 选项，默认全是实心） */
  hollowBones?: ReadonlySet<string>
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
 * 骨骼绘制 + 关节 + 约束目标连线（画在世界容器里，y 轴向上）。
 *
 * 骨骼体是 Spine 风格的**风筝形四边形**：原点收成顶点 → 沿骨骼方向张开到两个肩点 →
 * 再收成末端尖端；骨骼原点（关节处）画一个空心圆圈。
 * 每个骨骼可以选实心（默认，半透明填充 + 描边）或空心（只描边），
 * 空心标记来自编辑期模型的 `hollow`（按骨骼名匹配，运行时模型不带该字段）。
 *
 * 描边与填充必须用**两个 Graphics**：pixi v8 中 stroke() 之后的路径仍会被后续
 * fill() 填充，混用会画出一整块覆盖角色的色斑。
 */
/**
 * 绘制骨骼体、原点圈与**末端缩放手柄**（仅选中骨骼绘制手柄，避免画面噪点）。
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

  // 骨骼体（四边形）+ 原点圈
  for (let i = 0; i < boneCount; i++) {
    const o = i * 16
    const x = skeleton.world[o + 12]
    const y = skeleton.world[o + 13]
    const length = skeleton.asset.bones[i].length
    const isSelected = i === options.selectedBone
    const isHovered = i === options.hoveredBone
    const isRoot = skeleton.asset.bones[i].parentIndex < 0
    const active = isSelected || isHovered
    const color = active ? COLOR_BONE_SELECTED : COLOR_BONE

    const dx = skeleton.world[o] * length
    const dy = skeleton.world[o + 1] * length
    const norm = Math.hypot(dx, dy)

    if (length >= 1e-4 && norm >= 1e-6) {
      const tx = x + dx
      const ty = y + dy
      const dirX = dx / norm
      const dirY = dy / norm
      const px = -dirY
      const py = dirX
      // Spine 风格风筝形：原点收成顶点 → 沿骨骼方向张开到两个肩点 → 收成末端尖端
      const shoulder = length * 0.09
      const halfW = Math.min(Math.max(length * 0.05, w * 2.2), length * 0.4)
      const sx = x + dirX * shoulder
      const sy = y + dirY * shoulder
      const quad = [
        x,
        y, // 顶点（骨骼原点，正对关节圈）
        sx + px * halfW,
        sy + py * halfW, // 左肩
        tx,
        ty, // 末端尖端
        sx - px * halfW,
        sy - py * halfW // 右肩
      ]
      const hollow = options.hollowBones?.has(skeleton.asset.bones[i].name) ?? false
      if (!hollow) fills.poly(quad).fill({ color, alpha: active ? 0.55 : 0.4 })
      strokes.poly(quad).stroke({ width: w * (isSelected ? 1.8 : 1.2), color, alpha: hollow ? 1 : 0.9 })

      // 选中骨骼在末端画缩放手柄（方块，屏幕恒定大小），拖动它即可缩放
      if (isSelected) {
        const r = w * BONE_TIP_RADIUS
        fills
          .poly([tx - r, ty - r, tx + r, ty - r, tx + r, ty + r, tx - r, ty + r])
          .fill({ color: COLOR_BONE_SELECTED, alpha: 0.3 })
        strokes
          .poly([tx - r, ty - r, tx + r, ty - r, tx + r, ty + r, tx - r, ty + r])
          .stroke({ width: w * 1.6, color: COLOR_BONE_SELECTED, alpha: 1 })
      }
    }

    // 原点（骨骼头）画一个圈：空心环，根骨骼 / 选中骨骼用各自的强调色。
    // 半径与拾取用的 BONE_ORIGIN_RADIUS 一致（拖这个圈 = 移动骨骼）
    const r = (isSelected ? BONE_ORIGIN_RADIUS + 1.5 : BONE_ORIGIN_RADIUS - 0.5) * w
    strokes
      .circle(x, y, r)
      .stroke({
        width: w * (isSelected ? 2.2 : 1.8),
        color: isRoot ? COLOR_ROOT : active ? COLOR_BONE_SELECTED : COLOR_JOINT,
        alpha: isRoot || active ? 1 : 0.9
      })
  }

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
