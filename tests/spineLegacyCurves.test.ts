import { describe, expect, it } from 'vitest'
import { bezierEase, normalizeLegacyAnimations } from '@importers/spineLegacyCurves'
import type { SpineJson } from '@importers/spineTypes'

/** 3.3 风格的最小文件：两根骨骼 + 一条带缓动的 translate / rotate 轨道 */
function legacyJson(): SpineJson {
  return {
    skeleton: { spine: '3.3.07' },
    animations: {
      flying: {
        bones: {
          COG: {
            rotate: [
              { time: 0, angle: 0, curve: [0.456, 0.2, 0.422, 1.06] },
              { time: 0.5, angle: 23.93 },
              { time: 1, angle: 0 }
            ],
            translate: [
              { time: 0, x: 0, y: 0, curve: [0.33, 1, 0.816, 1.33] },
              { time: 0.5, x: 0, y: 113.01, curve: 'linear' },
              { time: 1, x: 0, y: 0 }
            ]
          }
        }
      },
      stepped: {
        bones: {
          COG: {
            scale: [
              { time: 0, x: 1, y: 1, curve: 'stepped' },
              { time: 1, x: -1, y: 1 }
            ]
          }
        }
      }
    }
  }
}

describe('bezierEase', () => {
  it('线性控制点时就是匀速', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(bezierEase(1 / 3, 1 / 3, 2 / 3, 2 / 3, t)).toBeCloseTo(t, 4)
    }
  })

  it('端点固定为 0 / 1，且允许过冲', () => {
    expect(bezierEase(0.33, 1, 0.816, 1.33, 0)).toBe(0)
    expect(bezierEase(0.33, 1, 0.816, 1.33, 1)).toBe(1)
    expect(bezierEase(0.33, 1.33, 0.816, 1.33, 0.5)).toBeGreaterThan(0.5)
  })
})

describe('老格式动画规整', () => {
  it('4.x 的文件原样返回', () => {
    const json = { skeleton: { spine: '4.3.74-beta' }, animations: {} } as SpineJson
    const result = normalizeLegacyAnimations(json, 30)
    expect(result.segments).toBe(0)
    expect(result.renamed).toBe(0)
    expect(result.json).toBe(json)
  })

  it('rotate 的 angle 改名成 value（官方 4.2+ 只认 value）', () => {
    const result = normalizeLegacyAnimations(legacyJson(), 30)
    const rotate = result.json.animations?.flying.bones?.COG.rotate ?? []
    // 三个 rotate 关键帧都写的是 angle
    expect(result.renamed).toBe(3)
    expect(rotate[0]).not.toHaveProperty('angle')
    expect(rotate.every((key) => typeof key.value === 'number')).toBe(true)
    // 改名后的值保持原样（0 → 23.93 → 0），没有变成 0
    expect(rotate.map((key) => key.value)).toContain(23.93)
  })

  it('带缓动的段按帧率拆成线性子键，端点与缓动值都对', () => {
    const fps = 30
    const result = normalizeLegacyAnimations(legacyJson(), fps)
    const keys = result.json.animations?.flying.bones?.COG.translate ?? []
    const rotate = result.json.animations?.flying.bones?.COG.rotate ?? []
    // translate 两段（贝塞尔 + linear）+ rotate 一段（贝塞尔）
    expect(result.segments).toBe(3)
    // rotate 也被拆开：原本 3 帧
    expect(rotate.length).toBeGreaterThan(3)
    // 两段各拆成 15 个（起点 + 14 个子键），再加最后那一帧 = 31
    expect(keys.length).toBe(15 + 15 + 1)
    // 起点保留原值、曲线被摘掉
    expect(keys[0]).toMatchObject({ time: 0, x: 0, y: 0 })
    expect(keys[0].curve).toBeUndefined()
    // 拆出来的子键都落在曲线上：取第一段里的一个子键（t≈0.233）与贝塞尔求值比对。
    //
    // 曲线 `[0.33, 1, 0.816, 1.33]` 的分量超出 [0,1]，但那只是**过冲**（3.x 的语义：cx 是两帧之间的
    // 时间百分比、cy 是取值差的百分比，两者都允许过冲），它仍是**归一化控制点**，直接求值即可。
    // 官方运行库就是这么读的：同一段曲线在进度 2/3 处读出的取值倍率是 1.08（曲线自身的过冲），
    // 若误判成「(时间, 值) 绝对坐标」，这一段会被压成「一整段几乎不动 → 到末尾突跳」。
    const mid = keys.find((key) => key.time > 0.2)
    expect(mid?.time).toBeCloseTo(7 / 30, 6)
    const progress = (mid?.time ?? 0) / 0.5
    expect(mid?.y).toBeCloseTo(bezierEase(0.33, 1, 0.816, 1.33, progress) * 113.01, 6)
    // 关键帧时刻的值不变（采样点上零误差）
    expect(keys.find((key) => Math.abs(key.time - 0.5) < 1e-9)?.y).toBeCloseTo(113.01, 6)
    expect(keys[keys.length - 1]).toMatchObject({ time: 1, y: 0 })
  })

  it('双分量轨道的 8 个控制点按通道分开取（x 用前 4、y 用后 4）', () => {
    const json: SpineJson = {
      skeleton: { spine: '3.3.07' },
      animations: {
        fly: {
          bones: {
            b: {
              translate: [
                // 8 个数：x 通道 [0,0.5,1,1]（快速到位），y 通道 [0.25,0,0.75,1]（匀速）
                { time: 0, x: 0, y: 0, curve: [0, 0.5, 1, 1, 0.25, 0, 0.75, 1] },
                { time: 0.5, x: 10, y: 20 }
              ]
            }
          }
        }
      }
    }
    // 20fps → 段内子键落在 0.05 的整数倍上，0.25（进度 0.5）正好是个子键
    const keys = normalizeLegacyAnimations(json, 20).json.animations?.fly.bones?.b.translate ?? []
    const mid = keys.find((key) => Math.abs(key.time - 0.25) < 1e-9)
    // x 通道用前 4 个控制点 [0, 0.5, 1, 1]：进度 0.5 时必须已经走完一大半
    expect(mid?.x).toBeGreaterThan(5)
    // y 通道用后 4 个 [0.25, 0, 0.75, 1]：进度 0.5 时约在一半
    expect(mid?.y).toBeCloseTo(10, 4)
  })

  it('stepped 段保持原样（拆开会破坏「瞬间切换」）', () => {
    const result = normalizeLegacyAnimations(legacyJson(), 30)
    const scale = result.json.animations?.stepped.bones?.COG.scale ?? []
    expect(scale).toHaveLength(2)
    expect(scale[0].curve).toBe('stepped')
  })

  it('不改动传入的 JSON（返回深拷贝）', () => {
    const json = legacyJson()
    normalizeLegacyAnimations(json, 30)
    expect(json.animations?.flying.bones?.COG.translate).toHaveLength(3)
    expect(json.animations?.flying.bones?.COG.rotate?.[0]).toHaveProperty('angle')
  })
})
