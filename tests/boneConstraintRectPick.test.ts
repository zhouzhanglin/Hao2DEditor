import { describe, expect, it } from 'vitest'
import { pickBonesInRect, pickConstraintsInRect } from '@render/picking'
import type { Skeleton } from '@core/model/skeleton'
import type { Constraint } from '@core/model/constraints'

/**
 * 框选骨骼 / 约束的命中口径（纯函数）。
 *
 * 骨骼：按**线段**（原点 → 末端）判，不是包围盒 —— 一根长骨斜着摆时，
 * 它的 AABB 会盖住一大片空地，框住空地不该选中它。
 * 约束：按**标记锚点**判（IK / 变换 / 路径 = 目标骨，物理 = 被约束骨），外扩一个标记半径。
 */

/** 两根骨骼：root 在原点朝 +x 长 100；child 挂在 (100,0) 朝 +y 长 50 */
function fakeSkeleton(): Skeleton {
  const bones = [
    { name: 'root', parentIndex: -1, inheritRotation: true, length: 100 },
    { name: 'child', parentIndex: 0, inheritRotation: true, length: 50 }
  ]
  const world = new Float32Array(32)
  world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0)
  // child：旋转 90°（局部 x 轴指向世界 +y），平移 (100, 0)
  world.set([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1], 16)
  const localRot = new Float32Array([0, 90])
  return {
    boneCount: 2,
    world,
    localRot,
    asset: { bones },
    boneWorldX: (index: number) => world[index * 16 + 12],
    boneWorldY: (index: number) => world[index * 16 + 13]
  } as unknown as Skeleton
}

const constraints = [
  // IK：准星画在目标骨 child（世界 (100,0)）
  { name: 'ik', type: 'ik', enabled: true, boneIndices: [0], targetBoneIndex: 1 },
  // 物理：圆环画在被约束骨 root 的原点
  { name: 'phys', type: 'physics', enabled: true, boneIndices: [0], targetBoneIndex: -1 },
  // 失效约束不参与框选
  { name: 'off', type: 'ik', enabled: false, boneIndices: [0], targetBoneIndex: 1 }
] as unknown as Constraint[]

describe('框选骨骼：线段与矩形相交', () => {
  it('框到骨骼线段才算命中', () => {
    const skeleton = fakeSkeleton()
    // 横跨 root 的中段
    expect(pickBonesInRect(skeleton, { minX: 40, minY: -5, maxX: 60, maxY: 5 })).toEqual([0])
    // 竖直方向只碰到 child（root 是水平的）
    expect(pickBonesInRect(skeleton, { minX: 95, minY: 20, maxX: 105, maxY: 30 })).toEqual([1])
  })

  it('框在骨骼包围盒里但没有压到线段时不命中', () => {
    const skeleton = fakeSkeleton()
    // root 的 AABB 是 (0..100, 0)，但这条矩形在 (40..60, 30..40)：离线段很远
    expect(pickBonesInRect(skeleton, { minX: 40, minY: 30, maxX: 60, maxY: 40 })).toEqual([])
  })

  it('整块都框住时两根都命中', () => {
    const skeleton = fakeSkeleton()
    expect(pickBonesInRect(skeleton, { minX: -10, minY: -10, maxX: 120, maxY: 60 })).toEqual([0, 1])
  })
})

describe('框选约束：标记锚点 + 半径', () => {
  it('IK 按目标骨位置命中', () => {
    const skeleton = fakeSkeleton()
    expect(pickConstraintsInRect(skeleton, constraints, { minX: 95, minY: -5, maxX: 105, maxY: 5 }, 0)).toEqual([0])
  })

  it('物理按被约束骨原点命中', () => {
    const skeleton = fakeSkeleton()
    expect(pickConstraintsInRect(skeleton, constraints, { minX: -5, minY: -5, maxX: 5, maxY: 5 }, 0)).toEqual([1])
  })

  it('标记半径生效：擦到边缘也算', () => {
    const skeleton = fakeSkeleton()
    // 矩形右边界离 (100,0) 还有 4 个单位，pad = 6 时应当命中
    expect(pickConstraintsInRect(skeleton, constraints, { minX: 90, minY: -3, maxX: 96, maxY: 3 }, 0)).toEqual([])
    expect(pickConstraintsInRect(skeleton, constraints, { minX: 90, minY: -3, maxX: 96, maxY: 3 }, 6)).toEqual([0])
  })

  it('失效约束不参与', () => {
    const skeleton = fakeSkeleton()
    // 只有 off 落在这里（它的目标骨也是 child，但 enabled=false）
    expect(pickConstraintsInRect(skeleton, [constraints[2]], { minX: 90, minY: -10, maxX: 110, maxY: 10 }, 10)).toEqual([])
  })
})
