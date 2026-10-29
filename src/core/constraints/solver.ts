import { clamp, DEG2RAD, lerpAngle, RAD2DEG } from '../math/utils'
import type { Skeleton } from '../model/skeleton'
import type { Constraint, IkConstraint, PathConstraint, TransformConstraint } from '../model/constraints'
import { sortConstraints } from '../model/constraints'
import { setupPoseOf } from '../model/setup'

/**
 * 约束的每帧可变状态（由动画轨道覆盖；无轨道时取约束自身的静态值）。
 * Unity 端 Hao2D 运行时只有 IK 的 mix；transform / path 的全部参数都可由轨道驱动。
 */
export interface ConstraintState {
  mix: number
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
  position: number
  spacing: number
  rotateMix: number
  translateMix: number
}

export function defaultConstraintState(constraint: Constraint): ConstraintState {
  const state: ConstraintState = {
    mix: 1,
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
    position: 0,
    spacing: 0,
    rotateMix: 1,
    translateMix: 1
  }
  if (constraint.type === 'ik') {
    state.mix = constraint.mix
  } else if (constraint.type === 'transform') {
    state.mixRotate = constraint.mixRotate
    state.mixX = constraint.mixX
    state.mixY = constraint.mixY
    state.mixScaleX = constraint.mixScaleX
    state.mixScaleY = constraint.mixScaleY
    state.mixShearY = constraint.mixShearY
    state.offsetRotate = constraint.offsetRotate
    state.offsetX = constraint.offsetX
    state.offsetY = constraint.offsetY
    state.offsetScaleX = constraint.offsetScaleX
    state.offsetScaleY = constraint.offsetScaleY
    state.offsetShearY = constraint.offsetShearY
  } else if (constraint.type === 'path') {
    state.position = constraint.position
    state.spacing = constraint.spacing
    state.rotateMix = constraint.rotateMix
    state.translateMix = constraint.translateMix
  }
  return state
}

export function createConstraintStates(constraints: readonly Constraint[]): ConstraintState[] {
  return constraints.map(defaultConstraintState)
}

export function resetConstraintStates(constraints: readonly Constraint[], states: ConstraintState[]): void {
  const count = Math.min(constraints.length, states.length)
  for (let i = 0; i < count; i++) Object.assign(states[i], defaultConstraintState(constraints[i]))
}

/**
 * 求解全部约束：按 order 升序，ik → transform → path。
 * 物理约束只做数据保留，不参与求解。
 */
export function solveConstraints(
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  states: readonly ConstraintState[]
): void {
  if (constraints.length === 0) return

  /*
   * 求解前先把每条约束的目标世界坐标快照下来（供视口叠加层画准星 / 连线）。
   *
   * 求解会重算链上骨骼**及其后代**的世界矩阵；目标骨若挂在链下方，它的位置在求解后
   * 就变了。叠加层读这份快照 = 画在 IK 真正瞄准的那个点上（见 Skeleton.constraintTarget），
   * 否则准星每帧在「动画位置 / 被推走的位置」之间来回，看起来就是跟不上动画、在抖。
   */
  const targets = skeleton.constraintTarget
  for (let i = 0; i < constraints.length; i++) {
    const constraint = constraints[i]
    const target = constraint.targetBoneIndex
    const valid = constraint.type !== 'physics' && target >= 0 && target < skeleton.boneCount
    targets[i * 2] = valid ? skeleton.boneWorldX(target) : Number.NaN
    targets[i * 2 + 1] = valid ? skeleton.boneWorldY(target) : Number.NaN
  }

  for (const constraint of sortConstraints(constraints)) {
    if (!constraint.enabled || constraint.type === 'physics') continue
    let state: ConstraintState | undefined
    for (let i = 0; i < constraints.length; i++) {
      if (constraints[i] === constraint) {
        state = states[i]
        break
      }
    }
    const resolved = state ?? defaultConstraintState(constraint)
    if (constraint.type === 'ik') solveIk(skeleton, constraint, resolved)
    else if (constraint.type === 'transform') solveTransform(skeleton, constraint, resolved)
    else if (constraint.type === 'path') solvePath(skeleton, constraint, resolved)
  }
}

// ---------------- 通用工具 ----------------

/**
 * 设置骨骼的世界朝向（考虑父世界旋转与 inheritRotation），按 mix 插值。
 *
 * mix 在**世界空间**做（先算目标世界角再换算局部）。局部角不能用「世界角 − 父世界角」
 * 直接相减：父骨骼镜像（scaleX < 0，本资产 move 骨骼就是这样翻转朝向的）或带非等比缩放时，
 * 局部角到世界角不是平移关系，相减会把整条子链甩到别处。这里用父矩阵线性部分求逆，
 * 把「期望的世界 x 轴朝向」反解成局部角。
 */
function setWorldRotation(skeleton: Skeleton, boneIndex: number, worldDeg: number, mix: number): void {
  const bone = skeleton.asset.bones[boneIndex]
  const parent = bone.parentIndex
  const dest = mix >= 1 ? worldDeg : lerpAngle(skeleton.worldRot[boneIndex], worldDeg, mix)
  if (parent < 0 || !bone.inheritRotation) {
    skeleton.localRot[boneIndex] = dest
    return
  }
  const o = parent * 16
  const pa = skeleton.world[o]
  const pb = skeleton.world[o + 4]
  const pc = skeleton.world[o + 1]
  const pd = skeleton.world[o + 5]
  const det = pa * pd - pb * pc
  if (Math.abs(det) < 1e-8) {
    skeleton.localRot[boneIndex] = dest - skeleton.worldRot[parent]
    return
  }
  const rad = dest * DEG2RAD
  const wx = Math.cos(rad)
  const wy = Math.sin(rad)
  // 父矩阵的逆作用在世界 x 轴方向上，得到局部 x 轴朝向
  const lx = (pd * wx - pb * wy) / det
  const ly = (-pc * wx + pa * wy) / det
  skeleton.localRot[boneIndex] = Math.atan2(ly, lx) * RAD2DEG
}

function worldScaleX(skeleton: Skeleton, boneIndex: number): number {
  const o = boneIndex * 16
  return Math.hypot(skeleton.world[o], skeleton.world[o + 1])
}

function worldScaleY(skeleton: Skeleton, boneIndex: number): number {
  const o = boneIndex * 16
  return Math.hypot(skeleton.world[o + 4], skeleton.world[o + 5])
}

/** 世界 Y 轴角度（度） */
function worldAxisY(skeleton: Skeleton, boneIndex: number): number {
  const o = boneIndex * 16
  return Math.atan2(skeleton.world[o + 5], skeleton.world[o + 4]) * RAD2DEG
}

/** 把世界坐标点换算成某骨骼下的局部坐标（用父矩阵线性部分求逆） */
function worldToLocal(
  skeleton: Skeleton,
  boneIndex: number,
  worldX: number,
  worldY: number
): { x: number; y: number } | null {
  const parent = skeleton.asset.bones[boneIndex].parentIndex
  if (parent < 0) return { x: worldX, y: worldY }
  const o = parent * 16
  const pa = skeleton.world[o]
  const pb = skeleton.world[o + 4]
  const pc = skeleton.world[o + 1]
  const pd = skeleton.world[o + 5]
  const det = pa * pd - pb * pc
  if (Math.abs(det) < 1e-8) return null
  const dx = worldX - skeleton.world[o + 12]
  const dy = worldY - skeleton.world[o + 13]
  return { x: (pd * dx - pb * dy) / det, y: (-pc * dx + pa * dy) / det }
}

// ---------------- IK ----------------

function solveIk(skeleton: Skeleton, ik: IkConstraint, state: ConstraintState): void {
  if (state.mix <= 0 || ik.boneIndices.length === 0) return
  if (ik.targetBoneIndex < 0 || ik.targetBoneIndex >= skeleton.boneCount) return
  for (const b of ik.boneIndices) if (b < 0 || b >= skeleton.boneCount) return
  if (ik.boneIndices.length === 2) solveIkTwoBone(skeleton, ik, state)
  else solveIkCcd(skeleton, ik, state)
}

/**
 * 两骨解析解（余弦定理），对齐 Unity 端 Hao2D 运行时 IkSolver：
 * - l1：useBoneLength 为真时取「根骨 length × |worldScale.x|」（DragonBones），
 *   否则取父骨骼原点 → 子骨骼原点的实际距离（Spine）
 * - l2：子骨 length × |worldScale.x|
 * - 够不到时把 dist 夹到 l1 + l2
 * - 分两步：先设根骨世界朝向再增量重算 FK，然后按实际膝盖位置设子骨朝向
 */
function solveIkTwoBone(skeleton: Skeleton, ik: IkConstraint, state: ConstraintState): void {
  const b0 = ik.boneIndices[0]
  const b1 = ik.boneIndices[1]
  const target = ik.targetBoneIndex

  const p0x = skeleton.boneWorldX(b0)
  const p0y = skeleton.boneWorldY(b0)
  const tx = skeleton.boneWorldX(target)
  const ty = skeleton.boneWorldY(target)

  const l1 = ik.useBoneLength
    ? skeleton.asset.bones[b0].length * Math.abs(skeleton.worldScale[b0 * 2])
    : Math.hypot(skeleton.boneWorldX(b1) - p0x, skeleton.boneWorldY(b1) - p0y)
  const l2 = skeleton.asset.bones[b1].length * Math.abs(skeleton.worldScale[b1 * 2])
  if (l1 <= 1e-6 || l2 <= 1e-6) return

  let dx = tx - p0x
  let dy = ty - p0y
  let dist = Math.hypot(dx, dy)
  if (dist < 1e-6) return
  const ux = dx / dist
  const uy = dy / dist
  if (dist > l1 + l2) dist = l1 + l2

  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1)
  const a1 = Math.acos(cosA) * RAD2DEG
  const side = ik.bendSign >= 0 ? 1 : -1
  const rootDeg = Math.atan2(uy, ux) * RAD2DEG + a1 * side

  setWorldRotation(skeleton, b0, rootDeg, state.mix)
  skeleton.updateFkFrom(b0)

  const endDeg = Math.atan2(ty - skeleton.boneWorldY(b1), tx - skeleton.boneWorldX(b1)) * RAD2DEG
  setWorldRotation(skeleton, b1, endDeg, state.mix)
  skeleton.updateFkFrom(b1)
}

/** CCD：固定 5 次迭代，每次从链尾到根 */
function solveIkCcd(skeleton: Skeleton, ik: IkConstraint, state: ConstraintState): void {
  const chain = ik.boneIndices
  const target = ik.targetBoneIndex
  const last = chain.length - 1
  const tipBone = chain[last]

  for (let iter = 0; iter < 5; iter++) {
    for (let i = last; i >= 0; i--) {
      const bone = chain[i]
      const jx = skeleton.boneWorldX(bone)
      const jy = skeleton.boneWorldY(bone)
      const tip = tipPosition(skeleton, tipBone)
      const toEndX = tip.x - jx
      const toEndY = tip.y - jy
      const toTargetX = skeleton.boneWorldX(target) - jx
      const toTargetY = skeleton.boneWorldY(target) - jy
      if (Math.hypot(toEndX, toEndY) < 1e-6 || Math.hypot(toTargetX, toTargetY) < 1e-6) continue
      const angle = (Math.atan2(toTargetY, toTargetX) - Math.atan2(toEndY, toEndX)) * RAD2DEG
      skeleton.localRot[bone] += angle * state.mix
      skeleton.updateFkFrom(bone)
    }
  }
}

/** 骨骼长度沿世界 X 轴延伸得到的末端点 */
function tipPosition(skeleton: Skeleton, boneIndex: number): { x: number; y: number } {
  const o = boneIndex * 16
  const len = skeleton.asset.bones[boneIndex].length
  return {
    x: skeleton.world[o] * len + skeleton.world[o + 12],
    y: skeleton.world[o + 1] * len + skeleton.world[o + 13]
  }
}

// ---------------- 变换约束 ----------------

/**
 * 变换约束：受约束骨骼按 mix 向「目标骨骼变换 + 偏移」靠拢。
 * - local = true 用目标骨骼的局部变换，否则用世界变换
 * - relative = true 时叠加目标相对 setup 的增量，而不是直接对齐
 * - inherit 决定从目标变换中剔除哪些分量（normal 全取 / onlyTranslation 只取平移 /
 *   noRotationOrReflection 去掉旋转 / noScale 与 noScaleOrReflection 去掉缩放）
 * - 偏移量（x/y/rotation/shearY）始终是**目标骨骼空间**里的量：世界模式要跟着目标的
 *   旋转/缩放/镜像换算（Spine `target.localToWorld`），局部模式直接用，见下方注释
 */
function solveTransform(skeleton: Skeleton, c: TransformConstraint, state: ConstraintState): void {
  const target = c.targetBoneIndex
  if (target < 0 || target >= skeleton.boneCount) return

  const setup = setupPoseOf(skeleton.asset)
  const useLocal = c.local
  const skipRotation = c.inherit === 'onlyTranslation' || c.inherit === 'noRotationOrReflection'
  const skipScale =
    c.inherit === 'onlyTranslation' ||
    c.inherit === 'noScale' ||
    c.inherit === 'noScaleOrReflection'

  const targetRot = useLocal ? skeleton.localRot[target] : skeleton.worldRot[target]
  const setupTargetRot = useLocal ? setup.rot[target] : setup.worldRot[target]
  const targetPosX = useLocal ? skeleton.localPos[target * 2] : skeleton.boneWorldX(target)
  const targetPosY = useLocal ? skeleton.localPos[target * 2 + 1] : skeleton.boneWorldY(target)
  const setupTargetPosX = useLocal ? setup.pos[target * 2] : setup.world[target * 16 + 12]
  const setupTargetPosY = useLocal ? setup.pos[target * 2 + 1] : setup.world[target * 16 + 13]
  const targetScaleX = useLocal ? skeleton.localScale[target * 2] : worldScaleX(skeleton, target)
  const targetScaleY = useLocal ? skeleton.localScale[target * 2 + 1] : worldScaleY(skeleton, target)
  const setupTargetScaleX = useLocal ? setup.scale[target * 2] : setup.worldScale[target * 2]
  const setupTargetScaleY = useLocal ? setup.scale[target * 2 + 1] : setup.worldScale[target * 2 + 1]
  const targetShearY = useLocal
    ? skeleton.localShear[target * 2 + 1]
    : worldAxisY(skeleton, target) - skeleton.worldRot[target] - 90

  /*
   * 世界模式下 x/y/rotation/shearY 这几个偏移量都是**目标骨骼局部空间**的坐标
   * （Spine 的 `target.localToWorld(offset)`）：要跟着目标的旋转、缩放和镜像一起转，
   * 不能当成世界单位直接加。早先直接加世界单位，本站 head 约束（translateMix 0.4，
   * 偏移 -97.08 / 20.21）就把头甩到了身体外面 —— 而它正确的位置几乎就是偏移换算后
   * 落在的位置（约束本意只是微调）。
   */
  const to = target * 16
  const ta = skeleton.world[to]
  const tb = skeleton.world[to + 4]
  const tc = skeleton.world[to + 1]
  const td = skeleton.world[to + 5]
  // 目标被镜像（行列式为负）时，角度类偏移要反向（Spine 的 degRadReflect）
  const reflect = ta * td - tb * tc > 0 ? 1 : -1
  const offsetRotate = useLocal ? state.offsetRotate : state.offsetRotate * reflect
  const offsetShearY = useLocal ? state.offsetShearY : state.offsetShearY * reflect
  // 平移偏移换到世界空间：只走目标矩阵的线性部分（旋转 + 缩放 + 镜像），平移另行加入
  const offsetX = useLocal ? state.offsetX : ta * state.offsetX + tb * state.offsetY
  const offsetY = useLocal ? state.offsetY : tc * state.offsetX + td * state.offsetY

  for (const bone of c.boneIndices) {
    if (bone < 0 || bone >= skeleton.boneCount) continue

    if (!skipRotation && state.mixRotate > 0) {
      const want = c.relative
        ? skeleton.worldRot[bone] + (targetRot - setupTargetRot) + offsetRotate
        : targetRot + offsetRotate
      setWorldRotation(skeleton, bone, want, state.mixRotate)
      skeleton.updateFkFrom(bone)
    }

    if (!skipScale && (state.mixScaleX > 0 || state.mixScaleY > 0)) {
      const curX = worldScaleX(skeleton, bone)
      const curY = worldScaleY(skeleton, bone)
      const wantX = c.relative ? curX + (targetScaleX - setupTargetScaleX) : targetScaleX
      const wantY = c.relative ? curY + (targetScaleY - setupTargetScaleY) : targetScaleY
      const factorX = curX > 1e-8 ? (wantX + state.offsetScaleX) / curX : 1
      const factorY = curY > 1e-8 ? (wantY + state.offsetScaleY) / curY : 1
      skeleton.localScale[bone * 2] *= 1 + (factorX - 1) * state.mixScaleX
      skeleton.localScale[bone * 2 + 1] *= 1 + (factorY - 1) * state.mixScaleY
      skeleton.updateFkFrom(bone)

      if (state.mixShearY > 0) {
        const wantShear = c.relative
          ? skeleton.localShear[bone * 2 + 1] + (targetShearY - setup.shear[target * 2 + 1]) + offsetShearY
          : targetShearY + offsetShearY
        skeleton.localShear[bone * 2 + 1] = lerpAngle(
          skeleton.localShear[bone * 2 + 1],
          wantShear,
          state.mixShearY
        )
        skeleton.updateFkFrom(bone)
      }
    }

    if (c.inherit !== 'onlyTranslation' && (state.mixX > 0 || state.mixY > 0)) {
      if (useLocal) {
        // 局部模式：目标和自身都用「相对父骨」的局部坐标，直接改 localPos
        const curX = skeleton.localPos[bone * 2]
        const curY = skeleton.localPos[bone * 2 + 1]
        const wantX = c.relative ? targetPosX - setupTargetPosX : targetPosX
        const wantY = c.relative ? targetPosY - setupTargetPosY : targetPosY
        skeleton.localPos[bone * 2] = curX + (wantX + offsetX - curX) * state.mixX
        skeleton.localPos[bone * 2 + 1] = curY + (wantY + offsetY - curY) * state.mixY
        skeleton.updateFkFrom(bone)
      } else {
        const curX = skeleton.boneWorldX(bone)
        const curY = skeleton.boneWorldY(bone)
        const wantX = c.relative ? curX + (targetPosX - setupTargetPosX) : targetPosX
        const wantY = c.relative ? curY + (targetPosY - setupTargetPosY) : targetPosY
        /*
         * 混合在**世界空间**做：世界模式的偏移量已经换到世界空间（见上），父骨骼带
         * 旋转/镜像时「先转局部再混」和「先混再转局部」并不等价。
         */
        const destX = curX + (wantX + offsetX - curX) * state.mixX
        const destY = curY + (wantY + offsetY - curY) * state.mixY
        const local = worldToLocal(skeleton, bone, destX, destY)
        if (local) {
          skeleton.localPos[bone * 2] = local.x
          skeleton.localPos[bone * 2 + 1] = local.y
          skeleton.updateFkFrom(bone)
        }
      }
    }
  }
}

// ---------------- 路径约束 ----------------

/**
 * 路径约束（简化实现）：把目标骨骼链的关节连成折线作为路径，
 * 沿路径按 position / spacing 放置受约束骨骼，并按切线朝向旋转。
 * spacingMode：length 用世界长度；percent 用路径总长的百分比。
 */
function solvePath(skeleton: Skeleton, c: PathConstraint, state: ConstraintState): void {
  const points: Array<{ x: number; y: number }> = []
  const chain = [c.targetBoneIndex, ...c.boneIndices]
  for (const bone of chain) {
    if (bone < 0 || bone >= skeleton.boneCount) continue
    points.push({ x: skeleton.boneWorldX(bone), y: skeleton.boneWorldY(bone) })
  }
  if (points.length < 2) return

  const segments: Array<{ x: number; y: number; dx: number; dy: number; len: number; start: number }> = []
  let total = 0
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dy = points[i + 1].y - points[i].y
    const len = Math.hypot(dx, dy)
    segments.push({ x: points[i].x, y: points[i].y, dx, dy, len, start: total })
    total += len
  }
  if (total < 1e-6) return

  const constrained = c.boneIndices.filter((b) => b >= 0 && b < skeleton.boneCount)
  for (let i = 0; i < constrained.length; i++) {
    const bone = constrained[i]
    const offset =
      c.spacingMode === 'percent'
        ? (state.position + state.spacing * i) * total
        : state.position + state.spacing * i
    const hit = samplePath(segments, total, offset)
    if (!hit) continue

    if (state.translateMix > 0) {
      const local = worldToLocal(skeleton, bone, hit.x, hit.y)
      if (local) {
        skeleton.localPos[bone * 2] += (local.x - skeleton.localPos[bone * 2]) * state.translateMix
        skeleton.localPos[bone * 2 + 1] += (local.y - skeleton.localPos[bone * 2 + 1]) * state.translateMix
        skeleton.updateFkFrom(bone)
      }
    }

    if (state.rotateMix > 0) {
      setWorldRotation(skeleton, bone, hit.deg, state.rotateMix)
      skeleton.updateFkFrom(bone)
    }
  }
}

function samplePath(
  segments: Array<{ x: number; y: number; dx: number; dy: number; len: number; start: number }>,
  total: number,
  distance: number
): { x: number; y: number; deg: number } | null {
  if (distance < 0 || distance > total) return null
  for (const seg of segments) {
    if (distance > seg.start + seg.len) continue
    const t = seg.len <= 1e-6 ? 0 : (distance - seg.start) / seg.len
    return {
      x: seg.x + seg.dx * t,
      y: seg.y + seg.dy * t,
      deg: Math.atan2(seg.dy, seg.dx) * RAD2DEG
    }
  }
  return null
}
