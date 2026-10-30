/**
 * 导出视频用的取景相机（纯计算，不依赖 Pixi，可单测）。
 *
 * 与编辑器视口是**两套独立坐标**：
 * - 编辑器视口：`offsetX/offsetY` 表示「世界原点在屏幕上的位置」，跟着面板尺寸走；
 * - 导出：画面尺寸由用户选定（1920×1080 等），与面板无关，所以这里直接用
 *   「画面中心对准哪个世界坐标 + 每世界单位画多少**视频像素**」这几个量来描述取景。
 *
 * 单位约定与编辑器一致：`zoom` 的数值就是百分比（1 世界单位 = PPU(100) 图像像素，
 * 所以 zoom = 100 → 100% → 1 图像像素画 1 视频像素）。
 */

export interface ExportView {
  /** 视频像素 / 世界单位（数值即百分比，见上面说明） */
  zoom: number
  /** 画面中心对准的世界坐标 */
  centerX: number
  centerY: number
}

export interface ExportBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 导出允许的缩放区间（5% ~ 800%）。
 *
 * 比编辑器视口的下限（10%）更宽：导出常常要把整个角色塞进一个小画幅，
 * 或者在 4K 画幅里只截一小块，这两个方向都需要更大的余量。
 */
export const EXPORT_ZOOM_MIN = 5
export const EXPORT_ZOOM_MAX = 800

export function clampExportZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 100
  return Math.min(EXPORT_ZOOM_MAX, Math.max(EXPORT_ZOOM_MIN, zoom))
}

/** 世界坐标 → 视频像素坐标（左上原点、y 向下） */
export function worldToVideo(
  view: ExportView,
  width: number,
  height: number,
  worldX: number,
  worldY: number
): { x: number; y: number } {
  return {
    x: (worldX - view.centerX) * view.zoom + width / 2,
    y: -(worldY - view.centerY) * view.zoom + height / 2
  }
}

/** 视频像素坐标 → 世界坐标（`worldToVideo` 的逆） */
export function videoToWorld(
  view: ExportView,
  width: number,
  height: number,
  videoX: number,
  videoY: number
): { x: number; y: number } {
  return {
    x: (videoX - width / 2) / view.zoom + view.centerX,
    y: -(videoY - height / 2) / view.zoom + view.centerY
  }
}

/** 内容包围盒中心（退化时退回原点） */
export function boundsCenter(bounds: ExportBounds | null): { x: number; y: number } {
  if (!bounds) return { x: 0, y: 0 }
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

/**
 * 「把内容装进画幅」的默认取景：居中 + 按较长边定缩放。
 *
 * `fill` 是内容最多占画幅的比例（0.86 = 四周各留 7% 的呼吸位），
 * 与编辑器「适配视野」的 padding 思路一致，只是这里按比例而不是固定像素。
 */
export function fitExportView(
  bounds: ExportBounds | null,
  width: number,
  height: number,
  fill = 0.86
): ExportView {
  const center = boundsCenter(bounds)
  if (!bounds) return { zoom: 100, centerX: center.x, centerY: center.y }
  const contentWidth = Math.max(1e-6, bounds.maxX - bounds.minX)
  const contentHeight = Math.max(1e-6, bounds.maxY - bounds.minY)
  const zoom = clampExportZoom(
    Math.min((width * fill) / contentWidth, (height * fill) / contentHeight)
  )
  return { zoom, centerX: center.x, centerY: center.y }
}

/** 画面像素平移 → 新的取景（拖拽预览时用；向右拖 = 内容跟着往右走） */
export function panViewByPixels(view: ExportView, dx: number, dy: number): ExportView {
  return {
    zoom: view.zoom,
    centerX: view.centerX - dx / view.zoom,
    centerY: view.centerY + dy / view.zoom
  }
}

/**
 * 以画面上某点为锚缩放（滚轮缩放时用）：缩放前后该点对应的世界坐标不变。
 * 这样光标指着角色的某个部位时，那个部位不会跑。
 */
export function zoomViewAtPixel(
  view: ExportView,
  width: number,
  height: number,
  pixelX: number,
  pixelY: number,
  factor: number
): ExportView {
  const zoom = clampExportZoom(view.zoom * factor)
  if (zoom === view.zoom) return view
  const anchor = videoToWorld(view, width, height, pixelX, pixelY)
  return {
    zoom,
    centerX: anchor.x - (pixelX - width / 2) / zoom,
    centerY: anchor.y + (pixelY - height / 2) / zoom
  }
}

/** 取景相对内容中心的偏移（世界单位），面板上的「偏移 X / Y」显示它 */
export function viewOffset(view: ExportView, bounds: ExportBounds | null): { x: number; y: number } {
  const center = boundsCenter(bounds)
  return { x: view.centerX - center.x, y: view.centerY - center.y }
}

/** 把「偏移 X / Y（世界单位）」写回取景（数值框手填时用） */
export function withViewOffset(
  view: ExportView,
  bounds: ExportBounds | null,
  offsetX: number,
  offsetY: number
): ExportView {
  const center = boundsCenter(bounds)
  return {
    zoom: view.zoom,
    centerX: center.x + (Number.isFinite(offsetX) ? offsetX : 0),
    centerY: center.y + (Number.isFinite(offsetY) ? offsetY : 0)
  }
}
