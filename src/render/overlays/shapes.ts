/**
 * 圆形一律用**自己算的多边形**画，不要用 Pixi 的 `Graphics.circle()`。
 *
 * 原因：pixi v8 的 circle 分段数是按**世界单位半径**定的
 * （`n = ceil(2.3 * sqrt(2r))`，见 buildCircle.mjs）。视口里的 Graphics 画在
 * 世界容器里（缩放 = zoom），屏幕恒定大小的圆换算成世界半径后非常小
 * （例如 46px 的旋转环在 zoom=210 时只有 0.22 世界单位 → 只有 2 段），
 * 于是圆会变成明显的多边形。固定段数与半径无关，放大后依然是圆的。
 */
export function circlePolygon(x: number, y: number, radius: number, segments = 48): number[] {
  const count = Math.max(8, Math.floor(segments))
  const points: number[] = []
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    points.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)
  }
  return points
}

/** 顶点小圆点用的段数（直径约 8~11 个屏幕像素，16 段已看不出棱角） */
export const DOT_SEGMENTS = 16

/**
 * 扇形（饼图的一瓣）：圆心 → 弧 → 回到圆心（自动闭合）。
 *
 * `segments` 是**整圆**的段数，这里按张角比例取用（至少 2 段），小瓣不会白白多出一堆顶点；
 * 角度用弧度，0 = 正右方、顺时针为正（与画布坐标系一致）。
 */
export function piePolygon(
  x: number,
  y: number,
  radius: number,
  from: number,
  to: number,
  segments = 48
): number[] {
  const sweep = to - from
  if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-6) return []
  const full = Math.max(8, Math.floor(segments))
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * full))
  const points: number[] = [x, y]
  for (let i = 0; i <= steps; i++) {
    const angle = from + (sweep * i) / steps
    points.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)
  }
  return points
}
