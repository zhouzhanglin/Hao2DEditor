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
 * 把「相对图集区域」的 0..1 UV 映射到图集页的归一化 UV（Spine / DragonBones 的 mesh uvs）。
 *
 * 区域在图集中可能被旋转存放（Spine 的 `rotate: 90 / 180 / 270`）。映射公式照抄官方运行库
 * `MeshAttachment.ComputeUVs`（relU 向右、relV 向下；width/height 是**旋转前**的区域尺寸，
 * 90°/270° 时图集中的占位宽高互换）：
 *
 *   0°  ：px = x + relU*w          py = y + relV*h
 *   90° ：px = x + relV*h          py = y + (1 - relU)*w
 *   180°：px = x + (1 - relU)*w    py = y + (1 - relV)*h
 *   270°：px = x + (1 - relV)*h    py = y + relU*w
 *
 * 早先这里只按 0° 映射：spineboy-pro 的 head（`rotate: 180`）整块倒过来、goggles
 * （`rotate: 90`）横竖错位 —— 网格附件贴图错乱的根源。
 */
export function mapRegionRelativeUvs(
  relative: ArrayLike<number>,
  region: AtlasRegion,
  pageSizes: PageSizes
): Float32Array {
  const page = pageSizes[region.page] ?? { width: 1, height: 1 }
  const tw = Math.max(1, page.width)
  const th = Math.max(1, page.height)
  const x = region.x
  const y = region.y
  const w = region.width
  const h = region.height
  const rotate = ((Math.round(region.rotate) % 360) + 360) % 360
  const out = new Float32Array(relative.length)
  for (let i = 0; i + 1 < relative.length; i += 2) {
    const u = relative[i]
    const v = relative[i + 1]
    let px: number
    let py: number
    if (rotate === 90) {
      px = x + v * h
      py = y + (1 - u) * w
    } else if (rotate === 180) {
      px = x + (1 - u) * w
      py = y + (1 - v) * h
    } else if (rotate === 270) {
      px = x + (1 - v) * h
      py = y + u * w
    } else {
      // 相对 UV 的 v=0 指向区域**顶边**（Spine / DragonBones 同款约定），
      // 所以直接用 v 取行，只对图集 y 做一次 1-y。
      px = x + u * w
      py = y + v * h
    }
    out[i] = px / tw
    out[i + 1] = 1 - py / th
  }
  return out
}

/**
 * `mapRegionRelativeUvs` 的**逆运算**：把「图集页归一化 UV」（v 左下原点）还原成 Spine 的
 * 「区域相对 UV」（relU 向右、relV **向下**，即 v=0 指向区域顶边，与 DragonBones 的 mesh uvs 同款）。
 *
 * Spine / DragonBones 的 mesh `uvs` 都是区域相对坐标，而编辑器运行期一律存整页 UV，
 * 所以往 Spine 写 `.json` 时必须反算 —— 否则运行库会按整页坐标去乘区域尺寸，取到错位的贴图块
 * （表现是「贴图整体偏移 / 串图」）。
 *
 * v 方向坑：编辑器模型里 v 是**左下原点**（v=0 图像底部），而这里解出来的是 relV（向下、
 * v=0 区域顶边）—— 两者不是简单互补关系，`py = (1 - v) * th` 这一步已经把左下原点的 v 换成了
 * 左上原点的行号，**不能再补一次 `1 - v`**：多翻一次会让整张网格纹理在区域内上下颠倒
 * （Dora 的 mouth_d、Sheep 的 ear_rt 都栽在这上面；表现是位置对、贴图内容镜像）。
 * 旋转分支是 `mapRegionRelativeUvs` 四个正向公式的代数逆解，两者必须成对修改。
 */
export function pageUvsToRegionRelative(
  uvs: ArrayLike<number>,
  region: AtlasRegion,
  pageSizes: PageSizes
): Float32Array {
  const page = pageSizes[region.page] ?? { width: 1, height: 1 }
  const tw = Math.max(1, page.width)
  const th = Math.max(1, page.height)
  const x = region.x
  const y = region.y
  const w = Math.max(1e-6, region.width)
  const h = Math.max(1e-6, region.height)
  const rotate = ((Math.round(region.rotate) % 360) + 360) % 360
  const out = new Float32Array(uvs.length)
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    // 整页 UV（v 左下原点）→ 页内像素（左上原点）
    const px = uvs[i] * tw
    const py = (1 - uvs[i + 1]) * th
    let u: number
    let v: number
    if (rotate === 90) {
      // 正向：px = x + v*h，py = y + (1-u)*w
      v = (px - x) / h
      u = 1 - (py - y) / w
    } else if (rotate === 180) {
      u = 1 - (px - x) / w
      v = 1 - (py - y) / h
    } else if (rotate === 270) {
      v = 1 - (px - x) / h
      u = (py - y) / w
    } else {
      u = (px - x) / w
      v = (py - y) / h
    }
    // 这里得到的 (u, v) 已经是 Spine 要的 relU/relV（向下），直接写出，别再翻 v
    out[i] = u
    out[i + 1] = v
  }
  return out
}

/** Region 附件的四角「内容相对 UV」：左下 → 右下 → 右上 → 左上（与 Region 顶点顺序一致） */
const REGION_CORNER_UVS = Float32Array.from([0, 1, 1, 1, 1, 0, 0, 0])

/**
 * 把图集里的像素坐标块映射成归一化 UV（含 v 翻转与旋转）。
 * 返回四角顺序：左下 → 右下 → 右上 → 左上（与 Region 顶点顺序一致）。
 *
 * 旋转统一交给 `mapRegionRelativeUvs`：四角只是四个「内容相对 UV」
 * （v=0 指向内容顶边，所以左下 = (0,1)、右下 = (1,1)、右上 = (1,0)、左上 = (0,0)）。
 * 早先两处各写一套旋转分支，90°/270° 那套既没换占位宽高、方向也是反的。
 */
export function regionUvs(region: AtlasRegion, pageSizes: PageSizes): Float32Array {
  return mapRegionRelativeUvs(REGION_CORNER_UVS, region, pageSizes)
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
): {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
  offsetX: number
  offsetY: number
} {
  /*
   * 区域尺寸**不按图集旋转交换**：`bounds` 的宽高就是区域自身的宽高，`rotate` 只描述它在图集页里
   * 怎么摆（由 UV 映射承担，见 mapRegionRelativeUvs）。这一点对齐官方运行库
   * `RegionAttachment.computeUVs`：它用的也是 `region.width/height` 原值。
   *
   * 早先在这里按 90°/270° 交换了占位宽高，于是「裁剪居中补偿」对旋转区域多减了一份
   * (w−h)/2 —— 表现是 rotate:90 的附件整体沿对角线平移（FootSoldier 的 eyes blink 67×22
   * 偏了 0.225、mouth 28×21 偏了 0.035，正好都等于 (w−h)/2）。
   */
  const origW = region.origWidth > 0 ? region.origWidth : region.width
  const origH = region.origHeight > 0 ? region.origHeight : region.height

  const kx = displayWidthPx && origW > 0 ? displayWidthPx / origW : 1
  const ky = displayHeightPx && origH > 0 ? displayHeightPx / origH : 1

  return {
    width: pxToUnit(origW * kx),
    height: pxToUnit(origH * ky),
    // 内容（图集里那块有像素的区域）的显示尺寸：渲染四边形按它画，裁剪留白靠 offsetX/offsetY 定位
    contentWidth: pxToUnit(region.width * kx),
    contentHeight: pxToUnit(region.height * ky),
    // 未裁剪区域这里是 0（区域中心 = 附件位置）；裁剪时按 (bounds − orig)/2 补回中心
    offsetX: pxToUnit((region.offsetX + region.width * 0.5 - origW * 0.5) * kx),
    offsetY: pxToUnit(-(region.offsetY + region.height * 0.5 - origH * 0.5) * ky)
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
