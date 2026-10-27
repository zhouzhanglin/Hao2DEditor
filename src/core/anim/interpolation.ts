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

/**
 * 时间比较容差（秒）。
 *
 * 播放时间来自「累加 dt」或「帧号 ÷ fps」两条路，二进制浮点必然带 1e-16 级误差：
 * `seek` 里的 `(x % dur + dur) % dur`、逐帧 `time += 1/30`、以及 4 位小数取整，
 * 都会让「正好停在第 N 帧」的采样时间**比关键帧时间小一丁点**。
 * 严格 `<=` 时就会退回**上一个**关键帧的取值 —— 对 stepped 通道（例如 portal 的
 * flare 甩出去）是整块位移不对：第 34 帧火焰还挂在原位，下一帧突然飞出去。
 * 容差取 1e-9 秒：既大于倍精度的累加/取模误差（1e-16~1e-12），
 * 又**小于 float32 的时间量化步长**（t≈1~4s 时约 1e-7）——
 * 否则会把「Spine 用 float32 存关键帧时间」造成的、本该在下一帧才生效的切换提前吃掉
 * （portal 第 33 帧 flare 贴图早一帧出现）。
 */
export const TIME_EPSILON = 1e-10

/** 最后一个 time <= target 的下标（允许 TIME_EPSILON 的浮点回差）；全部大于 target 时返回 -1 */
export function lastIndexAtOrBefore<T extends { time: number }>(keys: readonly T[], target: number): number {
  let lo = 0
  let hi = keys.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time <= target + TIME_EPSILON) {
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
 * 平滑比例（对齐 Unity 端 Hao2D 运行时 AnimationPlayer.CurvePercent）：
 * - Stepped → 恒返回 0（保持前一帧值）
 * - 非 Bezier 或控制量不足 4 个 → clamp01(percent)（线性）
 * - Bezier → 对 x(t) = percent 二分迭代 12 次求 t，再取 y(t)
 *
 * 注意 Unity 端 Hao2D 运行时不使用 LUT，这里同样直接迭代求解（误差约 1e-3）。
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
  // 帧时刻起该帧的值立即生效（闭区间左端）：这样播放到 / 停在最后一帧时，
  // 取到的就是最后关键帧的值，而不是它前一帧的值
  const a = lastIndexAtOrBefore(keys, time)
  if (a < 0) return null
  if (a >= n - 1) return keys[n - 1].value
  const from = keys[a]
  const to = keys[a + 1]
  const span = to.time - from.time
  const t = span <= 0 ? 1 : (time - from.time) / span
  return from.value + (to.value - from.value) * curvePercent(from.easing, from.curve, t)
}

/** 角度采样（沿最短弧插值） */
export function sampleAngle(keys: readonly FloatKeyframe[], time: number): number | null {
  const n = keys.length
  if (n === 0) return null
  const a = lastIndexAtOrBefore(keys, time)
  if (a < 0) return null
  if (a >= n - 1) return keys[n - 1].value
  const from = keys[a]
  const to = keys[a + 1]
  const span = to.time - from.time
  const t = span <= 0 ? 1 : (time - from.time) / span
  return lerpAngle(from.value, to.value, curvePercent(from.easing, from.curve, t))
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
  const a = lastIndexAtOrBefore(keys, time)
  if (a < 0) return false
  if (a >= n - 1) {
    const v = keys[n - 1].value
    out[offset] = v.x
    out[offset + 1] = v.y
    return true
  }
  const from = keys[a]
  const to = keys[a + 1]
  const span = to.time - from.time
  const t = curvePercent(from.easing, from.curve, span <= 0 ? 1 : (time - from.time) / span)
  out[offset] = from.value.x + (to.value.x - from.value.x) * t
  out[offset + 1] = from.value.y + (to.value.y - from.value.y) * t
  return true
}

/** 颜色采样；返回 false 表示保持不变 */
export function sampleColor(keys: readonly ColorKeyframe[], time: number, out: RGBA): boolean {
  const n = keys.length
  if (n === 0) return false
  const a = lastIndexAtOrBefore(keys, time)
  if (a < 0) return false
  if (a >= n - 1) {
    const v = keys[n - 1].value
    out.r = v.r
    out.g = v.g
    out.b = v.b
    out.a = v.a
    return true
  }
  const from = keys[a]
  const to = keys[a + 1]
  const span = to.time - from.time
  const t = curvePercent(from.easing, from.curve, span <= 0 ? 1 : (time - from.time) / span)
  out.r = from.value.r + (to.value.r - from.value.r) * t
  out.g = from.value.g + (to.value.g - from.value.g) * t
  out.b = from.value.b + (to.value.b - from.value.b) * t
  out.a = from.value.a + (to.value.a - from.value.a) * t
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
