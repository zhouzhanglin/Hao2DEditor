/** 全局约定：角度单位一律为「度」，逆时针为正。 */
export const DEG2RAD = Math.PI / 180
export const RAD2DEG = 180 / Math.PI
/** 角度环绕周期（度） */
export const ANGLE_PERIOD = 360

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function degToRad(deg: number): number {
  return deg * DEG2RAD
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG
}

/** 归一化到 [0, 360) */
export function normalizeAngle(deg: number): number {
  const m = deg % ANGLE_PERIOD
  return m < 0 ? m + ANGLE_PERIOD : m
}

/** 归一化到 (-180, 180] */
export function wrapAngle(deg: number): number {
  let a = normalizeAngle(deg)
  if (a > 180) a -= ANGLE_PERIOD
  return a
}

export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from)
}

/** 沿最短弧插值（对齐参考库 Skeleton.LerpAngle） */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t
}

export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

/** 向上取到 2 的幂（图集页尺寸常用） */
export function ceilPowerOfTwo(value: number): number {
  if (value <= 1) return 1
  return 1 << (32 - Math.clz32(value - 1))
}
