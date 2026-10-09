/**
 * 权重显示用的骨骼配色板。
 *
 * 刻意**不**用骨骼自己的 `color` 字段：导入的骨架里每根骨骼都是同一个默认橙
 *（见 core/codec/decompile.ts），拿它上色等于没有区分度。这里按骨骼在「权重骨骼列表」
 * 里的**位置**取色 —— 列表第 1 根绿、第 2 根橙 …… 与检查器里色块的顺序完全对应，
 * 于是「视口里这块顶点是什么颜色」和「面板里哪一行」能一眼对上。
 *
 * 取值避开主题的强调蓝（#0A84FF）与警告黄（#FF9F0A），免得被误读成选中态。
 */
export const WEIGHT_PALETTE: readonly string[] = [
  '#22C55E', // 绿
  '#F97316', // 橙
  '#EF4444', // 红
  '#3B82F6', // 蓝
  '#EAB308', // 黄
  '#EC4899', // 品红
  '#8B5CF6', // 紫
  '#5EEAD4', // 青绿
  '#93A5C8', // 灰蓝
  '#A3E635', // 黄绿
  '#F472B6', // 粉
  '#38BDF8' // 天蓝
]

/** 调色板兜底色（骨骼不在列表里 / 序号无效时用） */
export const WEIGHT_PALETTE_FALLBACK = '#8E8E93'

/** 取第 index 个配色（超出长度后循环，负数给兜底色） */
export function weightPaletteColor(index: number): string {
  if (!Number.isFinite(index) || index < 0) return WEIGHT_PALETTE_FALLBACK
  return WEIGHT_PALETTE[index % WEIGHT_PALETTE.length]
}

/** 配色板里的 css 颜色 → Pixi 用的 0xRRGGBB（解析失败给兜底色） */
export function weightPaletteColorValue(index: number): number {
  const hex = weightPaletteColor(index)
  const value = Number.parseInt(hex.slice(1), 16)
  return Number.isFinite(value) ? value : 0x8e8e93
}
