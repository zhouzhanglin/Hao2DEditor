import { describe, expect, it } from 'vitest'
import { createSampleDocument } from '@core/sample'
import { buildRuntime } from '@editor/runtime'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { compileDocument } from '@core/codec/compile'

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
