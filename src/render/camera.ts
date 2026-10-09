/**
 * 视口相机的纯计算部分（不 import Pixi，便于单测）。
 *
 * 屏幕坐标约定见 `viewport.ts` 的 `worldToScreen`：
 *   screenX = worldX * zoom + width / 2 + offsetX
 *   screenY = -worldY * zoom + height / 2 + offsetY
 */

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 800

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** 聚焦时内容最多占视口的比例（0.5 = 最多占一半，留出周边上下文） */
export const FRAME_FILL = 0.5

/**
 * 「把某块世界范围摆到视口中央」所需的相机参数。
 *
 * 与 `fit` 的区别：`fit` 让**世界原点**固定在屏幕中心、按内容相对原点的半径定缩放
 * （骨骼都在原点附近建模时观感更稳）；这里是让**目标点**落到屏幕中心 ——
 * 层级树里双击一个远处的节点时，希望它出现在正中间。
 *
 * 由上面的公式反解：目标点落在 screenX = width/2 处，就得
 * `offsetX = -worldX * zoom`；Y 轴反向，`offsetY = worldY * zoom`。
 */
export function framingCamera(options: {
  width: number
  height: number
  worldX: number
  worldY: number
  contentWidth: number
  contentHeight: number
  fill?: number
}): { zoom: number; offsetX: number; offsetY: number } {
  const fill = options.fill ?? FRAME_FILL
  const contentWidth = Math.max(1e-6, options.contentWidth)
  const contentHeight = Math.max(1e-6, options.contentHeight)
  const zoom = clampZoom(
    Math.min((options.width * fill) / contentWidth, (options.height * fill) / contentHeight)
  )
  return { zoom, offsetX: -options.worldX * zoom, offsetY: options.worldY * zoom }
}
