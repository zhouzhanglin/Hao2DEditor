export interface PageSize {
  width: number
  height: number
}

export interface Placement {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把「源图集页内」的归一化 UV 重映射到「新图集页内的放置位置」。
 *
 * 导出时按**整图**打包（不裁剪），因此映射是 UV 空间上的仿射变换：
 *   u_new = (pageX + u_old * srcW) / newW
 *   v_new = 1 - (pageY + (1 - v_old) * srcH) / newH
 * （UV 的 v 以左下为原点，图块放置坐标以左上为原点）
 */
export function remapPageUvs(
  uvs: ArrayLike<number>,
  source: PageSize,
  placement: Placement,
  page: PageSize
): Float32Array {
  const out = new Float32Array(uvs.length)
  const newW = Math.max(1, page.width)
  const newH = Math.max(1, page.height)
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    const u = uvs[i]
    const v = uvs[i + 1]
    out[i] = (placement.x + u * source.width) / newW
    out[i + 1] = 1 - (placement.y + (1 - v) * source.height) / newH
  }
  return out
}

/** 从一组 UV 反推它们在源页上的像素包围盒（整图打包时用于还原尺寸） */
export function uvBounds(
  uvs: ArrayLike<number>,
  page: PageSize
): { minU: number; minV: number; maxU: number; maxV: number } {
  let minU = Number.POSITIVE_INFINITY
  let minV = Number.POSITIVE_INFINITY
  let maxU = Number.NEGATIVE_INFINITY
  let maxV = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    minU = Math.min(minU, uvs[i])
    maxU = Math.max(maxU, uvs[i])
    minV = Math.min(minV, uvs[i + 1])
    maxV = Math.max(maxV, uvs[i + 1])
  }
  if (!Number.isFinite(minU)) return { minU: 0, minV: 0, maxU: 0, maxV: 0 }
  void page
  return { minU, minV, maxU, maxV }
}
