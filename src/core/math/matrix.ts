import { DEG2RAD, RAD2DEG, wrapAngle } from './utils'

export interface Vec2 {
  x: number
  y: number
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y }
}

/**
 * 4x4 矩阵，**列主序**，长度 16 的 Float32Array，索引 = col * 4 + row。
 * 与 Unity.Mathematics.float4x4 的内存布局一致，便于与 Unity 端 Hao2D 运行时算法逐行对照：
 *   m[0] = m00 = a   m[1] = m10 = c   m[4] = m01 = b   m[5] = m11 = d
 *   m[12] = tx       m[13] = ty
 */

export const MAT4_LENGTH = 16

export function mat4Identity(): Float32Array {
  const m = new Float32Array(MAT4_LENGTH)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  return m
}

export function identityInto(out: Float32Array): Float32Array {
  out.fill(0)
  out[0] = 1
  out[5] = 1
  out[10] = 1
  out[15] = 1
  return out
}

export function copyInto(out: Float32Array, src: Float32Array): Float32Array {
  out.set(src)
  return out
}

/** 写入普通 TRS（不含 shear），等价 Unity 端 Hao2D 运行时 Hao2DMath.Trs */
export function trsInto(
  out: Float32Array,
  posX: number,
  posY: number,
  rotDeg: number,
  scaleX: number,
  scaleY: number
): Float32Array {
  const rad = rotDeg * DEG2RAD
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  out[0] = cos * scaleX
  out[1] = sin * scaleX
  out[2] = 0
  out[3] = 0
  out[4] = -sin * scaleY
  out[5] = cos * scaleY
  out[6] = 0
  out[7] = 0
  out[8] = 0
  out[9] = 0
  out[10] = 1
  out[11] = 0
  out[12] = posX
  out[13] = posY
  out[14] = 0
  out[15] = 1
  return out
}

export function trs(posX: number, posY: number, rotDeg: number, scaleX: number, scaleY: number): Float32Array {
  return trsInto(new Float32Array(MAT4_LENGTH), posX, posY, rotDeg, scaleX, scaleY)
}

/** out = a * b（列主序仿射矩阵，等价 math.mul） */
export function mulInto(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  const a0 = a[0]
  const a1 = a[1]
  const a4 = a[4]
  const a5 = a[5]
  const a12 = a[12]
  const a13 = a[13]

  const b0 = b[0]
  const b1 = b[1]
  const b4 = b[4]
  const b5 = b[5]
  const b12 = b[12]
  const b13 = b[13]

  out[0] = a0 * b0 + a4 * b1
  out[1] = a1 * b0 + a5 * b1
  out[4] = a0 * b4 + a4 * b5
  out[5] = a1 * b4 + a5 * b5
  out[12] = a0 * b12 + a4 * b13 + a12
  out[13] = a1 * b12 + a5 * b13 + a13
  out[2] = 0
  out[3] = 0
  out[6] = 0
  out[7] = 0
  out[8] = 0
  out[9] = 0
  out[10] = 1
  out[11] = 0
  out[14] = 0
  out[15] = 1
  return out
}

export function mul(a: Float32Array, b: Float32Array): Float32Array {
  return mulInto(new Float32Array(MAT4_LENGTH), a, b)
}

/** out = inverse(m)（二分 2x2 + 平移，等价 math.inverse 对仿射矩阵的结果） */
export function invertInto(out: Float32Array, m: Float32Array): Float32Array {
  const a = m[0]
  const c = m[1]
  const b = m[4]
  const d = m[5]
  const tx = m[12]
  const ty = m[13]

  const det = a * d - b * c
  if (det === 0) {
    return identityInto(out)
  }
  const inv = 1 / det
  const ia = d * inv
  const ib = -b * inv
  const ic = -c * inv
  const id = a * inv

  out[0] = ia
  out[1] = ic
  out[4] = ib
  out[5] = id
  out[12] = -(ia * tx + ib * ty)
  out[13] = -(ic * tx + id * ty)
  out[2] = 0
  out[3] = 0
  out[6] = 0
  out[7] = 0
  out[8] = 0
  out[9] = 0
  out[10] = 1
  out[11] = 0
  out[14] = 0
  out[15] = 1
  return out
}

export function invert(m: Float32Array): Float32Array {
  return invertInto(new Float32Array(MAT4_LENGTH), m)
}

/** 齐次点变换（含平移），等价 Hao2DMath.MulPoint */
export function mulPointX(m: Float32Array, x: number, y: number): number {
  return m[0] * x + m[4] * y + m[12]
}

export function mulPointY(m: Float32Array, x: number, y: number): number {
  return m[1] * x + m[5] * y + m[13]
}

export function mulPoint(m: Float32Array, p: Vec2): Vec2 {
  return { x: mulPointX(m, p.x, p.y), y: mulPointY(m, p.x, p.y) }
}

/** 方向/偏移变换（不含平移），等价 Hao2DMath.MulVector */
export function mulVectorX(m: Float32Array, x: number, y: number): number {
  return m[0] * x + m[4] * y
}

export function mulVectorY(m: Float32Array, x: number, y: number): number {
  return m[1] * x + m[5] * y
}

export function mulVector(m: Float32Array, v: Vec2): Vec2 {
  return { x: mulVectorX(m, v.x, v.y), y: mulVectorY(m, v.x, v.y) }
}

export function matrixX(m: Float32Array): number {
  return m[12]
}

export function matrixY(m: Float32Array): number {
  return m[13]
}

/** 列 0 长度（X 轴缩放模长） */
export function scaleXOf(m: Float32Array): number {
  return Math.hypot(m[0], m[1])
}

/** 列 1 长度（Y 轴缩放模长） */
export function scaleYOf(m: Float32Array): number {
  return Math.hypot(m[4], m[5])
}

/** X 轴朝向（度），等价 atan2(c, a) */
export function rotationOf(m: Float32Array): number {
  return Math.atan2(m[1], m[0]) * RAD2DEG
}

/** 局部 TRS（含斜切）参数，与 fk.ts 的矩阵构造约定互逆 */
export interface TrsParts {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  shearX: number
  shearY: number
}

/**
 * 把局部矩阵分解回 TRS 参数 —— `fk.ts` 里
 * `(pos, rotation, scale, shear) → 矩阵` 的逆运算。
 *
 * 约定（见 fk.ts）：X 轴角 = rotation + shearX，Y 轴角 = rotation + 90 + shearY。
 * 分解时把整段 X 轴角归给 rotation（shearX = 0），只把两轴夹角之差写进 shearY ——
 * 这样没有斜切的骨骼不会被动引入斜切。镜像（行列式 < 0）统一归到 scaleY 取负，
 * 并补偿 Y 轴多转的 180°。
 */
export function decomposeTrs(m: Float32Array): TrsParts {
  const thetaX = Math.atan2(m[1], m[0]) * RAD2DEG
  let thetaY = Math.atan2(m[5], m[4]) * RAD2DEG
  const scaleX = Math.hypot(m[0], m[1])
  const scaleY = Math.hypot(m[4], m[5])
  const mirrored = m[0] * m[5] - m[4] * m[1] < 0
  if (mirrored) thetaY += 180
  return {
    x: m[12],
    y: m[13],
    rotation: thetaX,
    scaleX,
    scaleY: mirrored ? -scaleY : scaleY,
    shearX: 0,
    shearY: wrapAngle(thetaY - thetaX - 90)
  }
}

/** 水平翻转（对局部 scale.x 取负并绕原点镜像），用于编辑器镜像显示 */
export function flipXInto(out: Float32Array, m: Float32Array, pivotX: number): Float32Array {
  out.set(m)
  const t = out[12]
  out[12] = 2 * pivotX - t
  out[0] = -m[0]
  out[1] = -m[1]
  return out
}

export { DEG2RAD, RAD2DEG }
