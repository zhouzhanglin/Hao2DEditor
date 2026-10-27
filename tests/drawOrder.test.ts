import { describe, expect, it } from 'vitest'
import { compileDocument } from '@core/codec/compile'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { keyDrawOrder } from '@editor/commands/animationCommands'
import { deleteSlot } from '@editor/commands/authoringCommands'
import { buildTimeline, deleteKeys, type KeySelector } from '@editor/timeline/model'

/** 三个插槽的工程：a / b / c（zOrder 0/1/2，即绘制顺序 a → b → c） */
function docWithSlots(names: readonly string[] = ['a', 'b', 'c']): EditorDocument {
  const doc = createEmptyDocument('t')
  doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
  doc.slots = names.map((name, index) =>
    createAuthoringSlot({ name, bone: 'root', attachment: `${name}_art`, zOrder: index })
  )
  doc.skins = [
    {
      name: 'default',
      slots: names.map((name) => ({
        slot: name,
        attachments: [createAuthoringAttachment({ name: `${name}_art`, type: 'region', image: `${name}.png` })].map(
          (attachment) => ({ ...attachment, size: { x: 1, y: 1 } })
        )
      }))
    }
  ]
  doc.images = names.map<AuthoringImage>((name) => ({
    name: `${name}.png`,
    path: `/art/${name}.png`,
    width: 64,
    height: 64,
    loose: true
  }))
  doc.animations = [createAuthoringAnim('idle')]
  return doc
}

/** 编译后某时刻生效的绘制顺序（插槽名） */
function orderAt(doc: EditorDocument, time: number): string[] {
  const { asset } = compileDocument(doc)
  const frames = asset.animations[0].drawOrder
  let picked = frames[0]
  for (const frame of frames) if (frame.time <= time + 1e-6) picked = frame
  return picked.order.map((index) => asset.slots[index].name)
}

describe('绘制顺序帧归一化（防丢图）', () => {
  it('完整顺序原样保留', () => {
    const doc = docWithSlots()
    keyDrawOrder(doc.animations[0], 0, ['c', 'a', 'b'])
    const { asset } = compileDocument(doc)
    expect(asset.animations[0].drawOrder[0].order).toEqual([2, 0, 1])
    expect(asset.animations[0].drawOrder[0].order).toHaveLength(asset.slots.length)
  })

  it('缺项（例如打帧后删过插槽）会补成完整排列，而不是让数组变短', () => {
    const doc = docWithSlots()
    // 帧里只有两个名字：过去会被 filter 掉一个 → 数组变短 → 运行期只覆盖前 2 个槽
    doc.animations[0].drawOrder = [{ time: 0, order: ['b', 'a'] }]
    const { asset } = compileDocument(doc)
    const order = asset.animations[0].drawOrder[0].order
    expect(order).toHaveLength(asset.slots.length)
    expect(new Set(order).size).toBe(asset.slots.length)
    // 帧里写明的顺序优先，缺失的补到末尾
    expect(order.slice(0, 2)).toEqual([1, 0])
  })

  it('重复的名字只保留一次', () => {
    const doc = docWithSlots()
    doc.animations[0].drawOrder = [{ time: 0, order: ['a', 'a', 'b'] }]
    const { asset } = compileDocument(doc)
    const order = asset.animations[0].drawOrder[0].order
    expect(order).toHaveLength(asset.slots.length)
    expect(new Set(order).size).toBe(asset.slots.length)
    expect(order[0]).toBe(0)
  })

  it('重名插槽也补成完整排列（用实际插槽数，而不是名字表大小）', () => {
    const doc = docWithSlots(['a', 'a', 'b'])
    doc.animations[0].drawOrder = [{ time: 0, order: ['a', 'b'] }]
    const { asset } = compileDocument(doc)
    const order = asset.animations[0].drawOrder[0].order
    expect(order).toHaveLength(asset.slots.length)
    expect(new Set(order).size).toBe(asset.slots.length)
  })

  it('解析不到的名字被忽略，其余补全', () => {
    const doc = docWithSlots()
    doc.animations[0].drawOrder = [{ time: 0, order: ['ghost', 'c', 'b'] }]
    const { asset } = compileDocument(doc)
    const order = asset.animations[0].drawOrder[0].order
    expect(order).toHaveLength(asset.slots.length)
    expect(order.slice(0, 2)).toEqual([2, 1])
  })
})

describe('删除插槽时清理动画引用', () => {
  it('绘制顺序帧里的名字会被摘掉（缺项由编译期补全）', () => {
    const doc = docWithSlots()
    keyDrawOrder(doc.animations[0], 0, ['a', 'b', 'c'])
    expect(deleteSlot(doc, 'b')).toBe(true)
    expect(doc.animations[0].drawOrder[0].order).toEqual(['a', 'c'])
    // 编译后仍是完整排列（a → c 的既有顺序优先，b 不存在了）
    expect(orderAt(doc, 0)).toEqual(['a', 'c'])
  })

  it('顺带清掉该插槽的动画轨道', () => {
    const doc = docWithSlots()
    doc.animations[0].slots.push({
      slot: 'b',
      color: [],
      displayIndex: [],
      displayAttachment: [],
      visible: [],
      subArmature: []
    })
    deleteSlot(doc, 'b')
    expect(doc.animations[0].slots).toHaveLength(0)
  })
})

describe('时间轴里的「插槽层级」轨道', () => {
  it('有绘制顺序帧时才产出轨道，关键帧带时间与顺序通道', () => {
    const doc = docWithSlots()
    expect(buildTimeline(doc.animations[0]).some((track) => track.kind === 'drawOrder')).toBe(false)

    keyDrawOrder(doc.animations[0], 0, ['c', 'b', 'a'])
    keyDrawOrder(doc.animations[0], 1, ['a', 'b', 'c'])
    const track = buildTimeline(doc.animations[0]).find((item) => item.kind === 'drawOrder')
    expect(track).toBeDefined()
    expect(track?.label).toBe('插槽层级')
    expect(track?.keys.map((key) => key.time)).toEqual([0, 1])
    expect(track?.keys[0].channel).toBe('order')
  })

  it('删除选中帧能真正删掉绘制顺序帧（过去这一步无效）', () => {
    const doc = docWithSlots()
    keyDrawOrder(doc.animations[0], 0, ['c', 'b', 'a'])
    keyDrawOrder(doc.animations[0], 1, ['a', 'b', 'c'])
    const track = buildTimeline(doc.animations[0]).find((item) => item.kind === 'drawOrder')!
    const selectors: KeySelector[] = track.keys.map((key) => ({
      kind: key.kind,
      target: key.target,
      attachment: key.attachment,
      channel: key.channel,
      time: key.time
    }))

    const removed = deleteKeys(doc, 'idle', selectors)
    expect(removed).toBe(2)
    expect(doc.animations[0].drawOrder).toHaveLength(0)
    // 删空后时间轴上不再有这条轨道
    expect(buildTimeline(doc.animations[0]).some((item) => item.kind === 'drawOrder')).toBe(false)
  })

  it('只删一帧时其它帧仍生效（顺序继续由剩下的帧驱动）', () => {
    const doc = docWithSlots()
    keyDrawOrder(doc.animations[0], 0, ['c', 'b', 'a'])
    keyDrawOrder(doc.animations[0], 1, ['a', 'b', 'c'])
    const removed = deleteKeys(doc, 'idle', [
      { kind: 'drawOrder', target: '', attachment: '', channel: 'order', time: 1 }
    ])
    expect(removed).toBe(1)
    expect(doc.animations[0].drawOrder).toHaveLength(1)
    expect(orderAt(doc, 1)).toEqual(['c', 'b', 'a'])
  })
})

describe('未知 channel 不再误删显示帧', () => {
  it('slot 的 order 选择器不会落到 displayIndex 上', () => {
    const doc = docWithSlots()
    const slotTrack = doc.animations[0].slots
    slotTrack.push({ slot: 'a', color: [], displayIndex: [], displayAttachment: [], visible: [], subArmature: [] })
    const track = doc.animations[0].slots.find((item) => item.slot === 'a')!
    track.displayIndex.push({ time: 0.5, value: 0, easing: 1, curve: null })
    track.displayAttachment.push('a_art')

    // 形状像绘制顺序的 selector（kind=slot, channel=order）不应命中显示帧
    const removed = deleteKeys(doc, 'idle', [
      { kind: 'slot', target: 'a', attachment: '', channel: 'order', time: 0.5 }
    ])
    expect(removed).toBe(0)
    expect(doc.animations[0].slots.find((item) => item.slot === 'a')?.displayIndex).toHaveLength(1)
  })
})
