import { beforeEach, describe, expect, it } from 'vitest'
import { Easing } from '@core/model/animation'
import { createAuthoringBone, createEmptyDocument } from '@core/model/authoring'
import type { AuthoringAnimData, EditorDocument } from '@core/model/authoring'
import { createIkConstraint, createPhysicsConstraint } from '@core/model/constraints'
import { defaultConstraintState } from '@core/constraints/solver'
import type { PoseSnapshot } from '@editor/timeline/model'
import {
  buildTimeline,
  deleteKeys,
  findKeyframe,
  keyframeTargets,
  lastKeyTime,
  moveKeys,
  repairAnimationDurations,
  repairDisplayNames,
  setKeyEasing,
  setKeysTimes,
  slotDisplayNameAt
} from '@editor/timeline/model'
import type { KeySelector } from '@editor/timeline/model'
import { keyBoneChannel, keyDeform, keySlotDisplay } from '@editor/commands/animationCommands'
import { pickAnimationForAnimate } from '@editor/store/modeStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'

function animationWithKeys(): AuthoringAnimData {
  const anim: AuthoringAnimData = {
    name: 'idle',
    duration: 2,
    bones: [],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    constraints: []
  }
  keyBoneChannel(anim, 'root', 'rotate', 0, 10)
  keyBoneChannel(anim, 'root', 'rotate', 1, 40)
  keyBoneChannel(anim, 'root', 'translate', 0, { x: 0, y: 0 })
  keySlotDisplay(anim, 'head', 0, 0, 'head')
  keySlotDisplay(anim, 'head', 1, 1, 'head_hurt')
  keyDeform(anim, 'torso', 'torso', 0.5, [0, 0, 0.1, 0.2])
  anim.events.push({ time: 1, name: 'hit', stringParam: '', intParam: 0, floatParam: 0 })
  return anim
}

function selector(partial: Partial<KeySelector>): KeySelector {
  return { kind: 'bone', target: 'root', attachment: '', channel: 'rotate', time: 0, ...partial }
}

describe('按时间点采样插槽显示项', () => {
  it('没有 display 轨道 / 没有动画时用 setup 名', () => {
    expect(slotDisplayNameAt(null, 'head', 0.5, 'body')).toBe('body')
    const empty: AuthoringAnimData = {
      name: 'a',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [],
      constraints: [],
      drawOrder: [],
      events: []
    }
    expect(slotDisplayNameAt(empty, 'head', 0.5, 'body')).toBe('body')
  })

  it('取 time <= t 的最后一帧；早于第一帧时用 setup', () => {
    // animationWithKeys 里 head：t=0 →「head」，t=1 →「head_hurt」
    const anim = animationWithKeys()
    expect(slotDisplayNameAt(anim, 'head', 0, 'setup')).toBe('head')
    expect(slotDisplayNameAt(anim, 'head', 0.5, 'setup')).toBe('head')
    expect(slotDisplayNameAt(anim, 'head', 1, 'setup')).toBe('head_hurt')
    expect(slotDisplayNameAt(anim, 'head', 5, 'setup')).toBe('head_hurt')
    // 另一个插槽没有 display 轨道 → setup
    expect(slotDisplayNameAt(anim, 'leg', 0.5, 'leg_setup')).toBe('leg_setup')
  })

  it('隐藏帧（空名）采样出「不显示」', () => {
    const anim: AuthoringAnimData = {
      name: 'a',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [],
      constraints: [],
      drawOrder: [],
      events: []
    }
    keySlotDisplay(anim, 'head', 0.2, 0, 'body')
    keySlotDisplay(anim, 'head', 0.6, -1, '')
    expect(slotDisplayNameAt(anim, 'head', 0.5, 'setup')).toBe('body')
    expect(slotDisplayNameAt(anim, 'head', 0.7, 'setup')).toBe('')
  })

  it('容差内视为命中该帧，容差外回退 setup', () => {
    const anim: AuthoringAnimData = {
      name: 'a',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [],
      constraints: [],
      drawOrder: [],
      events: []
    }
    keySlotDisplay(anim, 'head', 0.2, 0, 'body')
    expect(slotDisplayNameAt(anim, 'head', 0.199, 'setup')).toBe('setup')
    expect(slotDisplayNameAt(anim, 'head', 0.2 - 1e-9, 'setup')).toBe('body')
  })
})

describe('时间轴模型', () => {
  it('骨骼按通道拆出子轨道，分组行统计总帧数', () => {
    const tracks = buildTimeline(animationWithKeys())
    // 分组行：只作标题，不含关键帧，但统计总数（rotate 2 + translate 1）
    const group = tracks.find((track) => track.id === 'bone:root')
    expect(group?.isGroup).toBe(true)
    expect(group?.keys).toHaveLength(0)
    expect(group?.keyCount).toBe(3)

    // 子轨道：位置 / 旋转 各一行，紧跟分组行之后
    const rotate = tracks.find((track) => track.id === 'bone:root:rotate')
    const translate = tracks.find((track) => track.id === 'bone:root:translate')
    expect(rotate?.keys).toHaveLength(2)
    expect(translate?.keys).toHaveLength(1)
    expect(rotate?.depth).toBe(1)
    expect(rotate?.parentId).toBe('bone:root')
    expect(rotate).toBeDefined()
    expect(group).toBeDefined()
    expect(tracks.indexOf(rotate as never)).toBeGreaterThan(tracks.indexOf(group as never))

    expect(tracks.some((track) => track.id === 'deform:torso:torso')).toBe(true)
    expect(tracks.some((track) => track.kind === 'event')).toBe(true)

    // 插槽也拆成「分组行 + 子轨」：显示帧要带上附件名，方便看清切到了哪个 display
    const slotGroup = tracks.find((track) => track.id === 'slot:head')
    const displayTrack = tracks.find((track) => track.id === 'slot:head:display')
    expect(slotGroup?.isGroup).toBe(true)
    expect(slotGroup?.keyCount).toBe(2)
    expect(displayTrack?.keys).toHaveLength(2)
    expect(displayTrack?.channel).toBe('display')
    expect(displayTrack?.keys.map((key) => key.attachment)).toEqual(['head', 'head_hurt'])
    // 事件轨始终在最上面
    expect(tracks[0].kind).toBe('event')
  })

  it('事件轨道每个事件一个关键帧', () => {
    const tracks = buildTimeline(animationWithKeys())
    const events = tracks.find((track) => track.kind === 'event')
    expect(events?.keys[0].channel).toBe('hit')
  })

  it('空动画返回空轨道', () => {
    expect(buildTimeline(null)).toEqual([])
  })

  it('没打过帧的通道不占行：「显示」「可见性」只在有帧时出现', () => {
    const anim: AuthoringAnimData = {
      name: 'idle',
      duration: 2,
      bones: [],
      slots: [],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    }
    // 插槽只有颜色帧：没有「显示」帧 / 「可见性」帧，这两行都不该出现（否则就是删不掉的空行）
    anim.slots.push({
      slot: 'head',
      color: [{ time: 0, value: { r: 1, g: 1, b: 1, a: 1 }, easing: 1, curve: null }],
      displayIndex: [],
      displayAttachment: [],
      visible: []
    })

    const tracks = buildTimeline(anim)
    expect(tracks.some((track) => track.id === 'slot:head:color')).toBe(true)
    expect(tracks.some((track) => track.id === 'slot:head:display')).toBe(false)
    expect(tracks.some((track) => track.id === 'slot:head:visible')).toBe(false)
    // 分组行只在真有子轨时出现，且帧数与子轨一致
    expect(tracks.find((track) => track.id === 'slot:head')?.keyCount).toBe(1)
  })
})

describe('关键帧编辑', () => {
  const doc = () => {
    const d = createEmptyDocument('t')
    d.animations.push(animationWithKeys())
    return d
  }

  it('删除只影响选中的关键帧', () => {
    const d = doc()
    const removed = deleteKeys(d, 'idle', [selector({ time: 0 })])
    expect(removed).toBe(1)
    const track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([1])
  })

  it('删除整条轨道后清理空轨道', () => {
    const d = doc()
    deleteKeys(d, 'idle', [selector({ time: 0 }), selector({ time: 1 })])
    expect(d.animations[0].bones.find((t) => t.bone === 'root' && t.rotate.length > 0)).toBeUndefined()
  })

  it('拖动关键帧改时间并保持排序', () => {
    const d = doc()
    moveKeys(d, 'idle', [selector({ time: 1 })], -0.25)
    const track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([0, 0.75])
  })

  it('往前拖不会出现负时间', () => {
    const d = doc()
    moveKeys(d, 'idle', [selector({ time: 0 })], -5)
    const track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([0, 1])
  })

  it('往后拖超出时长会自动延长动画（时长只增不减，是可编辑范围）', () => {
    const d = doc()
    expect(d.animations[0].duration).toBe(2)
    moveKeys(d, 'idle', [selector({ time: 1 })], 1.5)
    const track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([0, 2.5])
    expect(d.animations[0].duration).toBe(2.5)

    // 末尾关键帧拖回来只改关键帧：时长保留（用户留着往后继续加帧的空间）
    moveKeys(d, 'idle', [selector({ time: 2.5 })], -0.5)
    expect(d.animations[0].duration).toBe(2.5)
  })

  it('指定通道时只打那一条（时间轴上选中「显示」行按 K 就只打显示帧）', () => {
    const d = createEmptyDocument('t')
    d.animations.push(animationWithKeys())
    const pose = {
      localRot: new Float32Array([30]),
      localPos: new Float32Array([0.5, 0.2]),
      localScale: new Float32Array([1, 1]),
      localShear: new Float32Array([0, 0]),
      slotColors: [{ r: 1, g: 0.5, b: 0.25, a: 1 }],
      slotDisplayIndex: new Int32Array([1]),
      slotVisible: new Uint8Array([1]),
      deformOffsets: [null],
      boneIndex: { root: 0 },
      slotIndex: { head: 0 }
    }

    const count = keyframeTargets(
      d,
      'idle',
      pose,
      [{ kind: 'slot', target: 'head', attachment: '', channel: 'display' }],
      0.25
    )
    expect(count).toBe(1)
    const slot = d.animations[0].slots.find((item) => item.slot === 'head')
    // 只新增了显示帧（原有 0 / 1 两帧），颜色与可见性都没被碰
    expect(slot?.displayIndex.map((k) => k.time)).toEqual([0, 0.25, 1])
    expect(slot?.displayIndex[1].value).toBe(1)
    expect(slot?.color.length ?? -1).toBe(0)
    expect(slot?.visible.length ?? -1).toBe(0)
    // 骨骼通道也没被打帧
    expect(d.animations[0].bones[0].rotate.map((k) => k.time)).toEqual([0, 1])
  })

  it('显示通道打帧会写入附件名（不是空串）：换皮肤 / 附件增删后仍能正确解析', () => {
    const d = createEmptyDocument('t')
    d.animations.push(animationWithKeys())
    const pose = {
      localRot: new Float32Array([0]),
      localPos: new Float32Array([0, 0]),
      localScale: new Float32Array([1, 1]),
      localShear: new Float32Array([0, 0]),
      slotColors: [{ r: 1, g: 1, b: 1, a: 1 }],
      slotDisplayIndex: new Int32Array([2]),
      slotDisplayNames: ['bgC'],
      slotVisible: new Uint8Array([1]),
      deformOffsets: [null],
      boneIndex: { root: 0 },
      slotIndex: { head: 0 }
    }

    keyframeTargets(
      d,
      'idle',
      pose,
      [{ kind: 'slot', target: 'head', attachment: '', channel: 'display' }],
      0.5
    )

    const slot = d.animations[0].slots.find((item) => item.slot === 'head')
    expect(slot?.displayIndex.map((k) => k.time)).toEqual([0, 0.5, 1])
    expect(slot?.displayIndex[1].value).toBe(2)
    // 名字与帧成对：0s → head、0.5s → bgC、1s → head_hurt
    expect(slot?.displayAttachment).toEqual(['head', 'bgC', 'head_hurt'])
  })

  it('lastKeyTime 取最晚关键帧（含事件帧），且只读不改时长', () => {
    const anim = animationWithKeys()
    // rotate 到 1s、translate 0、deform 0.5、事件 1 → 最晚是 1
    expect(lastKeyTime(anim)).toBe(1)
    expect(anim.duration).toBe(2)

    anim.events.push({ time: 2.5, name: 'late', stringParam: '', intParam: 0, floatParam: 0 })
    expect(lastKeyTime(anim)).toBe(2.5)
    // 只读：调用后时长保持原值，方便「提交时长时校验」自己决定怎么处理
    expect(anim.duration).toBe(2)
  })

  it('repairAnimationDurations 只补短：时长小于最后关键帧会裁帧才修，用户留长的编辑范围不动', () => {
    const d = createEmptyDocument('t')
    const broken: AuthoringAnimData = { ...animationWithKeys(), name: 'broken', duration: 0.3 }
    const padded: AuthoringAnimData = { ...animationWithKeys(), name: 'padded', duration: 4 }
    d.animations.push(broken, padded)

    expect(repairAnimationDurations(d)).toBe(1)
    // 最晚关键帧是 1s（rotate 到 1、事件 1）：太短的补到 1；留长的 4s 保留（编辑范围）
    expect(broken.duration).toBe(1)
    expect(padded.duration).toBe(4)
  })

  it('repairDisplayNames 补齐 displayIndex 帧与附件名的长度差', () => {
    const d = createEmptyDocument('t')
    const anim: AuthoringAnimData = {
      name: 'idle',
      duration: 2,
      bones: [],
      slots: [
        {
          slot: 'head',
          color: [],
          displayIndex: [
            { time: 0, value: 0, easing: Easing.Linear, curve: null },
            { time: 1, value: 1, easing: Easing.Linear, curve: null }
          ],
          // 坏数据：名字只有一个（老版本删除帧时漏删/错位）
          displayAttachment: ['head'],
          visible: []
        }
      ],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    }
    d.animations.push(anim)

    expect(repairDisplayNames(d)).toBe(1)
    expect(anim.slots[0].displayAttachment).toEqual(['head', ''])
  })

  // —— display 通道：帧与附件名（displayAttachment）必须成对维护，错位会导致播放时图丢失 ——
  const displaySelector = (time: number): KeySelector => ({
    kind: 'slot',
    target: 'head',
    attachment: '',
    channel: 'display',
    time
  })
  const namesOf = (d: ReturnType<typeof createEmptyDocument>): string[] =>
    d.animations[0].slots.find((item) => item.slot === 'head')?.displayAttachment ?? []
  const timesOf = (d: ReturnType<typeof createEmptyDocument>): number[] =>
    d.animations[0].slots.find((item) => item.slot === 'head')?.displayIndex.map((k) => k.time) ?? []
  const docWithDisplay = (): ReturnType<typeof createEmptyDocument> => {
    const d = createEmptyDocument('t')
    d.animations.push(animationWithKeys())
    return d
  }

  it('往已有帧**前面**补帧不会把名字挤错位', () => {
    const d = docWithDisplay()
    // 现有：0s → head、1s → head_hurt；再插一帧 0.5s → flash
    keySlotDisplay(d.animations[0], 'head', 0.5, 2, 'flash')

    expect(timesOf(d)).toEqual([0, 0.5, 1])
    expect(namesOf(d)).toEqual(['head', 'flash', 'head_hurt'])
  })

  it('删除中间帧后，剩下的帧名字仍然对得上', () => {
    const d = docWithDisplay()
    keySlotDisplay(d.animations[0], 'head', 0.5, 2, 'flash')
    expect(namesOf(d)).toEqual(['head', 'flash', 'head_hurt'])

    deleteKeys(d, 'idle', [displaySelector(0.5)])

    expect(timesOf(d)).toEqual([0, 1])
    expect(namesOf(d)).toEqual(['head', 'head_hurt'])
  })

  it('拖帧跨过另一帧后，名字跟着帧走（不会互换）', () => {
    const d = docWithDisplay()
    keySlotDisplay(d.animations[0], 'head', 0.5, 2, 'flash')
    // 把 0s 的帧拖到 1.5s（越过 0.5 与 1）
    setKeysTimes(d, 'idle', [{ selector: displaySelector(0), time: 1.5 }])

    expect(timesOf(d)).toEqual([0.5, 1, 1.5])
    // 名字顺序与帧顺序一致：0.5s → flash、1s → head_hurt、1.5s → head
    expect(namesOf(d)).toEqual(['flash', 'head_hurt', 'head'])

    // 再往后拖一格，确认依然成对
    moveKeys(d, 'idle', [displaySelector(1.5)], 0.5)
    expect(timesOf(d)).toEqual([0.5, 1, 2])
    expect(namesOf(d)).toEqual(['flash', 'head_hurt', 'head'])
  })

  it('setKeysTimes 按选择器时间定位：选择器时间失效时不会误改其它帧', () => {
    const d = doc()
    const keys = [selector({ time: 0 }), selector({ time: 1 })]
    setKeysTimes(d, 'idle', keys.map((k) => ({ selector: k, time: k.time + 0.5 })))
    let track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([0.5, 1.5])

    // 页面拖拽时会同步更新选择器时间；若沿用旧时间则定位不到，只会改到仍匹配的帧
    const stale = setKeysTimes(d, 'idle', [{ selector: selector({ time: 0 }), time: 0.25 }])
    expect(stale).toBe(0)
    track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate.map((k) => k.time)).toEqual([0.5, 1.5])

    // 选择器时间同步后才能继续移动
    const moved = setKeysTimes(d, 'idle', [{ selector: selector({ time: 1.5 }), time: 1.75 }])
    expect(moved).toBe(1)
  })

  it('事件帧可拖动 / 可删除（事件轨没有 easing 也要能定位）', () => {
    const d = doc()
    const eventSelector: KeySelector = {
      kind: 'event',
      target: 'hit',
      attachment: '',
      channel: 'hit',
      time: 1
    }
    // 拖动：1.0 → 1.4
    expect(setKeysTimes(d, 'idle', [{ selector: eventSelector, time: 1.4 }])).toBe(1)
    expect(d.animations[0].events.map((e) => e.time)).toEqual([1.4])

    // 再拖动一次（选择器时间同步后）
    expect(setKeysTimes(d, 'idle', [{ selector: { ...eventSelector, time: 1.4 }, time: 0.2 }])).toBe(1)
    expect(d.animations[0].events.map((e) => e.time)).toEqual([0.2])

    // 超出动画时长会自动延长
    expect(setKeysTimes(d, 'idle', [{ selector: { ...eventSelector, time: 0.2 }, time: 3.5 }])).toBe(1)
    expect(d.animations[0].duration).toBe(3.5)

    // 删除
    expect(deleteKeys(d, 'idle', [{ ...eventSelector, time: 3.5 }])).toBe(1)
    expect(d.animations[0].events).toHaveLength(0)
  })

  it('事件轨排在最上面', () => {
    const tracks = buildTimeline(animationWithKeys())
    expect(tracks[0].kind).toBe('event')
  })

  it('修改缓动：Bezier 写入 4 个控制量，其它类型清空 curve', () => {
    const d = doc()
    setKeyEasing(d, 'idle', [selector({ time: 1 })], Easing.Bezier, [0.1, 0.2, 0.3, 0.4])
    let track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate[1].easing).toBe(Easing.Bezier)
    expect(track?.rotate[1].curve).toEqual([0.1, 0.2, 0.3, 0.4])

    setKeyEasing(d, 'idle', [selector({ time: 1 })], Easing.Stepped, null)
    track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate[1].easing).toBe(Easing.Stepped)
    expect(track?.rotate[1].curve).toBeNull()
  })

  it('Bezier 未给控制量时使用默认值', () => {
    const d = doc()
    setKeyEasing(d, 'idle', [selector({ time: 0 })], Easing.Bezier, null)
    const track = d.animations[0].bones.find((t) => t.bone === 'root')
    expect(track?.rotate[0].curve).toEqual([0.25, 0.25, 0.75, 0.75])
  })
})

describe('打关键帧', () => {
  const docWithAnim = () => {
    const d = createEmptyDocument('t')
    d.animations.push({
      name: 'idle',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    })
    d.bones.push({
      name: 'root',
      parent: '',
      localPosition: { x: 0, y: 0 },
      rotation: 0,
      localScale: { x: 1, y: 1 },
      localShear: { x: 0, y: 0 },
      inheritRotation: true,
      inheritScale: true,
      length: 1,
      color: '#fff',
      locked: false
    })
    return d
  }

  const pose = {
    localRot: Float32Array.from([42]),
    localPos: Float32Array.from([0.5, 0.25]),
    localScale: Float32Array.from([1, 1]),
    localShear: Float32Array.from([0, 0]),
    slotColors: [{ r: 1, g: 0.5, b: 0.25, a: 1 }],
    slotDisplayIndex: Int32Array.from([1]),
    slotVisible: Uint8Array.from([1]),
    deformOffsets: [[0.1, 0.2]] as Array<number[] | null>,
    boneIndex: { root: 0 },
    slotIndex: { torso: 0 }
  }

  it('骨骼目标写入 4 条通道的当前姿态', () => {
    const d = docWithAnim()
    const count = keyframeTargets(d, 'idle', pose, [{ kind: 'bone', target: 'root', attachment: '' }], 0.3)
    expect(count).toBe(1)
    const track = d.animations[0].bones[0]
    expect(track.rotate[0].value).toBeCloseTo(42, 4)
    expect(track.translate[0].value).toEqual({ x: 0.5, y: 0.25 })
    expect(track.rotate[0].time).toBe(0.3)
  })

  it('插槽目标写入颜色关键帧', () => {
    const d = docWithAnim()
    keyframeTargets(d, 'idle', pose, [{ kind: 'slot', target: 'torso', attachment: '' }], 0)
    const color = d.animations[0].slots[0].color[0].value
    expect(color.r).toBe(1)
    expect(color.g).toBeCloseTo(0.5, 4)
  })

  /**
   * 视口左下角「属性打帧条」的**读法**：打完帧后用它那套 selector 形状去查必须命中。
   * 查不到的后果不是报错，而是「菱形一直是灰的、点一下也不变亮」—— 面板本身不会崩，
   * 所以只能用测试钉住「写进去的」和「读出来的」是同一帧。
   */
  it('面板的 selector 形状能查回刚打的帧（骨骼 4 通道 + 插槽颜色 / 显示）', () => {
    const d = docWithAnim()
    for (const channel of ['translate', 'rotate', 'scale', 'shear']) {
      const selector = { kind: 'bone' as const, target: 'root', attachment: '', channel, time: 0.5 }
      expect(findKeyframe(d.animations[0], selector)).toBeNull()
      keyframeTargets(d, 'idle', pose, [{ kind: 'bone', target: 'root', attachment: '', channel }], 0.5)
      expect(findKeyframe(d.animations[0], selector)).not.toBeNull()
    }
    // 时间戳是浮点累加出来的，面板靠 1e-4 容差命中（严格相等会漏）
    expect(
      findKeyframe(d.animations[0], {
        kind: 'bone',
        target: 'root',
        attachment: '',
        channel: 'rotate',
        time: 0.5 + 5e-5
      })
    ).not.toBeNull()

    for (const channel of ['color', 'display']) {
      keyframeTargets(d, 'idle', pose, [{ kind: 'slot', target: 'torso', attachment: '', channel }], 0.5)
      expect(
        findKeyframe(d.animations[0], { kind: 'slot', target: 'torso', attachment: '', channel, time: 0.5 })
      ).not.toBeNull()
    }
  })

  it('FFD 目标写入偏移数组；没有偏移时跳过', () => {
    const d = docWithAnim()
    const count = keyframeTargets(d, 'idle', pose, [{ kind: 'deform', target: 'torso', attachment: 'torso' }], 0.5)
    expect(count).toBe(1)
    expect(d.animations[0].deforms[0].frames[0].offsets).toEqual([0.1, 0.2])

    const emptyPose = { ...pose, deformOffsets: [null] }
    const d2 = docWithAnim()
    expect(keyframeTargets(d2, 'idle', emptyPose, [{ kind: 'deform', target: 'torso', attachment: 'torso' }], 0)).toBe(0)
  })

  it('目标不存在或动画缺失时返回 0', () => {
    const d = docWithAnim()
    expect(keyframeTargets(d, 'nope', pose, [{ kind: 'bone', target: 'root', attachment: '' }], 0)).toBe(0)
    expect(keyframeTargets(d, 'idle', pose, [{ kind: 'bone', target: 'ghost', attachment: '' }], 0)).toBe(0)
  })
})

describe('模式切换时的动画选择', () => {
  it('进 Animate：优先恢复上次离开时选中的动画', () => {
    expect(pickAnimationForAnimate(['idle', 'run'], 'run')).toBe('run')
  })

  it('记住的动画已被删除：退回第一个', () => {
    expect(pickAnimationForAnimate(['idle', 'run'], 'walk')).toBe('idle')
  })

  it('没记住时选第一个；工程里没有动画则保持未选择（null）', () => {
    expect(pickAnimationForAnimate(['idle', 'run'], null)).toBe('idle')
    expect(pickAnimationForAnimate([], 'idle')).toBeNull()
    expect(pickAnimationForAnimate([], null)).toBeNull()
  })
})

describe('通道选中与对象选择联动', () => {
  const channel = () => useTimelineStore.getState().selectedTrack

  beforeEach(() => {
    useTimelineStore.getState().setSelectedTrack(null)
    useSelectionStore.getState().clear()
  })

  it('选中骨骼 / 插槽（层级树、视口、插槽层级面板都走这两个入口）会清掉动画面板里选中的通道', () => {
    useTimelineStore
      .getState()
      .setSelectedTrack({ kind: 'bone', target: 'armL', attachment: '', channel: 'rotate' })
    useSelectionStore.getState().selectBone('armL')
    expect(channel()).toBeNull()

    useTimelineStore
      .getState()
      .setSelectedTrack({ kind: 'slot', target: 'head', attachment: '', channel: 'display' })
    useSelectionStore.getState().selectSlot('head')
    expect(channel()).toBeNull()
  })

  it('动画面板自己点轨道行不会被清掉：必须「先选对象、最后写通道」（TimelinePanel.selectTrack 的顺序）', () => {
    useSelectionStore.getState().selectBone('armL')
    useTimelineStore
      .getState()
      .setSelectedTrack({ kind: 'bone', target: 'armL', attachment: '', channel: 'rotate' })
    expect(channel()?.channel).toBe('rotate')
  })
})

describe('约束打关键帧（IK 的混合）', () => {
  function docWithIk(): EditorDocument {
    const doc = createEmptyDocument('t')
    doc.bones = [
      createAuthoringBone({ name: 'root', parent: '', localPosition: { x: 0, y: 0 }, length: 10 }),
      createAuthoringBone({ name: 'mid', parent: 'root', localPosition: { x: 10, y: 0 }, length: 10 }),
      createAuthoringBone({ name: 'target', parent: '', localPosition: { x: 10, y: 10 }, length: 0 })
    ]
    doc.constraints = [{ ...createIkConstraint(), name: 'leg', bones: ['root', 'mid'], target: 'target', mix: 0.4 }]
    doc.animations = [animationWithKeys()]
    return doc
  }

  /** 运行期当前状态：打帧要读它（画面上正在生效的 mix），不是工程文件里的静态参数 */
  function poseWithIkState(mix = 0.2): PoseSnapshot {
    return {
      localRot: Float32Array.from([0]),
      localPos: Float32Array.from([0, 0]),
      localScale: Float32Array.from([1, 1]),
      localShear: Float32Array.from([0, 0]),
      slotColors: [{ r: 1, g: 1, b: 1, a: 1 }],
      slotDisplayIndex: Int32Array.from([0]),
      slotVisible: Uint8Array.from([1]),
      deformOffsets: [null],
      boneIndex: { root: 0 },
      slotIndex: {},
      constraintStates: [{ ...defaultConstraintState(createIkConstraint({})), mix }],
      constraintIndex: { leg: 0 }
    }
  }

  it('IK 目标写入约束轨道，值取自运行期当前状态', () => {
    const doc = docWithIk()
    const count = keyframeTargets(doc, 'idle', poseWithIkState(0.2), [{ kind: 'constraint', target: 'leg', attachment: '' }], 0.3)
    expect(count).toBe(1)
    const track = doc.animations[0].constraints[0]
    expect(track.constraint).toBe('leg')
    expect(track.mix[0].value).toBeCloseTo(0.2, 4)
    expect(track.mix[0].time).toBe(0.3)
    // IK 只有 mix 一条通道：其余通道不该被顺手写进去
    expect(track.mixRotate).toEqual([])
  })

  it('指定通道时只打那一条；该约束没有的通道（给 IK 打 spacing）静默跳过', () => {
    const doc = docWithIk()
    expect(
      keyframeTargets(doc, 'idle', poseWithIkState(), [{ kind: 'constraint', target: 'leg', attachment: '', channel: 'mix' }], 0.5)
    ).toBe(1)
    expect(doc.animations[0].constraints[0].mix[0].time).toBe(0.5)

    const doc2 = docWithIk()
    expect(
      keyframeTargets(doc2, 'idle', poseWithIkState(), [{ kind: 'constraint', target: 'leg', attachment: '', channel: 'spacing' }], 0.5)
    ).toBe(0)
    // 不该留下一条打不了帧的空轨道
    expect(doc2.animations[0].constraints).toEqual([])
  })

  it('没有运行期状态 / 约束不存在 / 物理约束时都不打帧', () => {
    const doc = docWithIk()
    const noState = { ...poseWithIkState(), constraintStates: undefined, constraintIndex: undefined }
    expect(keyframeTargets(doc, 'idle', noState, [{ kind: 'constraint', target: 'leg', attachment: '' }], 0)).toBe(0)
    expect(keyframeTargets(doc, 'idle', poseWithIkState(), [{ kind: 'constraint', target: 'ghost', attachment: '' }], 0)).toBe(0)

    const physics = docWithIk()
    physics.constraints = [{ ...createPhysicsConstraint(), name: 'phys', bones: ['root'], target: '' }]
    expect(keyframeTargets(physics, 'idle', poseWithIkState(), [{ kind: 'constraint', target: 'phys', attachment: '' }], 0)).toBe(0)
  })
})
