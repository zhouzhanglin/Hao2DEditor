import type { Skeleton } from '../model/skeleton'
import type { Constraint, PhysicsConstraint } from '../model/constraints'
import { RAD2DEG } from '../math/utils'

/**
 * 物理约束求解（Spine 4.3 同构）。
 *
 * 算法逐行对齐 `@esotericsoftware/spine-core` 的 `PhysicsConstraint.update()`：
 * 每帧先把「骨骼相对上一帧的位移」按 inertia 注入偏移量（受 limit 限制），
 * 再以 `step`（秒）为固定子步推进弹簧-阻尼系统，剩余不足一步的部分用 `lag`
 * 做线性回放（`z = 1 - remaining/step`），因此与渲染帧率无关。
 *
 * 与 Spine 的唯一差别：Spine 直接改骨骼**世界矩阵**（含剪切），这里改的是
 * local 姿态（位置 / 旋转 / 缩放），再增量重算 FK —— Hao2D 的骨骼模型是
 * TRS + shear，没有可自由回写的 2x3 世界矩阵。对常规用法（位移 / 旋转 /
 * 缩放通道）两者等价；`shearX` 通道按「与 rotate 合并成角度」近似处理。
 */

/** 单条物理约束的持久状态（逐帧累积，切动画 / seek / 重置姿态时清零）。 */
export interface PhysicsState {
  remaining: number
  reset: boolean
  ux: number
  uy: number
  cx: number
  cy: number
  tx: number
  ty: number
  xOffset: number
  xLag: number
  xVelocity: number
  yOffset: number
  yLag: number
  yVelocity: number
  rotateOffset: number
  rotateLag: number
  rotateVelocity: number
  scaleOffset: number
  scaleLag: number
  scaleVelocity: number
}

export function createPhysicsState(): PhysicsState {
  return {
    remaining: 0,
    reset: true,
    ux: 0,
    uy: 0,
    cx: 0,
    cy: 0,
    tx: 0,
    ty: 0,
    xOffset: 0,
    xLag: 0,
    xVelocity: 0,
    yOffset: 0,
    yLag: 0,
    yVelocity: 0,
    rotateOffset: 0,
    rotateLag: 0,
    rotateVelocity: 0,
    scaleOffset: 0,
    scaleLag: 0,
    scaleVelocity: 0
  }
}

export function resetPhysicsState(state: PhysicsState): void {
  const fresh = createPhysicsState()
  Object.assign(state, fresh)
}

/** 单帧累积的仿真时间上限：防止长时间卡顿后一次补算成千上万个子步 */
export const MAX_PHYSICS_DELTA = 0.5

/** 物理参数在某一时刻的取值（setup 或轨道 / 全局滑块覆盖后） */
export interface PhysicsParams {
  inertia: number
  strength: number
  damping: number
  mass: number
  wind: number
  gravity: number
  mix: number
}

/** 全局物理轨道在当前时刻的取值（null = 该参数没有全局轨道） */
export type PhysicsGlobalValues = { [K in keyof PhysicsParams]?: number | null }

/**
 * 把「勾了 Global 的参数」替换成全局轨道的值（对齐 Spine 的 `physics[""]`：
 * 只有 `constraintIndex = -1` 的全局时间轴才会影响这些勾了 Global 的约束）。
 */
export function applyPhysicsGlobals(
  data: PhysicsConstraint,
  params: PhysicsParams,
  global: PhysicsGlobalValues | null
): PhysicsParams {
  if (!global) return params
  const pick = (value: number, flag: boolean, key: keyof PhysicsParams): number => {
    if (!flag) return value
    const v = global[key]
    return typeof v === 'number' ? v : value
  }
  return {
    inertia: pick(params.inertia, data.inertiaGlobal, 'inertia'),
    strength: pick(params.strength, data.strengthGlobal, 'strength'),
    damping: pick(params.damping, data.dampingGlobal, 'damping'),
    mass: pick(params.mass, data.massGlobal, 'mass'),
    wind: pick(params.wind, data.windGlobal, 'wind'),
    gravity: pick(params.gravity, data.gravityGlobal, 'gravity'),
    mix: pick(params.mix, data.mixGlobal, 'mix')
  }
}

export function physicsParamsAt(data: PhysicsConstraint): PhysicsParams {
  return {
    inertia: data.inertia,
    strength: data.strength,
    damping: data.damping,
    mass: data.mass,
    wind: data.wind,
    gravity: data.gravity,
    mix: data.mix
  }
}

/**
 * 推进一帧物理仿真。
 *
 * @param constraints 与骨架约束一一对应（只处理 `type === 'physics'` 且 enabled 的）
 * @param states 与 constraints 同序的持久状态数组（非物理约束位置忽略）
 * @param sliders 与 constraints 同序的滑块值
 * @param dt 本帧时长（秒）
 * @param wind 骨架级风向 / 重力方向（默认 (1,0) / (0,1)，与 Spine 一致）
 */
export function stepPhysics(
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  states: PhysicsState[],
  dt: number,
  windX = 1,
  windY = 0,
  gravityX = 0,
  gravityY = 1,
  overrides?: ReadonlyArray<PhysicsParams | null>,
  global?: PhysicsGlobalValues | null
): void {
  if (!(dt > 0)) dt = 0
  if (dt > MAX_PHYSICS_DELTA) dt = MAX_PHYSICS_DELTA

  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i]
    if (c.type !== 'physics' || !c.enabled) continue
    const state = states[i]
    if (!state) continue
    const override = overrides ? overrides[i] ?? null : null
    stepOne(skeleton, c, state, dt, windX, windY, gravityX, gravityY, override, global)
  }
}

function stepOne(
  skeleton: Skeleton,
  data: PhysicsConstraint,
  state: PhysicsState,
  delta: number,
  windX: number,
  windY: number,
  gravityX: number,
  gravityY: number,
  override: PhysicsParams | null,
  global: PhysicsGlobalValues | null | undefined
): void {
  const boneIndex = data.boneIndices[0]
  if (boneIndex === undefined || boneIndex < 0 || boneIndex >= skeleton.boneCount) return

  const p = applyPhysicsGlobals(data, override ?? physicsParamsAt(data), global ?? null)
  const mix = p.mix
  // mass <= 0 时按 1 处理（质量无穷大 = 不参与加速）
  const massInverse = 1 / (p.mass > 0 ? p.mass : 1)
  if (mix === 0) return

  const useX = data.x > 0
  const useY = data.y > 0
  const rotateOrShearX = data.rotate > 0 || data.shearX > 0
  const useScaleX = data.scaleX > 0
  const step = Math.max(1e-4, data.step)
  const limit = Math.max(0, data.limit)

  const bx = skeleton.boneWorldX(boneIndex)
  const by = skeleton.boneWorldY(boneIndex)
  const o = boneIndex * 16
  const m00 = skeleton.world[o]
  const m10 = skeleton.world[o + 1]
  const boneAngle = Math.atan2(m10, m00)
  const worldScaleX = Math.hypot(skeleton.world[o], skeleton.world[o + 1]) || 1
  const worldScaleY = Math.hypot(skeleton.world[o + 4], skeleton.world[o + 5]) || 1
  const boneLength = skeleton.asset.bones[boneIndex]?.length ?? 0

  if (state.reset) {
    state.reset = false
    state.ux = bx
    state.uy = by
    state.cx = bx
    state.cy = by
    state.tx = boneLength * m00
    state.ty = boneLength * m10
    return
  }

  const aa = state.remaining
  state.remaining += delta

  const qx = limit * delta * Math.abs(worldScaleX)
  const qy = limit * delta * Math.abs(worldScaleY)
  const inertia = p.inertia
  const f = 1   // referenceScale：Hao2D 没有骨架级缩放，按 1 处理

  let a = state.remaining
  let dampingFactor = -1
  let massTerm = 0
  let strengthTerm = 0
  let z = 0
  let angle = boneAngle
  let cos = Math.cos(angle)
  let sin = Math.sin(angle)

  if (useX || useY) {
    if (useX) {
      const u = (state.ux - bx) * inertia
      state.xOffset += u > qx ? qx : u < -qx ? -qx : u
      state.ux = bx
    }
    if (useY) {
      const u = (state.uy - by) * inertia
      state.yOffset += u > qy ? qy : u < -qy ? -qy : u
      state.uy = by
    }
    if (a >= step) {
      const xs = state.xOffset
      const ys = state.yOffset
      dampingFactor = Math.pow(p.damping, 60 * step)
      massTerm = step * massInverse
      strengthTerm = p.strength
      const w = f * p.wind
      const g = f * p.gravity
      const ax = w * windX + g * gravityX
      const ay = w * windY + g * gravityY
      do {
        if (useX) {
          state.xVelocity += (ax - state.xOffset * strengthTerm) * massTerm
          state.xOffset += state.xVelocity * step
          state.xVelocity *= dampingFactor
        }
        if (useY) {
          state.yVelocity -= (ay + state.yOffset * strengthTerm) * massTerm
          state.yOffset += state.yVelocity * step
          state.yVelocity *= dampingFactor
        }
        a -= step
      } while (a >= step)
      state.xLag = state.xOffset - xs
      state.yLag = state.yOffset - ys
    }
    z = Math.max(0, 1 - a / step)
    if (useX) applyWorldTranslate(skeleton, boneIndex, (state.xOffset - state.xLag * z) * mix * data.x, 0)
    if (useY) applyWorldTranslate(skeleton, boneIndex, 0, (state.yOffset - state.yLag * z) * mix * data.y)
  }

  if (rotateOrShearX || useScaleX) {
    let dx = state.cx - skeleton.boneWorldX(boneIndex)
    let dy = state.cy - skeleton.boneWorldY(boneIndex)
    dx = dx > qx ? qx : dx < -qx ? -qx : dx
    dy = dy > qy ? qy : dy < -qy ? -qy : dy

    a = state.remaining
    let rotateMix = 0
    if (rotateOrShearX) {
      rotateMix = (data.rotate + data.shearX) * mix
      z = state.rotateLag * Math.max(0, 1 - aa / step)
      let r = Math.atan2(dy + state.ty, dx + state.tx) - angle - (state.rotateOffset - z) * rotateMix
      // 折到 ±π，避免长时间旋转后数值无限增大
      const invPi2 = 1 / (Math.PI * 2)
      r -= Math.ceil(r * invPi2 - 0.5) * Math.PI * 2
      state.rotateOffset += r * inertia
      r = (state.rotateOffset - z) * rotateMix + angle
      cos = Math.cos(r)
      sin = Math.sin(r)
      if (useScaleX) {
        const len = boneLength * worldScaleX
        if (len > 0) state.scaleOffset += (dx * cos + dy * sin) * inertia / len
      }
    } else {
      cos = Math.cos(angle)
      sin = Math.sin(angle)
      const len = boneLength * worldScaleX - state.scaleLag * Math.max(0, 1 - aa / step)
      if (len > 0) state.scaleOffset += (dx * cos + dy * sin) * inertia / len
    }

    if (a >= step) {
      if (dampingFactor === -1) {
        dampingFactor = Math.pow(p.damping, 60 * step)
        massTerm = step * massInverse
        strengthTerm = p.strength
      }
      const ax = p.wind * windX + p.gravity * gravityX
      const ay = p.wind * windY + p.gravity * gravityY
      const rs = state.rotateOffset
      const ss = state.scaleOffset
      const h = boneLength / f
      for (;;) {
        a -= step
        if (useScaleX) {
          state.scaleVelocity += (ax * cos - ay * sin - state.scaleOffset * strengthTerm) * massTerm
          state.scaleOffset += state.scaleVelocity * step
          state.scaleVelocity *= dampingFactor
        }
        if (rotateOrShearX) {
          state.rotateVelocity -= ((ax * sin + ay * cos) * h + state.rotateOffset * strengthTerm) * massTerm
          state.rotateOffset += state.rotateVelocity * step
          state.rotateVelocity *= dampingFactor
          if (a < step) break
          const r = state.rotateOffset * rotateMix + angle
          cos = Math.cos(r)
          sin = Math.sin(r)
        } else if (a < step) break
      }
      state.rotateLag = state.rotateOffset - rs
      state.scaleLag = state.scaleOffset - ss
    }
    z = Math.max(0, 1 - a / step)
  }

  state.remaining = a

  // 应用：旋转 / 缩放（位移已在上面按世界坐标写回）
  if (rotateOrShearX) {
    const offset = (state.rotateOffset - state.rotateLag * z) * mix
    applyWorldRotate(skeleton, boneIndex, offset * data.rotate)
    if (data.shearX > 0) {
      // 近似：剪切通道折算成额外的旋转（Hao2D 没有逐约束可写的世界剪切）
      applyWorldRotate(skeleton, boneIndex, offset * data.shearX)
    }
  }
  if (useScaleX) {
    let s = 1 + (state.scaleOffset - state.scaleLag * z) * mix * data.scaleX
    if (data.scaleYMode === 2) {
      // Volume：保持面积近似恒定
      const abs = Math.abs(s)
      s = abs >= 0.7 ? 1 / abs : 4 - 3.67347 * abs
    }
    skeleton.localScale[boneIndex * 2] *= s
    if (data.scaleYMode !== 0) skeleton.localScale[boneIndex * 2 + 1] *= s
  }

  // 约束原点与骨骼末端（供下一帧算相对运动）
  const oo = boneIndex * 16
  state.cx = skeleton.boneWorldX(boneIndex)
  state.cy = skeleton.boneWorldY(boneIndex)
  state.tx = boneLength * skeleton.world[oo]
  state.ty = boneLength * skeleton.world[oo + 1]
}

/** 世界位移 → 父空间位移写回 localPos（物理改的是世界坐标） */
function applyWorldTranslate(skeleton: Skeleton, boneIndex: number, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return
  const parent = skeleton.asset.bones[boneIndex].parentIndex
  let lx = dx
  let ly = dy
  if (parent >= 0) {
    const o = parent * 16
    const pa = skeleton.world[o]
    const pb = skeleton.world[o + 4]
    const pc = skeleton.world[o + 1]
    const pd = skeleton.world[o + 5]
    const det = pa * pd - pb * pc
    if (Math.abs(det) > 1e-8) {
      lx = (pd * dx - pb * dy) / det
      ly = (-pc * dx + pa * dy) / det
    }
  }
  skeleton.localPos[boneIndex * 2] += lx
  skeleton.localPos[boneIndex * 2 + 1] += ly
  skeleton.updateFkFrom(boneIndex)
}

/** 世界旋转增量（弧度）→ localRot（近似：均匀缩放时等价） */
function applyWorldRotate(skeleton: Skeleton, boneIndex: number, deltaRad: number): void {
  if (deltaRad === 0) return
  skeleton.localRot[boneIndex] += deltaRad * RAD2DEG
  skeleton.updateFkFrom(boneIndex)
}
