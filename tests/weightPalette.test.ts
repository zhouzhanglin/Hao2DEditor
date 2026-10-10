import { describe, expect, it } from 'vitest'
import {
  WEIGHT_PALETTE,
  WEIGHT_PALETTE_FALLBACK,
  weightBoneColorMap,
  weightPaletteColor,
  weightPaletteColorValue
} from '@core/weightPalette'

/**
 * 权重配色板与「列表位置 → 颜色」的映射。
 *
 * 这块是「面板里那一行的色块 / 视口里那根骨骼 / 顶点饼图里的那一瓣」三者对齐的唯一依据，
 * 位置算错一格就会整体串色，所以单独锁住。
 */
describe('weightPalette', () => {
  it('按位置取色，超出长度后循环，负数给兜底色', () => {
    expect(weightPaletteColor(0)).toBe(WEIGHT_PALETTE[0])
    expect(weightPaletteColor(WEIGHT_PALETTE.length)).toBe(WEIGHT_PALETTE[0])
    expect(weightPaletteColor(-1)).toBe(WEIGHT_PALETTE_FALLBACK)
    expect(weightPaletteColorValue(1)).toBe(Number.parseInt(WEIGHT_PALETTE[1].slice(1), 16))
  })

  it('权重骨骼列表 → 骨骼索引 → 颜色：列表顺序即配色顺序', () => {
    const map = weightBoneColorMap(['a', 'b', 'c'], { a: 5, b: 2, c: 9 })
    expect(map.get(5)).toBe(weightPaletteColorValue(0))
    expect(map.get(2)).toBe(weightPaletteColorValue(1))
    expect(map.get(9)).toBe(weightPaletteColorValue(2))
    expect(map.size).toBe(3)
  })

  it('已被删除的骨骼不进映射，但仍占着自己的配色位（否则后续骨骼会整体错一格）', () => {
    const map = weightBoneColorMap(['ghost', 'b'], { b: 7 })
    expect(map.size).toBe(1)
    expect(map.get(7)).toBe(weightPaletteColorValue(1))
  })
})
