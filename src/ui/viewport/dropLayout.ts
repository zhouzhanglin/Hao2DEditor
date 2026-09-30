/**
 * 多张图片一起拖进视口时的落点排布：以落点为**中心**的紧凑网格。
 *
 * 直接叠在同一个落点上会互相盖住（看起来只进来了一张），所以按 √n 列排成网格：
 * 1 张 → 1×1、4 张 → 2×2、5~6 张 → 3×2…格子取「最大图 + 间隙」，
 * 每张在自己的格子里居中 —— 尺寸不一时也不会重叠，整组重心仍落在松手的位置。
 */
export interface DropGridLayout {
  /** 每张图相对落点的偏移（世界单位，y 轴向上为正 → 行号越大越靠下） */
  offsets: { x: number; y: number }[]
  /** 整组内容的包围盒（空场景自动聚焦时用） */
  width: number
  height: number
}

export function gridDropLayout(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  gap: number
): DropGridLayout {
  const count = sizes.length
  if (count === 0) return { offsets: [], width: 0, height: 0 }

  let maxWidth = 0
  let maxHeight = 0
  for (const size of sizes) {
    if (size.width > maxWidth) maxWidth = size.width
    if (size.height > maxHeight) maxHeight = size.height
  }
  const cellW = maxWidth + gap
  const cellH = maxHeight + gap
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)

  const offsets = sizes.map((_, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    return {
      x: (col + 0.5 - cols / 2) * cellW,
      y: (rows / 2 - row - 0.5) * cellH
    }
  })

  return {
    offsets,
    width: cols * cellW - gap,
    height: rows * cellH - gap
  }
}
