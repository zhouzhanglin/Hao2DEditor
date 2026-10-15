import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthoringAnim, createEmptyDocument } from '@core/model/authoring'
import { BlendMode } from '@core/model/types'
import { useProjectStore } from '@editor/store/projectStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import {
  highlightSlotColorKey,
  slotColorHexAt,
  slotColorMessage,
  slotColorTarget,
  writeSlotColor
} from '@editor/slotColorOps'

/** 一个插槽（颜色白）+ 一个 1 秒的空动画「idle」 */
function makeDoc(): void {
  const doc = createEmptyDocument('t')
  doc.slots.push({
    name: 'torso',
    bone: 'root',
    color: '#FFFFFFFF',
    blendMode: BlendMode.Normal,
    zOrder: 0,
    z: 0,
    attachment: 'body',
    visible: true,
    locked: false
  })
  doc.animations.push(createAuthoringAnim('idle', 1))
  useProjectStore.getState().setDocument(doc, null, false)
}

const currentDoc = (): ReturnType<typeof useProjectStore.getState>['document'] => useProjectStore.getState().document

/** 视口右键「修改颜色」写的就是这个 setup 颜色 */
const setupColor = (): string => currentDoc().slots[0].color

describe('视口「修改颜色」：插槽颜色 + 透明度', () => {
  beforeEach(() => {
    makeDoc()
    useModeStore.getState().setMode('pose')
    useTimelineStore.getState().setAnimation(null)
    useTimelineStore.getState().setTime(0)
  })

  it('Pose：写 setup 颜色，并规范成八位大写十六进制', () => {
    const target = slotColorTarget()
    expect(target.animate).toBe(false)

    const message = writeSlotColor('torso', '#ff800080', target)

    expect(setupColor()).toBe('#FF800080')
    expect(message).toContain('setup')
    expect(message).toContain('torso')
    // 没打帧：动画里不该多出插槽轨道
    expect(currentDoc().animations[0].slots).toHaveLength(0)
  })

  it('Animate：在当前时间打颜色关键帧（透明度一起进帧），setup 颜色不动', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0.5)

    const target = slotColorTarget()
    expect(target.animate).toBe(true)

    const message = writeSlotColor('torso', '#3388FF80', target)

    const track = currentDoc().animations[0].slots[0]
    expect(track.slot).toBe('torso')
    expect(track.color).toHaveLength(1)
    expect(track.color[0].time).toBeCloseTo(0.5)
    expect(track.color[0].value.r).toBeCloseTo(0x33 / 255)
    expect(track.color[0].value.a).toBeCloseTo(0x80 / 255)
    expect(setupColor()).toBe('#FFFFFFFF')
    expect(message).toContain('关键帧')
    expect(message).toContain('0.500s')
  })

  it('Animate 但没选动画：退回 setup 颜色（没地方打帧）', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation(null)

    const target = slotColorTarget()
    expect(target.animate).toBe(false)

    writeSlotColor('torso', '#000000FF', target)
    expect(setupColor()).toBe('#000000FF')
    expect(currentDoc().animations[0].slots).toHaveLength(0)
  })

  it('帧打在时长之外：动画时长跟着补上（末尾帧不会被裁）', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(1.5)

    writeSlotColor('torso', '#FFFFFF00', slotColorTarget())

    expect(currentDoc().animations[0].duration).toBeCloseTo(1.5)
  })

  it('同一时间重复写：覆盖那一帧，不会堆出一串帧', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0.25)

    writeSlotColor('torso', '#FF0000FF', slotColorTarget())
    writeSlotColor('torso', '#00FF00FF', slotColorTarget())

    const keys = currentDoc().animations[0].slots[0].color
    expect(keys).toHaveLength(1)
    expect(keys[0].value.g).toBeCloseTo(1)
  })

  it('拾色器初始值：Animate 有颜色轨 → 按当前时间采样（不是 setup 颜色）', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0)
    writeSlotColor('torso', '#FFFFFFFF', slotColorTarget())
    useTimelineStore.getState().setTime(1)
    writeSlotColor('torso', '#00000000', slotColorTarget())

    useTimelineStore.getState().setTime(0.5)

    expect(slotColorHexAt(currentDoc(), slotColorTarget(), 'torso')).toBe('#80808080')
    expect(setupColor()).toBe('#FFFFFFFF')
  })

  it('拾色器初始值：颜色轨还没有生效帧 → 用 setup 颜色兜底；Pose 态同理', () => {
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0.8)
    writeSlotColor('torso', '#11223344', slotColorTarget())

    // 播放头在第一帧之前：轨道里没有 time <= t 的帧，运行期也用 setup 颜色
    useTimelineStore.getState().setTime(0.2)
    expect(slotColorHexAt(currentDoc(), slotColorTarget(), 'torso')).toBe('#FFFFFFFF')

    useModeStore.getState().setMode('pose')
    expect(slotColorHexAt(currentDoc(), slotColorTarget(), 'torso')).toBe('#FFFFFFFF')
  })

  it('拖动整段只留一条撤销记录：事务内多次写入合并成一条', () => {
    const store = useProjectStore.getState()
    store.beginTransaction('修改插槽颜色')
    writeSlotColor('torso', '#FF0000FF', slotColorTarget())
    writeSlotColor('torso', '#00FF00FF', slotColorTarget())
    writeSlotColor('torso', '#0000FFFF', slotColorTarget())
    useProjectStore.getState().endTransaction()

    expect(setupColor()).toBe('#0000FFFF')
    expect(useProjectStore.getState().undoLabel).toBe('修改插槽颜色')

    useProjectStore.getState().undo()
    // 一次撤销回到拖动之前，而不是退回拖动中间态
    expect(setupColor()).toBe('#FFFFFFFF')
    expect(useProjectStore.getState().canUndo).toBe(false)
  })

  it('插槽 / 动画不在时给明确提示，不静默失败', () => {
    expect(writeSlotColor('ghost', '#FFFFFFFF', slotColorTarget())).toContain('已不存在')

    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('walk')
    expect(writeSlotColor('torso', '#FFFFFFFF', slotColorTarget())).toContain('找不到动画')
  })

  it('状态栏文案：Pose 说 setup，Animate 说第几秒的关键帧', () => {
    expect(slotColorMessage('torso', slotColorTarget())).toContain('setup')

    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0.75)
    expect(slotColorMessage('torso', slotColorTarget())).toContain('0.750s')
  })
})

describe('打帧收尾的高亮：同一帧不重复滚 / 不重复闪', () => {
  beforeEach(() => {
    makeDoc()
    useModeStore.getState().setMode('animate')
    useTimelineStore.getState().setAnimation('idle')
    useTimelineStore.getState().setTime(0.5)
  })

  const keyedStamp = (): number | undefined => useTimelineStore.getState().lastKeyed?.stamp

  it('这一帧本来就选中了：不再重复选中、也不再通知高亮', () => {
    writeSlotColor('torso', '#FF0000FF', slotColorTarget())
    highlightSlotColorKey('torso', 0.5)
    const stamp = keyedStamp()
    expect(useTimelineStore.getState().selectedKeys).toHaveLength(1)
    expect(useTimelineStore.getState().selectedKeys[0].time).toBeCloseTo(0.5)

    // 再拖一次同一个拾色器（还是这一帧）：选中项与 lastKeyed 都不该动
    highlightSlotColorKey('torso', 0.5)
    expect(useTimelineStore.getState().selectedKeys).toHaveLength(1)
    expect(keyedStamp()).toBe(stamp)
  })

  it('换成另一条帧（同插槽另一个时间点）：照常选中 + 通知高亮', () => {
    highlightSlotColorKey('torso', 0.5)
    const stamp = keyedStamp()

    highlightSlotColorKey('torso', 1)
    expect(useTimelineStore.getState().selectedKeys[0].time).toBeCloseTo(1)
    expect(keyedStamp()).not.toBe(stamp)
  })

  it('选中的是别的帧（别的插槽 / 另一个时间点）：不认成「已选中」，照常切过去', () => {
    useTimelineStore
      .getState()
      .setSelectedKeys([{ kind: 'slot', target: 'head', attachment: '', channel: 'color', time: 0.5 }])

    highlightSlotColorKey('torso', 0.5)
    expect(useTimelineStore.getState().selectedKeys).toHaveLength(1)
    expect(useTimelineStore.getState().selectedKeys[0].target).toBe('torso')
  })
})
