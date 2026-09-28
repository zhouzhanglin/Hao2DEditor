import { ceilPowerOfTwo } from '../math/utils'

export interface PackItem {
  /** 唯一标识（通常是图集页名） */
  id: string
  width: number
  height: number
}

export interface PackPage {
  index: number
  width: number
  height: number
  /** 该页实际用到的最大边界（用于裁剪输出尺寸） */
  usedWidth: number
  usedHeight: number
}

export interface PackPlacement {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface PackOptions {
  /** 单页最大边长（默认 2048） */
  maxSize?: number
  /** 初始页边长（默认 512，按需翻倍） */
  initialSize?: number
  /** 图块之间的间隔（会加到每个图块的占位上） */
  padding?: number
  /** 页边留白 */
  border?: number
  /** 是否把页尺寸裁剪到实际用到的尺寸（默认 true） */
  trimPages?: boolean
}

export interface PackResult {
  pages: PackPage[]
  placements: PackPlacement[]
  /** 无法放入最大页尺寸的图块 */
  failed: string[]
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * MaxRects（BSSF，Best Short Side Fit）装箱。
 *
 * 逐页填充：每页从初始尺寸开始试探，若一个图块都放不下则把页尺寸翻倍重试（上限 maxSize）；
 * 放满一页后开新页。装箱结果是**确定性**的（按面积降序 + 稳定的插入顺序），便于产物可复现。
 */
export function packMaxRects(items: readonly PackItem[], options: PackOptions = {}): PackResult {
  const maxSize = Math.max(64, options.maxSize ?? 2048)
  const initialSize = Math.max(16, Math.min(maxSize, options.initialSize ?? 512))
  const padding = Math.max(0, options.padding ?? 2)
  const border = Math.max(0, options.border ?? 2)
  const trimPages = options.trimPages ?? true

  const pages: PackPage[] = []
  const placements: PackPlacement[] = []
  const failed: string[] = []

  const pending = [...items]
    .filter((item) => item.width > 0 && item.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id))

  const tooBig = pending.filter((item) => item.width + padding > maxSize || item.height + padding > maxSize)
  for (const item of tooBig) failed.push(item.id)
  const queue = pending.filter((item) => !tooBig.includes(item))

  let pageIndex = 0
  while (queue.length > 0) {
    let size = initialSize
    let bin: MaxRectsBin | null = null
    let placedAny = false

    // 找一个「至少能放下一个图块」的页尺寸
    while (size <= maxSize) {
      const candidate = new MaxRectsBin(size, size, padding, border)
      const probe = queue[0]
      if (candidate.insert(probe.width + padding, probe.height + padding)) {
        bin = new MaxRectsBin(size, size, padding, border)
        break
      }
      size = Math.min(maxSize, ceilPowerOfTwo(size + 1))
      if (size === maxSize) {
        const last = new MaxRectsBin(size, size, padding, border)
        if (last.insert(probe.width + padding, probe.height + padding)) {
          bin = new MaxRectsBin(size, size, padding, border)
        }
        break
      }
    }

    if (!bin) {
      for (const item of queue) failed.push(item.id)
      break
    }

    let usedWidth = 0
    let usedHeight = 0
    for (let i = 0; i < queue.length; ) {
      const item = queue[i]
      const spot = bin.insert(item.width + padding, item.height + padding)
      if (!spot) {
        i++
        continue
      }
      placements.push({
        id: item.id,
        page: pageIndex,
        x: spot.x + Math.floor(padding / 2),
        y: spot.y + Math.floor(padding / 2),
        width: item.width,
        height: item.height
      })
      usedWidth = Math.max(usedWidth, spot.x + item.width + padding)
      usedHeight = Math.max(usedHeight, spot.y + item.height + padding)
      placedAny = true
      queue.splice(i, 1)
    }

    if (!placedAny) {
      for (const item of queue) failed.push(item.id)
      break
    }

    const pageWidth = trimPages ? Math.min(size, Math.max(1, ceilPowerOfTwo(usedWidth))) : size
    const pageHeight = trimPages ? Math.min(size, Math.max(1, ceilPowerOfTwo(usedHeight))) : size
    pages.push({ index: pageIndex, width: pageWidth, height: pageHeight, usedWidth, usedHeight })
    pageIndex++
  }

  return { pages, placements, failed }
}

/** 单页 MaxRects：维护空闲矩形列表，插入时选「短边浪费最小」的位置 */
class MaxRectsBin {
  private readonly freeRects: Rect[]

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly padding: number,
    private readonly border: number
  ) {
    void padding
    this.freeRects = [{ x: border, y: border, width: width - border * 2, height: height - border * 2 }]
  }

  insert(w: number, h: number): { x: number; y: number } | null {
    let bestIndex = -1
    let bestShort = Number.POSITIVE_INFINITY
    let bestLong = Number.POSITIVE_INFINITY
    let bestX = 0
    let bestY = 0

    for (let i = 0; i < this.freeRects.length; i++) {
      const free = this.freeRects[i]
      if (free.width < w || free.height < h) continue
      const leftoverX = free.width - w
      const leftoverY = free.height - h
      const shortSide = Math.min(leftoverX, leftoverY)
      const longSide = Math.max(leftoverX, leftoverY)
      if (shortSide < bestShort || (shortSide === bestShort && longSide < bestLong)) {
        bestIndex = i
        bestShort = shortSide
        bestLong = longSide
        bestX = free.x
        bestY = free.y
      }
    }

    if (bestIndex < 0) return null

    const used: Rect = { x: bestX, y: bestY, width: w, height: h }
    this.splitFreeRects(used)
    this.prune()
    return { x: used.x, y: used.y }
  }

  private splitFreeRects(used: Rect): void {
    const next: Rect[] = []
    for (const free of this.freeRects) {
      if (!intersects(free, used)) {
        next.push(free)
        continue
      }
      // 上方
      if (used.y > free.y) {
        next.push({ x: free.x, y: free.y, width: free.width, height: used.y - free.y })
      }
      // 下方
      if (used.y + used.height < free.y + free.height) {
        next.push({
          x: free.x,
          y: used.y + used.height,
          width: free.width,
          height: free.y + free.height - (used.y + used.height)
        })
      }
      // 左侧
      if (used.x > free.x) {
        next.push({ x: free.x, y: free.y, width: used.x - free.x, height: free.height })
      }
      // 右侧
      if (used.x + used.width < free.x + free.width) {
        next.push({
          x: used.x + used.width,
          y: free.y,
          width: free.x + free.width - (used.x + used.width),
          height: free.height
        })
      }
    }
    this.freeRects.length = 0
    this.freeRects.push(...next)
  }

  /** 去掉被其它空闲矩形完全包含的项 */
  private prune(): void {
    for (let i = 0; i < this.freeRects.length; i++) {
      for (let j = i + 1; j < this.freeRects.length; j++) {
        if (contains(this.freeRects[j], this.freeRects[i])) {
          this.freeRects.splice(i, 1)
          i--
          break
        }
        if (contains(this.freeRects[i], this.freeRects[j])) {
          this.freeRects.splice(j, 1)
          j--
        }
      }
    }
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return !(b.x >= a.x + a.width || b.x + b.width <= a.x || b.y >= a.y + a.height || b.y + b.height <= a.y)
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}
