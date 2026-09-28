import { clamp01, lerpAngle } from '../math/utils'
import { Easing } from '../model/animation'
import type { ColorKeyframe, Float2Keyframe, FloatKeyframe, IntKeyframe } from '../model/animation'
import type { RGBA } from '../model/types'

/** 首个 time >= target 的下标；全部小于 target 时返回 keys.length */
export function firstIndexAtOrAfter<T extends { time: number }>(keys: readonly T[], target: number): number {
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 最后一个 time <= target 的下标；全部大于 target 时返回 -1 */
export function lastIndexAtOrBefore<T extends { time: number }>(keys: readonly T[], target: number): number {
  let lo = 0
  let hi = keys.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** 三次贝塞尔单分量（端点固定 (0,0) → (1,1)） */
function bezier(t: number, c1: number, c2: number): number {
  const it = 1 - t
  return 3 * it * it * t * c1 + 3 * it * t * t * c2 + t * t * t
}

/**
 * 平滑比例（对齐参考库 AnimationPlayer.CurvePercent）：
 * - Stepped → 恒返回 0（保持前一帧值）
 * - 非 Bezier 或控制量不足 4 个 → clamp01(percent)（线性）
 * - Bezier → 对 x(t) = percent 二分迭代 12 次求 t，再取 y(t)
 *
 * 注意参考库不使用 LUT，这里同样直接迭代求解（误差约 1e-3）。
 */
export function curvePercent(easing: Easing, curve: number[] | null, percent: number): number {
  if (easing === Easing.Stepped) return 0
  if (easing !== Easing.Bezier || !curve || curve.length < 4) return clamp01(percent)

  const cx1 = curve[0]
  const cy1 = curve[1]
  const cx2 = curve[2]
  const cy2 = curve[3]
  let lo = 0
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5
    if (bezier(mid, cx1, cx2) < percent) lo = mid
    else hi = mid
  }
  return bezier((lo + hi) * 0.5, cy1, cy2)
}

/**
 * 标量采样。返回 null 表示「保持不变（setup 值）」：
 * - 首帧时间之前 → null（不提前套首帧）
 * - 恰好等于首帧时间 → 首帧值
 * - 末帧之后 → 末帧值
 * 段内插值比例取**前一个关键帧**的 easing / curve。
 */
export function sampleNumber(keys: readonly FloatKeyframe[], time: number): number | null {
  const n = keys.length
  if (n === 0) return null
  if (time < keys[0].time) return null
  const i = firstIndexAtOrAfter(keys, time)
  if (i >= n) return keys[n - 1].value
  if (i === 0) return keys[0].value
  const a = keys[i - 1]
  const b = keys[i]
  const span = b.time - a.time
  const t = span <= 0 ? 1 : (time - a.time) / span
  return a.value + (b.value - a.value) * curvePercent(a.easing, a.curve, t)
}

/** 角度采样（沿最短弧插值） */
export function sampleAngle(keys: readonly FloatKeyframe[], time: number): number | null {
  const n = keys.length
  if (n === 0) return null
  if (time < keys[0].time) return null
  const i = firstIndexAtOrAfter(keys, time)
  if (i >= n) return keys[n - 1].value
  if (i === 0) return keys[0].value
  const a = keys[i - 1]
  const b = keys[i]
  const span = b.time - a.time
  const t = span <= 0 ? 1 : (time - a.time) / span
  return lerpAngle(a.value, b.value, curvePercent(a.easing, a.curve, t))
}

/** 二维向量采样，写入 out 的指定偏移；返回 false 表示保持不变 */
export function sampleVec2(
  keys: readonly Float2Keyframe[],
  time: number,
  out: Float32Array,
  offset: number
): boolean {
  const n = keys.length
  if (n === 0) return false
  if (time < keys[0].time) return false
  const i = firstIndexAtOrAfter(keys, time)

  if (i >= n || i === 0) {
    const v = keys[i >= n ? n - 1 : 0].value
    out[offset] = v.x
    out[offset + 1] = v.y
    return true
  }
  const a = keys[i - 1]
  const b = keys[i]
  const span = b.time - a.time
  const t = curvePercent(a.easing, a.curve, span <= 0 ? 1 : (time - a.time) / span)
  out[offset] = a.value.x + (b.value.x - a.value.x) * t
  out[offset + 1] = a.value.y + (b.value.y - a.value.y) * t
  return true
}

/** 颜色采样；返回 false 表示保持不变 */
export function sampleColor(keys: readonly ColorKeyframe[], time: number, out: RGBA): boolean {
  const n = keys.length
  if (n === 0) return false
  if (time < keys[0].time) return false
  const i = firstIndexAtOrAfter(keys, time)

  if (i >= n || i === 0) {
    const v = keys[i >= n ? n - 1 : 0].value
    out.r = v.r
    out.g = v.g
    out.b = v.b
    out.a = v.a
    return true
  }
  const a = keys[i - 1]
  const b = keys[i]
  const span = b.time - a.time
  const t = curvePercent(a.easing, a.curve, span <= 0 ? 1 : (time - a.time) / span)
  out.r = a.value.r + (b.value.r - a.value.r) * t
  out.g = a.value.g + (b.value.g - a.value.g) * t
  out.b = a.value.b + (b.value.b - a.value.b) * t
  out.a = a.value.a + (b.value.a - a.value.a) * t
  return true
}

/**
 * 整型采样（阶跃）：取「最后一个 time <= 当前时间」的关键帧。
 * 同时返回该关键帧的下标，供附件名轨道按同一帧解析。
 */
export function sampleInt(
  keys: readonly IntKeyframe[],
  time: number
): { value: number; index: number } | null {
  const n = keys.length
  if (n === 0) return null
  const i = lastIndexAtOrBefore(keys, time)
  if (i < 0) return null
  return { value: keys[i].value, index: i }
}

/** 绘制顺序关键帧：取「最后一个 time <= 当前时间」，恰好等于首帧时间也套用首帧 */
export function sampleDrawOrderIndex<T extends { time: number }>(keys: readonly T[], time: number): number {
  const i = lastIndexAtOrBefore(keys, time)
  return i < 0 ? -1 : i
}

/** 变形关键帧采样：在 k 与 k+1 之间按 k 的平滑方式插值 */
export function sampleDeformIndex<T extends { time: number }>(keys: readonly T[], time: number): number {
  return lastIndexAtOrBefore(keys, time)
}
