/**
 * 图集 UV 换算公共工具。
 * 全局约定（与参考库一致）：
 * - 所有像素长度 ÷ PPU 存世界单位
 * - UV 归一化到 0..1 且 **v 翻转**（Unity/编辑器使用左下原点）
 */

/** 骨架单位 → 世界单位的换算（1 单位 ≈ 100 像素） */
export const PPU = 100

export function pxToUnit(value: number): number {
  return value / PPU
}

/** 图集区域：px 坐标 + 旋转（0/90/180/270） */
export interface AtlasRegion {
  name: string
  /** 所在图集页（png 名） */
  page: string
  x: number
  y: number
  width: number
  height: number
  /** 旋转角度（度），DragonBones 用 rotate 布尔时视为 90 */
  rotate: number
  /** 原始尺寸（未裁剪） */
  origWidth: number
  origHeight: number
  /** 裁剪偏移 */
  offsetX: number
  offsetY: number
  /** 源图片绝对路径（编辑器内用于加载纹理） */
  imagePath?: string
}

/** 图集页尺寸表：页名 → { 宽, 高 } */
export type PageSizes = Record<string, { width: number; height: number }>

/**
 * 把图集里的像素坐标块映射成归一化 UV（含 v 翻转与旋转）。
 * 返回四角顺序：左下 → 右下 → 右上 → 左上（与 Region 顶点顺序一致）。
 */
export function regionUvs(region: AtlasRegion, pageSizes: PageSizes): Float32Array {
  const page = pageSizes[region.page] ?? { width: 1, height: 1 }
  const tw = Math.max(1, page.width)
  const th = Math.max(1, page.height)
  const u0 = region.x / tw
  const u1 = (region.x + region.width) / tw
  const v0 = 1 - (region.y + region.height) / th
  const v1 = 1 - region.y / th

  // 旋转 90°：图集中占位宽高互换，四角 UV 需要按旋转后的对应关系输出
  const rotate = ((region.rotate % 360) + 360) % 360
  if (rotate === 90) {
    return new Float32Array([u0, v1, u0, v0, u1, v0, u1, v1])
  }
  if (rotate === 180) {
    return new Float32Array([u1, v1, u0, v1, u0, v0, u1, v0])
  }
  if (rotate === 270) {
    return new Float32Array([u1, v0, u1, v1, u0, v1, u0, v0])
  }
  return new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1])
}

/**
 * 把「相对图集区域」的 0..1 UV 映射到图集页的归一化 UV（Spine / DragonBones 的 mesh uvs）。
 */
export function mapRegionRelativeUvs(
  relative: ArrayLike<number>,
  region: AtlasRegion,
  pageSizes: PageSizes
): Float32Array {
  const page = pageSizes[region.page] ?? { width: 1, height: 1 }
  const tw = Math.max(1, page.width)
  const th = Math.max(1, page.height)
  const out = new Float32Array(relative.length)
  for (let i = 0; i + 1 < relative.length; i += 2) {
    const u = relative[i]
    const v = relative[i + 1]
    const px = region.x + u * region.width
    const py = region.y + (1 - v) * region.height
    out[i] = px / tw
    out[i + 1] = 1 - py / th
  }
  return out
}

/**
 * Region 附件的几何换算（对齐官方 RegionAttachment.UpdateOffset）：
 * - 显示尺寸 = 原始尺寸 × 附件缩放（displayWidth / origWidth）
 * - 局部偏移 = 裁剪块中心相对原图中心的位移（y 轴翻转），再乘同一个缩放
 *
 * 图集里被旋转 90°/270° 的区域，其存储宽高是互换的，先还原逻辑尺寸再算裁剪中心。
 */
export function regionGeometry(
  region: AtlasRegion,
  displayWidthPx?: number,
  displayHeightPx?: number
): { width: number; height: number; offsetX: number; offsetY: number } {
  const rotated = Math.abs(((region.rotate % 360) + 360) % 360 - 90) < 1e-6
  const packedW = rotated ? region.height : region.width
  const packedH = rotated ? region.width : region.height
  const origW = region.origWidth > 0 ? region.origWidth : packedW
  const origH = region.origHeight > 0 ? region.origHeight : packedH

  const kx = displayWidthPx && origW > 0 ? displayWidthPx / origW : 1
  const ky = displayHeightPx && origH > 0 ? displayHeightPx / origH : 1

  return {
    width: pxToUnit(origW * kx),
    height: pxToUnit(origH * ky),
    offsetX: pxToUnit((region.offsetX + packedW * 0.5 - origW * 0.5) * kx),
    offsetY: pxToUnit(-(region.offsetY + packedH * 0.5 - origH * 0.5) * ky)
  }
}

/** 从纯色/十六进制字符串解析颜色（Spine 与 DragonBones 通用） */
export function parseHexColor(text: string | undefined, fallback = { r: 1, g: 1, b: 1, a: 1 }): {
  r: number
  g: number
  b: number
  a: number
} {
  if (typeof text !== 'string') return { ...fallback }
  let hex = text.trim()
  if (hex.startsWith('#')) hex = hex.slice(1)
  if (hex.length !== 6 && hex.length !== 8) return { ...fallback }
  if (!/^[0-9a-fA-F]+$/.test(hex)) return { ...fallback }
  const at = (offset: number): number => parseInt(hex.slice(offset, offset + 2), 16) / 255
  return { r: at(0), g: at(2), b: at(4), a: hex.length === 8 ? at(6) : 1 }
}
