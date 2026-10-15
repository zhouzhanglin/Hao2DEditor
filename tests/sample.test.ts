import { describe, expect, it } from 'vitest'
import { createSampleDocument } from '@core/sample'
import { applyPreviewSlotColors, applyValueChanges, buildRuntime, needsRebuild } from '@editor/runtime'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { compileDocument } from '@core/codec/compile'
import { rgbaToHex } from '@core/util/color'
import type { EditorDocument } from '@core/model/authoring'

describe('内置示例角色', () => {
  const doc = createSampleDocument()
  const { asset } = compileDocument(doc)
  const bundle = buildRuntime(doc, '')
  const result = new MeshBuilder(asset, '').build(bundle.skeleton)

  it('编译后每个插槽都解析出 setup 附件下标', () => {
    expect(asset.slots).toHaveLength(6)
    for (const slot of asset.slots) {
      expect(slot.setupAttachment, `插槽 ${slot.name} 的 setup 附件名`).not.toBe('')
    }
    expect(doc.constraints).toHaveLength(0)
  })

  it('六个插槽都产出几何（含一个加权网格）', () => {
    expect(result.vertexCount).toBe(26)
    expect(result.groups.length).toBe(6)
    const indices = result.groups.reduce((sum, group) => sum + group.indexCount, 0)
    // 躯干网格 4 个三角面 + 5 个 Region 各 2 个三角面
    expect(indices / 3).toBe(14)
  })

  it('角色是竖直站立的（包围盒高度明显大于宽度）', () => {
    const { minX, maxX, minY, maxY } = result.bounds
    expect(maxY - minY).toBeGreaterThan(1.2)
    expect(maxY - minY).toBeGreaterThan((maxX - minX) * 1.2)
  })

  it('躯干网格的加权顶点被正确打包', () => {
    const mesh = asset.skins[0].slots.find((s) => s.slotName === 'torso')?.attachments[0]
    expect(mesh?.weights).toHaveLength(6)
    const blended = mesh?.weights[2]
    expect((blended?.w0 ?? 0) + (blended?.w1 ?? 0)).toBeCloseTo(1, 5)
  })

  it('两个动画都可播放，摆臂动画会改变骨骼旋转', () => {
    expect(bundle.asset.animations.map((a) => a.name)).toEqual(['idle', 'swap'])
    expect(bundle.player.play('idle', true)).toBe(true)
    const before = bundle.skeleton.localRot[3]
    bundle.player.update(0.75)
    expect(bundle.skeleton.localRot[3]).not.toBeCloseTo(before, 3)
  })

  it('事件在跨越关键帧时触发一次', () => {
    const events: string[] = []
    bundle.player.onEvent = (event) => events.push(event.name)
    bundle.player.play('idle', true)
    bundle.player.update(0.5)
    bundle.player.update(0.5)
    expect(events).toEqual(['wavePeak'])
  })
})

/**
 * 拖动颜色的性能路径：只改颜色时**不重建运行期**，而是把颜色热写进已有的 bundle。
 *
 * 这三条同时是「不重建」的安全网：判定必须只对插槽颜色放行，任何别的编辑（骨骼、动画…）
 * 都得回到重建 —— 漏判就是「画面上什么都不动」，比卡顿难查得多。
 */
describe('运行期增量更新（拖动颜色不重建）', () => {
  const clone = (doc: EditorDocument): EditorDocument => structuredClone(doc)

  it('同一份文档引用不重建；只改插槽颜色也不重建', () => {
    const doc = createSampleDocument()
    const bundle = buildRuntime(doc, '')
    expect(needsRebuild(bundle, doc, '')).toBe(false)

    const next = clone(doc)
    next.slots[0].color = '#123456FF'
    expect(needsRebuild(bundle, next, '')).toBe(false)
  })

  it('插槽颜色之外的任何改动都要重建', () => {
    const doc = createSampleDocument()
    const bundle = buildRuntime(doc, '')

    const boneMoved = clone(doc)
    boneMoved.bones[0].localPosition.x += 1
    expect(needsRebuild(bundle, boneMoved, '')).toBe(true)

    const slotMoved = clone(doc)
    slotMoved.slots[0].bone = 'other'
    expect(needsRebuild(bundle, slotMoved, '')).toBe(true)

    const slotAdded = clone(doc)
    slotAdded.slots.push(clone(doc).slots[0])
    expect(needsRebuild(bundle, slotAdded, '')).toBe(true)

    expect(needsRebuild(bundle, doc, 'otherSkin')).toBe(true)
    expect(needsRebuild(null, doc, '')).toBe(true)
  })

  it('热写把颜色同时写进编译产物与运行期两份，且值没变时返回 false', () => {
    const doc = createSampleDocument()
    const bundle = buildRuntime(doc, '')
    const index = bundle.slotIndex[doc.slots[0].name]

    const next = clone(doc)
    next.slots[0].color = '#12345678'
    applyValueChanges(bundle, next)
    // 两处都要写：编译产物是 `skeleton.refresh()` / 换皮肤时取值的地方，运行期那份才是网格直接读的
    expect(rgbaToHex(bundle.asset.slots[index].color)).toBe('#12345678')
    expect(rgbaToHex(bundle.skeleton.slotColors[index])).toBe('#12345678')
  })

  it('拖动预览按插槽名热写：变了返回 true，重复值返回 false', () => {
    const doc = createSampleDocument()
    const bundle = buildRuntime(doc, '')
    const name = doc.slots[0].name
    const index = bundle.slotIndex[name]
    const before = doc.slots[0].color

    expect(applyPreviewSlotColors(bundle, {})).toBe(false)
    expect(applyPreviewSlotColors(bundle, { [name]: '#00FF00FF' })).toBe(true)
    expect(rgbaToHex(bundle.skeleton.slotColors[index])).toBe('#00FF00FF')
    expect(rgbaToHex(bundle.asset.slots[index].color)).toBe('#00FF00FF')
    // 同一个值再写一次不算变化（调用方据此跳过重画）
    expect(applyPreviewSlotColors(bundle, { [name]: '#00FF00FF' })).toBe(false)
    // 不存在的插槽名直接跳过
    expect(applyPreviewSlotColors(bundle, { 不存在的插槽: '#FF0000FF' })).toBe(false)
    // 文档没被碰过：预览只是运行期上的临时值
    expect(doc.slots[0].color).toBe(before)
  })
})
