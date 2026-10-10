import { describe, expect, it } from 'vitest'
import { createEmptyDocument } from '@core/model/authoring'
import type { AuthoringAnimData } from '@core/model/authoring'
import { applySlotOrder, drawOrderOf } from '@editor/commands/hierarchyCommands'
import { drawOrderFrameAt, keyDrawOrder } from '@editor/commands/animationCommands'

describe('slot 层级面板命令', () => {
  function doc() {
    const d = createEmptyDocument('t')
    const slot = (name: string, zOrder: number) => ({
      name,
      bone: 'root',
      color: '#FFFFFFFF',
      blendMode: 0,
      zOrder,
      z: 0,
      attachment: '',
      visible: true,
      locked: false
    })
    d.slots.push(slot('body', 0), slot('head', 1), slot('tail', 2))
    return d
  }

  function anim(): AuthoringAnimData {
    return {
      name: 'idle',
      duration: 2,
      bones: [],
      slots: [],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    }
  }

  it('applySlotOrder：UI 列表（顶层在前）反推 zOrder', () => {
    const d = doc()
    applySlotOrder(d, ['tail', 'head', 'body'])
    expect(drawOrderOf(d)).toEqual(['body', 'head', 'tail'])
  })

  it('drawOrderOf：zOrder 升序 = 绘制顺序（最底层在前）', () => {
    const d = doc()
    expect(drawOrderOf(d)).toEqual(['body', 'head', 'tail'])
  })

  it('keyDrawOrder：同刻覆盖、按时间排序', () => {
    const a = anim()
    keyDrawOrder(a, 1, ['tail', 'head', 'body'])
    keyDrawOrder(a, 0, ['body', 'head', 'tail'])
    keyDrawOrder(a, 1, ['head', 'body', 'tail'])
    expect(a.drawOrder.map((frame) => frame.time)).toEqual([0, 1])
    expect(a.drawOrder[0].order).toEqual(['body', 'head', 'tail'])
    expect(a.drawOrder[1].order).toEqual(['head', 'body', 'tail'])
  })

  it('drawOrderFrameAt：取最后一个 time <= t 的帧；之前没有帧返回 null', () => {
    const a = anim()
    expect(drawOrderFrameAt(a, 0.5)).toBeNull()
    keyDrawOrder(a, 0.4, ['body', 'head', 'tail'])
    keyDrawOrder(a, 1.2, ['tail', 'body', 'head'])
    expect(drawOrderFrameAt(a, 0.5)?.time).toBe(0.4)
    expect(drawOrderFrameAt(a, 1.9)?.time).toBe(1.2)
    expect(drawOrderFrameAt(a, 0.2)).toBeNull()
  })
})
