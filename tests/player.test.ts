import { describe, expect, it } from 'vitest'
import { AnimationPlayer } from '@core/anim/player'
import { Skeleton } from '@core/model/skeleton'
import { Easing, emptyBoneAnim, emptySlotAnim } from '@core/model/animation'
import type { AnimData, EventKeyframe, FloatKeyframe } from '@core/model/animation'
import { asset, bone, region, skin, slot } from './fixtures'

function rotKeys(...values: Array<[number, number, Easing?]>): FloatKeyframe[] {
  return values.map(([time, value, easing]) => ({
    time,
    value,
    easing: easing ?? Easing.Linear,
    curve: null
  }))
}

function makeRuntime(animations: AnimData[]) {
  return asset(
    [bone('root', -1, 0, 0, 0, 10)],
    [slot('s', 0)],
    [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])],
    { animations }
  )
}

function createPlayer(animations: AnimData[]) {
  const runtime = makeRuntime(animations)
  const skeleton = new Skeleton(runtime)
  return new AnimationPlayer(runtime, skeleton)
}

describe('AnimationPlayer 绝对时钟（子骨架循环用）', () => {
  const loopAnim = () => ({ ...emptyAnimData('a'), duration: 1 })

  it('循环时 time 回卷，elapsed 继续累加', () => {
    const player = createPlayer([loopAnim()])
    player.play('a', true)
    player.update(0.75)
    expect(player.time).toBeCloseTo(0.75)
    expect(player.elapsed).toBeCloseTo(0.75)
    // 越过一圈：time 回到 0.25，elapsed 继续往前走（子骨架据此才不会被拉回 0 帧）
    player.update(0.5)
    expect(player.time).toBeCloseTo(0.25)
    expect(player.elapsed).toBeCloseTo(1.25)
  })

  it('seek 让绝对时钟跟手（拖播放头时子骨架确定性定位）', () => {
    const player = createPlayer([loopAnim()])
    player.play('a', true)
    player.update(3)
    player.seek(0.4)
    expect(player.time).toBeCloseTo(0.4)
    expect(player.elapsed).toBeCloseTo(0.4)
  })

  it('restoreElapsed 只挪绝对时钟，不动当前姿态', () => {
    const player = createPlayer([loopAnim()])
    player.play('a', true)
    player.seek(0.2)
    const time = player.time
    player.restoreElapsed(5)
    expect(player.time).toBe(time)
    expect(player.elapsed).toBe(5)
  })
})

describe('AnimationPlayer 采样', () => {
  it('play 后立即应用第 0 帧，末帧之后保持末帧值', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [1, 90]) }]
    }
    const player = createPlayer([animation])
    expect(player.play('a')).toBe(true)
    expect(player.skeleton.localRot[0]).toBeCloseTo(0, 5)
    player.update(0.5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(45, 5)
    player.update(0.5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 5)
  })

  it('首帧之前保持 setup 值（不提前套首帧）', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0.5, 90], [1, 180]) }]
    }
    const player = createPlayer([animation])
    player.play('a')
    expect(player.skeleton.localRot[0]).toBeCloseTo(0, 5)
    player.update(0.5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 5)
  })

  it('非循环播到最后一帧停下，播放长度按最后一个关键帧算（不看数据里的 duration）', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 2, // 数据里的 duration 比关键帧更长：播放长度应取最后一个关键帧（1s）
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0, Easing.Stepped], [1, 90]) }]
    }
    const player = createPlayer([animation])
    player.play('a', false)
    expect(player.duration).toBeCloseTo(1, 5)
    player.update(0.9)
    expect(player.skeleton.localRot[0]).toBeCloseTo(0, 5)
    player.update(0.2) // 越过最后一帧 → 停在末尾（Stepped 跳到 90）
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 5)
    expect(player.time).toBeCloseTo(1, 5)
    expect(player.completed).toBe(true)
  })

  it('循环播放到最后一帧后回到第一帧继续', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 5, // 数据里的 duration 更长
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [1, 90]) }]
    }
    const player = createPlayer([animation])
    player.play('a', true)
    expect(player.duration).toBeCloseTo(1, 5)
    player.update(1.1) // 越过最后一帧 1s → 回绕
    expect(player.time).toBeCloseTo(0.1, 4)
    expect(player.completed).toBe(false)
  })

  it('normalizedTime 与 time 可读写', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 2,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [2, 180]) }]
    }
    const player = createPlayer([animation])
    player.play('a')
    player.normalizedTime = 0.5
    expect(player.time).toBeCloseTo(1, 5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 5)
    player.time = 1.5
    expect(player.normalizedTime).toBeCloseTo(0.75, 5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(135, 5)
  })

  it('循环动画到末尾后回绕', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [1, 360]) }]
    }
    const player = createPlayer([animation])
    player.play('a', true)
    player.update(1.25)
    expect(player.time).toBeCloseTo(0.25, 5)
  })

  it('非循环动画到达末尾触发一次 OnComplete', () => {
    const animation = { ...emptyAnimData('a'), duration: 1 }
    const player = createPlayer([animation])
    const completed: string[] = []
    player.onComplete = (name) => completed.push(name)
    player.play('a', false)
    player.update(0.5)
    expect(completed).toHaveLength(0)
    player.update(0.6)
    expect(completed).toEqual(['a'])
    player.update(1)
    expect(completed).toEqual(['a'])
  })

  it('paused 时 update 不推进时间', () => {
    const animation = { ...emptyAnimData('a'), duration: 1 }
    const player = createPlayer([animation])
    player.play('a')
    player.paused = true
    player.update(0.5)
    expect(player.time).toBeCloseTo(0, 5)
    player.paused = false
    player.update(0.5)
    expect(player.time).toBeCloseTo(0.5, 5)
  })

  it('setToPose 定格到指定进度并暂停', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [1, 90]) }]
    }
    const player = createPlayer([animation])
    player.setToPose('a', 0.5)
    expect(player.paused).toBe(true)
    expect(player.skeleton.localRot[0]).toBeCloseTo(45, 5)
  })

  it('stop 回到 setup pose', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 45], [1, 90]) }]
    }
    const runtime = makeRuntime([animation])
    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    player.play('a')
    player.update(0.5)
    expect(skeleton.localRot[0]).toBeGreaterThan(45)
    player.stop()
    expect(player.currentAnimation).toBeNull()
    expect(skeleton.localRot[0]).toBeCloseTo(0, 5)
  })
})

describe('事件触发', () => {
  function withEvent(time: number): AnimData {
    const animation = { ...emptyAnimData('a'), duration: 1 }
    const event: EventKeyframe = {
      time,
      name: 'hit',
      stringParam: '',
      intParam: 0,
      floatParam: 0
    }
    animation.events = [event]
    return animation
  }

  it('跨过事件时间点时触发一次，不重复', () => {
    const player = createPlayer([withEvent(0.5)])
    const fired: string[] = []
    player.onEvent = (e) => fired.push(e.name)
    player.play('a', false)
    player.update(0.3)
    expect(fired).toHaveLength(0)
    player.update(0.3)
    expect(fired).toEqual(['hit'])
    player.update(0.3)
    expect(fired).toEqual(['hit'])
  })

  it('seek 不补触发被跳过的事件', () => {
    const player = createPlayer([withEvent(0.5)])
    const fired: string[] = []
    player.onEvent = (e) => fired.push(e.name)
    player.play('a', false)
    player.seek(0.8)
    expect(fired).toHaveLength(0)
  })

  it('循环回绕时事件会在下一个周期再次触发', () => {
    const player = createPlayer([withEvent(0.5)])
    const fired: string[] = []
    player.onEvent = (e) => fired.push(e.name)
    player.play('a', true)
    expect(player.duration).toBeCloseTo(0.5, 5) // 播放长度 = 最后一个关键帧（事件帧）
    // 逐帧推进（贴近真实播放）：0 → 0.667，跨过事件时间 0.5 并回绕，触发一次
    for (let i = 0; i < 40; i++) player.update(1 / 60)
    expect(fired).toEqual(['hit'])
    // 再推进一个周期：回绕后再次经过 0.5，触发第二次
    for (let i = 0; i < 40; i++) player.update(1 / 60)
    expect(fired).toEqual(['hit', 'hit'])
  })
})

describe('交叉淡化', () => {
  function twoAnimations() {
    const a = {
      ...emptyAnimData('a'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 0], [1, 0]) }]
    }
    const b = {
      ...emptyAnimData('b'),
      duration: 1,
      bones: [{ ...emptyBoneAnim(0), rotate: rotKeys([0, 90], [1, 90]) }]
    }
    return [a, b]
  }

  it('淡入时按 k 线性混合两条绝对 pose', () => {
    const player = createPlayer(twoAnimations())
    player.play('a')
    expect(player.skeleton.localRot[0]).toBeCloseTo(0, 5)
    player.crossFade('b', 1)
    expect(player.skeleton.localRot[0]).toBeCloseTo(0, 5)
    player.update(0.5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(45, 1)
    player.update(0.5)
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 1)
    expect(player.isFading).toBe(false)
  })

  it('淡入时长 <= 0 时退化为直接播放', () => {
    const player = createPlayer(twoAnimations())
    player.play('a')
    player.crossFade('b', 0)
    expect(player.currentAnimation).toBe('b')
    expect(player.skeleton.localRot[0]).toBeCloseTo(90, 5)
    expect(player.isFading).toBe(false)
  })

  it('离散量（显示下标）在 k >= 0.5 时硬切', () => {
    const a = {
      ...emptyAnimData('a'),
      duration: 1,
      slots: [{ ...emptySlotAnim(0), displayIndex: [{ time: 0, value: 0, easing: Easing.Stepped, curve: null }] }]
    }
    const b = {
      ...emptyAnimData('b'),
      duration: 1,
      slots: [{ ...emptySlotAnim(0), displayIndex: [{ time: 0, value: 0, easing: Easing.Stepped, curve: null }] }]
    }
    const runtime = asset(
      [bone('root', -1), bone('child', 0, 10, 0)],
      [slot('s', 0, { displayIndex: 0 })],
      [
        skin('default', [
          { slotName: 's', attachments: [region('r0', 'tex', 2, 2), region('r1', 'tex', 2, 2)] }
        ])
      ],
      { animations: [a, b], textures: ['tex'] }
    )
    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    player.play('a')
    player.crossFade('b', 1)
    player.update(0.4)
    expect(skeleton.slotDisplayIndex[0]).toBe(0)
    player.update(0.2)
    expect(skeleton.slotDisplayIndex[0]).toBe(0)
  })
})

describe('FFD 采样', () => {
  it('在两帧之间插值，且缓冲长度严格等于需要长度', () => {
    const animation = {
      ...emptyAnimData('a'),
      duration: 1,
      deforms: [
        {
          slotIndex: 0,
          attachmentName: '',
          frames: [
            { time: 0, offsets: [0, 0, 0, 0], vertexOffset: 0, easing: Easing.Linear, curve: null },
            { time: 1, offsets: [10, 20, 30, 40], vertexOffset: 0, easing: Easing.Linear, curve: null }
          ]
        }
      ]
    }
    const player = createPlayer([animation])
    player.play('a')
    player.update(0.5)
    const offsets = player.skeleton.deformOffsets[0]
    expect(offsets).not.toBeNull()
    expect(offsets?.length).toBe(4)
    expect(offsets?.[0]).toBeCloseTo(5, 4)
    expect(offsets?.[3]).toBeCloseTo(20, 4)
  })

  it('没有 FFD 轨道时清空偏移', () => {
    const animation = { ...emptyAnimData('a'), duration: 1 }
    const player = createPlayer([animation])
    player.play('a')
    player.skeleton.deformOffsets[0] = [1, 2]
    player.update(0.1)
    expect(player.skeleton.deformOffsets[0]).toBeNull()
    expect(player.skeleton.deformOffsetBase[0]).toBe(-1)
  })
})

describe('时间精度', () => {
  it('设置到帧时刻不丢精度（否则 stepped 关键帧会晚一帧）', () => {
    const player = createPlayer([{ ...emptyAnimData('a'), duration: 3.6 }])
    player.play('a', true)
    const t = 34 / 30
    player.time = t
    // 必须是位级相等：循环取模 (x % dur + dur) % dur 会让它小 4e-16，
    // 采样时就会退回上一个关键帧，第 34 帧的 flare 位置因此不生效
    expect(player.time).toBe(t)
  })
})

function emptyAnimData(name: string): AnimData {
  return {
    name,
    duration: 1,
    bones: [],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    iks: [],
    constraints: []
  }
}
