/**
 * 视口相机的纯计算部分（不 import Pixi，便于单测）。
 *
 * 屏幕坐标约定见 `viewport.ts` 的 `worldToScreen`：
 *   screenX = worldX * zoom + width / 2 + offsetX
 *   screenY = -worldY * zoom + height / 2 + offsetY
 */

/**
 * 视口缩放范围。
 *
 * **单位要注意**：`zoom` 是「一个**世界单位**画多少屏幕像素」，而 1 世界单位 = PPU(=100)
 * 图像像素 —— 所以界面上的百分比 = `zoom / PPU * 100`，即 **zoom 的数值就是百分比**
 * （zoom = 100 → 100% → 1 图像像素画 1 屏幕像素，见 App 里的缩放读数换算）。
 *
 * 因此下限写 **10**（= 界面上的 10%），不是 0.1。之前写 0.1 时读数只有 0%，等于没限制。
 * 再往下角色只剩几个像素，滚轮一两下就「缩没了」，还得一路往回滚才能找回来。
 */
export const MIN_ZOOM = 10
export const MAX_ZOOM = 800

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** 聚焦时内容最多占视口的比例（0.5 = 最多占一半，留出周边上下文） */
export const FRAME_FILL = 0.5

/**
 * 「把某块世界范围摆到视口中央」所需的相机参数。
 *
 * 与 `fit` 的区别：`fit` 把**全部内容**铺满视口（只留固定 padding）；
 * 这里只让**目标点**落到屏幕中心、内容只占 `fill` 比例 ——
 * 层级树里双击一个远处的节点时，希望它出现在正中间且带着周围上下文。
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
