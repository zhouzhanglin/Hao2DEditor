import type { SpineAnimationJson, SpineCurveKeyframe, SpineJson } from './spineTypes'

/**
 * Spine **3.x** 资源在喂给官方 4.x 运行库前的规整（两件事，都是实测出来的）。
 *
 * ## 一、老格式的曲线会让官方库算出 NaN 或错值
 *
 * 拿 3.3.07 的 Dragon 逐项隔离后（`translate` / `rotate` / `scale` / `shear` 单留一条轨道试）：
 *
 * | 情况 | 官方 4.3 运行库 |
 * | --- | --- |
 * | 轨道无曲线 / `stepped` | ✅ 正常 |
 * | `translate` + 贝塞尔（或字符串 `linear`） | ❌ 姿态变 **NaN**（角色消失） |
 * | `rotate` + 贝塞尔 | ⚠️ 缓动/取值不对 |
 *
 * 既然烘焙本来就是**逐帧读姿态**，这里就把带曲线的段按烘焙帧率**拆成线性子键**：
 * 一帧一个键 = 把缓动精确求值一遍，采样点上零误差，同时彻底绕开那条坏路径。
 * `stepped` 段保持原样（它本来就对，拆开还会破坏「瞬间切换」的语义）。
 *
 * ## 二、曲线的坐标系与字段名都变过
 *
 * - **曲线**：< 4.2 写的是 `[时间1, 值1, 时间2, 值2]`，**时间与值都是绝对值**；
 *   4.2 起才改成归一化的 `[cx1, cy1, cx2, cy2]`（见 `spineAnims` 的 `curveOfChannel`）。
 *   拆分时按段的 `dt` 与该通道的 `dv` 归一化，与内置解析器同一套算法 ——
 *   否则缓动形状会完全不对（这正是「老资源旋转不对」的原因）。
 * - **字段名**：3.x / 4.1 的 rotate 关键帧写 `angle`，**4.2 起叫 `value`**；官方 4.3 只认 `value`，
 *   读老文件时角度会静默变成 0，所以这里顺手改名。
 *
 * 4.x 及以上的文件**原样返回**（计数都是 0），不做任何处理。
 */

/** 骨骼上的数值轨道（都是每帧采样的对象） */
const BONE_TRACKS = ['rotate', 'translate', 'scale', 'shear'] as const
type BoneTrackName = (typeof BONE_TRACKS)[number]

/** 版本号主版本（`3.3.07` → 3；取不到时给 NaN） */
function majorOf(version: string | undefined): number {
  if (!version) return Number.NaN
  return Number.parseInt(version.split('.')[0] ?? '', 10)
}

/**
 * 三次贝塞尔缓动求值：控制点 `(cx1, cy1)` / `(cx2, cy2)`，起点 (0,0)、终点 (1,1)。
 *
 * 与内置解析器（`core/anim/interpolation.curvePercent`）同一套数学：先由 x 反解参数 t（二分），
 * 再用 t 求 y。分量允许超出 0..1（官方允许过冲）。
 */
export function bezierEase(cx1: number, cy1: number, cx2: number, cy2: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bx = (t: number): number =>
    3 * t * (1 - t) * (1 - t) * cx1 + 3 * t * t * (1 - t) * cx2 + t * t * t
  const by = (t: number): number =>
    3 * t * (1 - t) * (1 - t) * cy1 + 3 * t * t * (1 - t) * cy2 + t * t * t
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (bx(mid) < x) lo = mid
    else hi = mid
  }
  return by((lo + hi) / 2)
}

/** 需要拆开的曲线：贝塞尔数组与 `linear`（`stepped`、无曲线都不动） */
function needsFlatten(curve: SpineCurveKeyframe['curve']): boolean {
  if (Array.isArray(curve)) return true
  return curve === 'linear'
}

/** 取关键帧的数值（rotate 是单值 `value`/`angle`，其余是 `x` / `y` 两个分量） */
function valuesOf(key: SpineCurveKeyframe, track: BoneTrackName): number[] {
  if (track === 'rotate') {
    const value = typeof key.value === 'number' ? key.value : key.angle
    return [typeof value === 'number' ? value : 0]
  }
  return [typeof key.x === 'number' ? key.x : 0, typeof key.y === 'number' ? key.y : 0]
}

type CurvePoints = [number, number, number, number]

/**
 * 一段曲线在某个通道上的**归一化**控制点。
 *
 * 判定沿用内置解析器 `curveOfChannel` 的同一套规则（两条路径必须给出同样的缓动）：
 * 四个分量都落在**过冲窗口**内 → 已经是归一化控制点，直接用；
 * 否则（出现 10 / 20 这种明显是通道单位的值）→ 当作 `(时间, 值)` 绝对坐标，
 * 按段的 `dt` 与该通道的 `dv` 归一化。
 *
 * 窗口必须容得下过冲：官方 3.x 的 `cy` 是「两帧取值差的百分比」，**可以 > 1**
 *（实测 3.3 的 Dragon 里 1.06 / 1.33 / 1.43 都是正常缓动）。窗口若卡成 [0,1]，
 * 这些段会被误判成绝对坐标，缓动被压成「一整段几乎不动、到末尾突跳」。
 *
 * 双分量轨道的曲线是**每通道 4 个数**依次排列（8 个），只给 4 个时两个通道共用一组。
 */
function curvePointsFor(
  curve: SpineCurveKeyframe['curve'],
  from: SpineCurveKeyframe,
  to: SpineCurveKeyframe,
  track: BoneTrackName,
  channel: number
): CurvePoints | null {
  if (!Array.isArray(curve)) return null
  const shared = curve.length < 8
  const base = shared ? 0 : channel * 4
  if (curve.length < base + 4) return null

  const c1t = numberAt(curve, base)
  const c1v = numberAt(curve, base + 1)
  const c2t = numberAt(curve, base + 2)
  const c2v = numberAt(curve, base + 3)
  // 过冲窗口：`cx` 是两帧之间的时间百分比，`cy` 是取值差的百分比（可 > 1，也可 < 0）
  const inRange = (value: number): boolean => value >= -1 && value <= 2
  if (inRange(c1t) && inRange(c1v) && inRange(c2t) && inRange(c2v)) return [c1t, c1v, c2t, c2v]

  const dt = to.time - from.time
  if (Math.abs(dt) < 1e-9) return null
  const a = valuesOf(from, track)
  const b = valuesOf(to, track)
  const index = shared ? 0 : channel
  const v0 = a[index] ?? 0
  const dv = (b[index] ?? 0) - v0
  const flat = Math.abs(dv) < 1e-9
  return [(c1t - from.time) / dt, flat ? 0 : (c1v - v0) / dv, (c2t - from.time) / dt, flat ? 1 : (c2v - v0) / dv]
}

/** 取数组里的数字（非数字给 0） */
function numberAt(values: unknown[], index: number): number {
  const value = values[index]
  return typeof value === 'number' ? value : 0
}

/** 把一段带缓动的关键帧按帧率拆开（起点去掉曲线，中间插入线性子键） */
function flattenSegment(
  from: SpineCurveKeyframe,
  to: SpineCurveKeyframe,
  track: BoneTrackName,
  fps: number
): SpineCurveKeyframe[] {
  const lifted: SpineCurveKeyframe = { ...from }
  delete lifted.curve
  const out: SpineCurveKeyframe[] = [lifted]

  const span = to.time - from.time
  const count = span > 0 ? Math.max(1, Math.round(span * fps)) : 1
  if (count <= 1) return out

  const a = valuesOf(from, track)
  const b = valuesOf(to, track)
  const easeX = curvePointsFor(from.curve, from, to, track, 0)
  const easeY = track === 'rotate' ? easeX : curvePointsFor(from.curve, from, to, track, 1)

  for (let k = 1; k < count; k++) {
    const t = k / count
    const time = from.time + span * t
    const ex = easeX ? bezierEase(easeX[0], easeX[1], easeX[2], easeX[3], t) : t
    if (track === 'rotate') {
      out.push({ time, value: a[0] + (b[0] - a[0]) * ex })
      continue
    }
    const ey = easeY ? bezierEase(easeY[0], easeY[1], easeY[2], easeY[3], t) : t
    out.push({
      time,
      x: a[0] + (b[0] - a[0]) * ex,
      y: a[1] + (b[1] - a[1]) * ey
    })
  }
  return out
}

export interface LegacyAnimFixResult {
  json: SpineJson
  /** 拆开的带缓动段数（0 = 这份文件不需要处理） */
  segments: number
  /** `angle` 改名成 `value` 的关键帧数 */
  renamed: number
}

/**
 * 规整老格式（主版本 < 4）的骨骼动画轨道：拆缓动曲线 + `angle` → `value`。
 *
 * - 只动 `rotate` / `translate` / `scale` / `shear`，插槽轨道与其它字段原样保留；
 * - 子键密度 = 烘焙帧率（`fps`）：一帧一个键，采样点上与官方缓动完全一致；
 * - 输入不被改动（返回深拷贝）；
 * - 4.x 及以上的文件直接原样返回（两个计数都是 0）。
 */
export function normalizeLegacyAnimations(json: SpineJson, fps: number): LegacyAnimFixResult {
  const step = fps > 0 ? fps : 30
  if (majorOf(json.skeleton?.spine) >= 4) return { json, segments: 0, renamed: 0 }
  const animations = json.animations
  if (!animations || typeof animations !== 'object') return { json, segments: 0, renamed: 0 }

  const out = JSON.parse(JSON.stringify(json)) as SpineJson
  let segments = 0
  let renamed = 0

  for (const animation of Object.values(out.animations ?? {}) as SpineAnimationJson[]) {
    const bones = animation?.bones
    if (!bones || typeof bones !== 'object') continue
    for (const track of Object.values(bones)) {
      if (!track) continue
      for (const name of BONE_TRACKS) {
        const keys = track[name]
        if (!Array.isArray(keys) || keys.length === 0) continue

        for (const key of keys) {
          // 4.2 起 rotate 的关键帧字段是 value，老文件写的是 angle
          if ('angle' in key) {
            key.value = key.angle
            delete key.angle
            renamed++
          }
        }

        const next: SpineCurveKeyframe[] = []
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          const following = keys[i + 1]
          if (!following || !needsFlatten(key.curve)) {
            next.push(key)
            continue
          }
          next.push(...flattenSegment(key, following, name, step))
          segments++
        }
        track[name] = next
      }
    }
  }

  return { json: out, segments, renamed }
}
