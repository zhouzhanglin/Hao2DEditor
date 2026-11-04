import type { Vec2 } from '../math/matrix'

/**
 * 约束系统。
 *
 * 求解顺序：按 order 升序，依次 ik → transform → path → physics。
 * - IK / 变换 / 路径：改骨骼局部姿态（`.hao2d` v10 起只有 IK 能落盘）；
 * - 物理：按 Spine 4.3 的弹簧/惯性模型仿真，见 `core/constraints/physicsSolver.ts`；
 *   标了 `*Global` 的参数由动画的「全局物理轨道」驱动（与 Spine 的 constraintIndex = -1 一致）。
 */
export type ConstraintType = 'ik' | 'transform' | 'path' | 'physics'

export type InheritMode =
  | 'normal'
  | 'onlyTranslation'
  | 'noRotationOrReflection'
  | 'noScale'
  | 'noScaleOrReflection'

export interface ConstraintBase {
  name: string
  type: ConstraintType
  /** 求解顺序，越小越先 */
  order: number
  enabled: boolean
  /** 受约束的骨骼链（下标按骨骼数组） */
  boneIndices: number[]
  /** 目标骨骼下标，-1 表示无目标 */
  targetBoneIndex: number
}

export interface IkConstraint extends ConstraintBase {
  type: 'ik'
  /** 0..1 */
  mix: number
  /** 弯曲方向 +1 / -1 */
  bendSign: number
  /**
   * l1 取法：
   * - false（Spine）：父骨骼原点 → 子骨骼原点的实际距离
   * - true（DragonBones）：根骨骼 length × |worldScale.x|
   */
  useBoneLength: boolean
  compress: boolean
  stretch: boolean
  softness: number
}

export interface TransformConstraint extends ConstraintBase {
  type: 'transform'
  mixRotate: number
  mixX: number
  mixY: number
  mixScaleX: number
  mixScaleY: number
  mixShearY: number
  offsetRotate: number
  offsetX: number
  offsetY: number
  offsetScaleX: number
  offsetScaleY: number
  offsetShearY: number
  /** 相对模式：在目标增量基础上叠加而不是对齐 */
  relative: boolean
  /** 使用目标骨骼的局部变换而非世界变换 */
  local: boolean
  inherit: InheritMode
}

export type PathPositionMode = 'percent' | 'fixed'
export type PathSpacingMode = 'length' | 'fixed' | 'percent'
export type PathRotateMode = 'chain' | 'chainScale' | 'tangent'

export interface PathConstraint extends ConstraintBase {
  type: 'path'
  position: number
  spacing: number
  rotateMix: number
  translateMix: number
  positionMode: PathPositionMode
  spacingMode: PathSpacingMode
  rotateMode: PathRotateMode
}

/** scaleY 的处理方式（对齐 Spine 的 ScaleYMode）。 */
export type PhysicsScaleYMode = 0 | 1 | 2   // 0 = 不处理 / 1 = Uniform / 2 = Volume

/**
 * 物理约束：单根骨骼相对父骨骼的弹簧-惯性仿真（Spine 4.3 语义）。
 *
 * 字段顺序与语义严格对齐 Spine：`x/y/rotate/scaleX/shearX` 是五个「影响通道」（0..1），
 * `inertia/strength/damping/mass/wind/gravity/mix` 是动力学参数，
 * `limit` 限制单帧位移参与仿真的幅度，`step`（秒）是固定仿真步长。
 * `*Global` 为真时该参数改由 `sliderIndices` 指向的滑块约束取值。
 */
export interface PhysicsConstraint extends ConstraintBase {
  type: 'physics'
  x: number
  y: number
  rotate: number
  scaleX: number
  shearX: number
  limit: number
  /** 固定仿真步长（秒） */
  step: number
  scaleYMode: PhysicsScaleYMode
  inertia: number
  strength: number
  /** 质量（>0）；运行期用 1/mass 参与计算 */
  mass: number
  damping: number
  wind: number
  gravity: number
  mix: number
  inertiaGlobal: boolean
  strengthGlobal: boolean
  dampingGlobal: boolean
  massGlobal: boolean
  windGlobal: boolean
  gravityGlobal: boolean
  mixGlobal: boolean
}

export type Constraint = IkConstraint | TransformConstraint | PathConstraint | PhysicsConstraint

export const CONSTRAINT_ORDER: Record<ConstraintType, number> = {
  ik: 0,
  transform: 1,
  path: 2,
  physics: 3
}

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  ik: 'IK',
  transform: '变换',
  path: '路径',
  physics: '物理'
}

export function createIkConstraint(partial?: Partial<IkConstraint>): IkConstraint {
  return {
    name: 'ik',
    type: 'ik',
    order: 0,
    enabled: true,
    boneIndices: [],
    targetBoneIndex: -1,
    mix: 1,
    bendSign: 1,
    useBoneLength: false,
    compress: false,
    stretch: false,
    softness: 0,
    ...partial
  }
}

export function createTransformConstraint(partial?: Partial<TransformConstraint>): TransformConstraint {
  return {
    name: 'transform',
    type: 'transform',
    order: 0,
    enabled: true,
    boneIndices: [],
    targetBoneIndex: -1,
    mixRotate: 1,
    mixX: 1,
    mixY: 1,
    mixScaleX: 1,
    mixScaleY: 1,
    mixShearY: 1,
    offsetRotate: 0,
    offsetX: 0,
    offsetY: 0,
    offsetScaleX: 0,
    offsetScaleY: 0,
    offsetShearY: 0,
    relative: false,
    local: false,
    inherit: 'normal',
    ...partial
  }
}

export function createPathConstraint(partial?: Partial<PathConstraint>): PathConstraint {
  return {
    name: 'path',
    type: 'path',
    order: 0,
    enabled: true,
    boneIndices: [],
    targetBoneIndex: -1,
    position: 0,
    spacing: 0,
    rotateMix: 1,
    translateMix: 1,
    positionMode: 'percent',
    spacingMode: 'length',
    rotateMode: 'chain',
    ...partial
  }
}

export function createPhysicsConstraint(partial?: Partial<PhysicsConstraint>): PhysicsConstraint {
  return {
    name: 'physics',
    type: 'physics',
    order: 0,
    enabled: true,
    boneIndices: [],
    targetBoneIndex: -1,
    // 默认值取 Spine 编辑器的物理约束默认参数
    x: 0,
    y: 0,
    rotate: 0,
    scaleX: 0,
    shearX: 0,
    limit: 0.1,
    step: 1 / 60,
    scaleYMode: 1,
    inertia: 1,
    strength: 100,
    mass: 1,
    damping: 1,
    wind: 0,
    gravity: 0,
    mix: 1,
    inertiaGlobal: false,
    strengthGlobal: false,
    dampingGlobal: false,
    massGlobal: false,
    windGlobal: false,
    gravityGlobal: false,
    mixGlobal: false,
    ...partial
  }
}

/** 按 order 升序（同 order 时 ik 先于 transform 先于 path 先于 physics）稳定排序 */
export function sortConstraints(constraints: readonly Constraint[]): Constraint[] {
  return [...constraints]
    .map((constraint, index) => ({ constraint, index }))
    .sort((a, b) => {
      const byOrder = a.constraint.order - b.constraint.order
      if (byOrder !== 0) return byOrder
      const byType = CONSTRAINT_ORDER[a.constraint.type] - CONSTRAINT_ORDER[b.constraint.type]
      if (byType !== 0) return byType
      return a.index - b.index
    })
    .map((entry) => entry.constraint)
}

export interface ConstraintLocalPoint {
  constraintName: string
  type: ConstraintType
  target: Vec2 | null
  chain: Vec2[]
}
