import type { AtlasRegion } from './uv'

export interface SpineAtlasParseResult {
  regions: AtlasRegion[]
  /** 页名 → 页面尺寸（由 .atlas 的 size 字段给出；未给出时为 0，需由 png 实际尺寸补全） */
  pageSizes: Record<string, { width: number; height: number }>
  warnings: string[]
}

/**
 * 解析 Spine `.atlas` 文本。
 *
 * 结构：每个图集页以 `xxx.png` 开头，随后可带页级参数（size / filter / repeat…），
 * 之后每段是一个 region：首行是名字，随后是缩进的键值对（rotate / xy / size / orig / offset / bounds / offsets）。
 */
export function parseSpineAtlas(text: string): SpineAtlasParseResult {
  const regions: AtlasRegion[] = []
  const pageSizes: Record<string, { width: number; height: number }> = {}
  const warnings: string[] = []

  const lines = text.split(/\r?\n/)
  let page = ''
  let current: Partial<AtlasRegion> | null = null

  const flush = (): void => {
    if (!current || !page) {
      current = null
      return
    }
    if (typeof current.name !== 'string' || current.name.length === 0) {
      current = null
      return
    }
    regions.push({
      name: current.name,
      page,
      x: current.x ?? 0,
      y: current.y ?? 0,
      width: current.width ?? 0,
      height: current.height ?? 0,
      rotate: current.rotate ?? 0,
      origWidth: current.origWidth ?? current.width ?? 0,
      origHeight: current.origHeight ?? current.height ?? 0,
      offsetX: current.offsetX ?? 0,
      offsetY: current.offsetY ?? 0
    })
    current = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }

    const indented = /^\s/.test(raw)

    if (!indented && /\.(png|jpg|jpeg|webp)$/i.test(line)) {
      flush()
      page = line
      pageSizes[page] = pageSizes[page] ?? { width: 0, height: 0 }
      continue
    }

    if (!indented && !line.includes(':')) {
      // 新的 region 名
      flush()
      if (!page) {
        warnings.push(`图集区域「${line}」出现在任何图集页之前，已忽略`)
        continue
      }
      current = { name: line }
      continue
    }

    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    if (!current) {
      // 页级参数
      if (key === 'size' && page) {
        const size = parseNumbers(value)
        if (size.length >= 2) pageSizes[page] = { width: size[0], height: size[1] }
        else warnings.push(`图集页「${page}」的 size 无法解析：${value}`)
      }
      continue
    }

    switch (key) {
      case 'rotate': {
        if (value === 'true') current.rotate = 90
        else if (value === 'false') current.rotate = 0
        else {
          const n = Number(value)
          current.rotate = Number.isFinite(n) ? n : 0
        }
        break
      }
      case 'xy': {
        const n = parseNumbers(value)
        current.x = n[0] ?? 0
        current.y = n[1] ?? 0
        break
      }
      case 'size': {
        const n = parseNumbers(value)
        current.width = n[0] ?? 0
        current.height = n[1] ?? 0
        break
      }
      case 'bounds': {
        // 4.x 的紧凑写法：bounds: x, y, **width, height**（不是 x1,y1,x2,y2 —— 早先按后者解析，
        // 宽高会变成 x-width 的负数，附件尺寸直接错掉一个数量级）
        const n = parseNumbers(value)
        current.x = n[0] ?? 0
        current.y = n[1] ?? 0
        current.width = n[2] ?? 0
        current.height = n[3] ?? 0
        break
      }
      case 'orig': {
        const n = parseNumbers(value)
        current.origWidth = n[0] ?? current.width ?? 0
        current.origHeight = n[1] ?? current.height ?? 0
        break
      }
      case 'offset': {
        const n = parseNumbers(value)
        current.offsetX = n[0] ?? 0
        current.offsetY = n[1] ?? 0
        break
      }
      case 'offsets': {
        // Spine 4.x：一行给出 offsetX, offsetY, origW, origH
        const n = parseNumbers(value)
        current.offsetX = n[0] ?? 0
        current.offsetY = n[1] ?? 0
        current.origWidth = n[2] ?? current.width ?? 0
        current.origHeight = n[3] ?? current.height ?? 0
        break
      }
      default:
        break
    }
  }
  flush()

  if (regions.length === 0) warnings.push('图集中没有解析出任何区域')
  return { regions, pageSizes, warnings }
}

function parseNumbers(value: string): number[] {
  return value
    .split(/[,\s]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n))
}

/** 把 region 列表按名字建索引（同名先到先得） */
export function indexRegions(regions: readonly AtlasRegion[]): Map<string, AtlasRegion> {
  const map = new Map<string, AtlasRegion>()
  for (const region of regions) if (!map.has(region.name)) map.set(region.name, region)
  return map
}
