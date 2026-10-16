import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BONE_STYLE,
  boneStyleAlpha,
  boneStyleColor,
  normalizeBoneHex
} from '@render/overlays/boneStyle'

/**
 * 骨骼样式默认值：没动过设置（或点了「恢复默认」）时，视口里骨骼用的就是这一档。
 */
describe('骨骼样式默认值', () => {
  it('默认值与 boneStyle.ts 里的常量一致', () => {
    expect(DEFAULT_BONE_STYLE).toEqual({
      widthPercent: 4,
      jointRadius: 6,
      fillColor: '#CCD2D8',
      fillAlpha: 0.8,
      strokeColor: '#CCD2D8',
      strokeAlpha: 0.9,
      selectedColor: '#4FE3F7'
    })
  })

  it('颜色解析：6 位 hex → pixi 色值，坏值退回白色（不能让骨骼消失）', () => {
    expect(boneStyleColor('#CCD2D8')).toBe(0xccd2d8)
    expect(boneStyleColor('ccd2d8')).toBe(0xccd2d8)
    expect(boneStyleColor('4fe3f7')).toBe(0x4fe3f7)
    expect(boneStyleColor('#xyz')).toBe(0xffffff)
    expect(boneStyleColor('')).toBe(0xffffff)
  })

  it('hex 规整：统一大写、补 #，坏值退回传入的默认色', () => {
    expect(normalizeBoneHex('#4fe3f7', '#CCD2D8')).toBe('#4FE3F7')
    expect(normalizeBoneHex('CCD2D8', '#4FE3F7')).toBe('#CCD2D8')
    expect(normalizeBoneHex('红', '#4FE3F7')).toBe('#4FE3F7')
  })

  it('透明度夹到 0..1（NaN 当成不透明，而不是画出负 alpha）', () => {
    expect(boneStyleAlpha(0.55)).toBe(0.55)
    expect(boneStyleAlpha(-1)).toBe(0)
    expect(boneStyleAlpha(9)).toBe(1)
    expect(boneStyleAlpha(Number.NaN)).toBe(1)
  })
})
