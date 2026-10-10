import { describe, expect, it } from 'vitest'
import { curvePercent, firstIndexAtOrAfter, lastIndexAtOrBefore, sampleInt, sampleNumber } from '@core/anim/interpolation'
import { Easing } from '@core/model/animation'
import type { FloatKeyframe } from '@core/model/animation'

function key(time: number, value: number, easing = Easing.Linear, curve: number[] | null = null): FloatKeyframe {
  return { time, value, easing, curve }
}

describe('二分查找', () => {
  const keys = [key(0, 0), key(1, 10), key(2, 20)]

  it('firstIndexAtOrAfter', () => {
    expect(firstIndexAtOrAfter(keys, -1)).toBe(0)
    expect(firstIndexAtOrAfter(keys, 0)).toBe(0)
    expect(firstIndexAtOrAfter(keys, 0.5)).toBe(1)
    expect(firstIndexAtOrAfter(keys, 1)).toBe(1)
    expect(firstIndexAtOrAfter(keys, 5)).toBe(3)
  })

  it('lastIndexAtOrBefore', () => {
    expect(lastIndexAtOrBefore(keys, -1)).toBe(-1)
    expect(lastIndexAtOrBefore(keys, 0)).toBe(0)
    expect(lastIndexAtOrBefore(keys, 1.5)).toBe(1)
    expect(lastIndexAtOrBefore(keys, 9)).toBe(2)
  })
})

describe('curvePercent', () => {
  it('Stepped 恒返回 0（保持前一帧值）', () => {
    expect(curvePercent(Easing.Stepped, null, 0.9)).toBe(0)
  })

  it('Linear 直接返回夹取后的比例', () => {
    expect(curvePercent(Easing.Linear, null, 0.3)).toBeCloseTo(0.3, 6)
    expect(curvePercent(Easing.Linear, null, 1.5)).toBeCloseTo(1, 6)
    expect(curvePercent(Easing.Linear, null, -1)).toBeCloseTo(0, 6)
  })

  it('控制量不足 4 个时退化为线性', () => {
    expect(curvePercent(Easing.Bezier, [0.1, 0.2], 0.4)).toBeCloseTo(0.4, 6)
  })

  it('对角线控制量等价于线性（y = x，误差在二分精度内）', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(curvePercent(Easing.Bezier, [0.25, 0.25, 0.75, 0.75], t)).toBeCloseTo(t, 3)
    }
  })

  it('缓入缓出曲线在两端平缓、中点对称', () => {
    const curve = [0.42, 0, 0.58, 1]
    const half = curvePercent(Easing.Bezier, curve, 0.5)
    expect(half).toBeCloseTo(0.5, 2)
    expect(curvePercent(Easing.Bezier, curve, 0.1)).toBeLessThan(0.1)
    expect(curvePercent(Easing.Bezier, curve, 0.9)).toBeGreaterThan(0.9)
  })
})

describe('sampleNumber', () => {
  it('首帧之前不写入（返回 null，保持 setup 值），恰好等于首帧时套用首帧值', () => {
    const keys = [key(0.5, 5), key(1.5, 15)]
    expect(sampleNumber(keys, 0.2)).toBeNull()
    expect(sampleNumber(keys, 0.5)).toBe(5)
    expect(sampleNumber(keys, 0.8)).toBeCloseTo(8, 5)
  })

  it('两帧之间线性插值', () => {
    const keys = [key(0, 0), key(1, 10)]
    expect(sampleNumber(keys, 0.5)).toBeCloseTo(5, 5)
  })

  it('末帧之后保持末帧值', () => {
    const keys = [key(0, 0), key(1, 10)]
    expect(sampleNumber(keys, 3)).toBeCloseTo(10, 5)
  })

  it('Stepped 段保持前帧值（easing 取段起点关键帧）', () => {
    const keys = [key(0, 0, Easing.Stepped), key(1, 10)]
    expect(sampleNumber(keys, 0.99)).toBeCloseTo(0, 5)
    expect(sampleNumber(keys, 1.5)).toBeCloseTo(10, 5)
  })
})

describe('sampleInt', () => {
  it('取最后一个 time <= 当前时间的关键帧，并返回其下标', () => {
    const keys = [
      { time: 0, value: 0, easing: Easing.Stepped, curve: null },
      { time: 0.5, value: 2, easing: Easing.Stepped, curve: null }
    ]
    expect(sampleInt(keys, 0.2)).toEqual({ value: 0, index: 0 })
    expect(sampleInt(keys, 0.5)).toEqual({ value: 2, index: 1 })
    expect(sampleInt(keys, 0.9)).toEqual({ value: 2, index: 1 })
    expect(sampleInt(keys, -1)).toBeNull()
  })
})
