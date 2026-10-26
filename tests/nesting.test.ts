import { describe, expect, it } from 'vitest'
import { childClock, checkNestDrop, sampleSubArmature, validateNestGraph } from '@core/nesting/nest'
import { emptySubArmatureKeyframe } from '@core/model/animation'
import { createAuthoringAttachment, createAuthoringBone, createAuthoringSlot, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'

/** 造一个骨架：`refs` 里每个元素是一个「插槽 → 被引用骨架名」 */
function doc(name: string, refs: Array<{ slot: string; target: string }> = []): EditorDocument {
  const document = createEmptyDocument(name)
  document.bones = [createAuthoringBone({ name: 'root' })]
  document.skins = [
    {
      name: 'default',
      slots: refs.map((ref) => ({
        slot: ref.slot,
        attachments: [
          createAuthoringAttachment({ name: `${ref.slot}_arm`, type: 'armature', subArmature: ref.target })
        ]
      }))
    }
  ]
  return document
}

describe('子骨架时钟', () => {
  it('循环：对时长取模，负偏移也落回 [0, duration)', () => {
    expect(childClock({ parentTime: 0, keyTime: 0, offset: 0, speed: 1, playTimes: 0, duration: 2 })).toBe(0)
    expect(childClock({ parentTime: 3, keyTime: 0, offset: 0, speed: 1, playTimes: 0, duration: 2 })).toBeCloseTo(1)
    expect(childClock({ parentTime: 0.5, keyTime: 1, offset: 0, speed: 1, playTimes: 0, duration: 2 })).toBeCloseTo(
      1.5
    )
    expect(childClock({ parentTime: 0, keyTime: 0, offset: -0.5, speed: 1, playTimes: 0, duration: 2 })).toBeCloseTo(
      1.5
    )
  })

  it('倍速只影响父时间到子时间的换算', () => {
    expect(childClock({ parentTime: 1, keyTime: 0, offset: 0, speed: 2, playTimes: 0, duration: 4 })).toBeCloseTo(2)
  })

  it('播 N 次后定格在末帧（不再越拖越远）', () => {
    const at = childClock({ parentTime: 100, keyTime: 0, offset: 0, speed: 1, playTimes: 2, duration: 1 })
    expect(at).toBeGreaterThan(1.999)
    expect(at).toBeLessThanOrEqual(2)
  })

  it('时长为 0 时恒为 0', () => {
    expect(childClock({ parentTime: 5, keyTime: 0, offset: 1, speed: 1, playTimes: 0, duration: 0 })).toBe(0)
  })
})

describe('子骨架通道采样', () => {
  const track = [
    emptySubArmatureKeyframe(0, 'idle', 0, 0, 1),
    emptySubArmatureKeyframe(1, 'attack', 1, 0.2, 2)
  ]

  it('取 time <= t 的最后一帧（阶跃）', () => {
    expect(sampleSubArmature(track, 0)?.animation).toBe('idle')
    expect(sampleSubArmature(track, 0.99)?.animation).toBe('idle')
    const later = sampleSubArmature(track, 1)
    expect(later?.animation).toBe('attack')
    expect(later?.playTimes).toBe(1)
    expect(later?.speed).toBe(2)
    expect(later?.keyTime).toBe(1)
  })

  it('首个关键帧之前返回 null（调用方回落到 setup 默认值）', () => {
    expect(sampleSubArmature([emptySubArmatureKeyframe(1, 'walk')], 0.5)).toBeNull()
    expect(sampleSubArmature(undefined, 0)).toBeNull()
  })
})

describe('嵌套引用校验', () => {
  it('自引用 / 缺引用 / 环都能识别', () => {
    const docs = [
      doc('A', [{ slot: 's1', target: 'A' }]),
      doc('B', [{ slot: 's2', target: 'Missing' }]),
      doc('C', [{ slot: 's3', target: 'D' }]),
      doc('D', [{ slot: 's4', target: 'C' }])
    ]
    const result = validateNestGraph(docs)
    expect(result.selfReferences).toHaveLength(1)
    expect(result.missing).toHaveLength(1)
    expect(result.cycles.length).toBeGreaterThan(0)
    expect(result.cycles[0]).toContain('C')
  })

  it('拖放前的单边校验：自引用 / 环 / 超深都拒绝', () => {
    const docs = [doc('A'), doc('B', [{ slot: 's', target: 'C' }]), doc('C')]
    expect(checkNestDrop(docs, 'A', 'A')).toContain('自己')
    // C → B 已经存在，再把 B 挂到 C 上就成环
    expect(checkNestDrop(docs, 'C', 'B')).toContain('循环')
    expect(checkNestDrop(docs, 'A', 'B')).toBeNull()
  })

  it('超过层数上限被拒绝', () => {
    const docs = [doc('A'), doc('B')]
    expect(checkNestDrop(docs, 'A', 'B', 0)).toContain('层数')
  })
})
