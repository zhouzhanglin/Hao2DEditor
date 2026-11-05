import { describe, expect, it } from 'vitest'
import { compileDocument } from '@core/codec/compile'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import { AttachmentType } from '@core/model/types'
import { createSampleDocument } from '@core/sample'
import { TextureStore } from '@render/material'
import { PixiHao2dView } from '../src/main/preview/hao2dRuntime'

/**
 * pixi 版运行库也要实现 `IHao2DView.cs` 那套方法（换装 / 显隐 / 显示下标 / 嵌套子骨架）。
 * 与 three 版共用 `hao2dViewCore.ts`，这里在 node 里直接构造视图（不创建 WebGLRenderer），
 * 锁住两边的行为一致。
 */
function sampleAsset(): RuntimeAsset {
  return compileDocument(createSampleDocument()).asset
}

function makeView(asset: RuntimeAsset, nestedAssets = new Map<string, RuntimeAsset>()): PixiHao2dView {
  const skinName = asset.skins[0]?.name ?? ''
  const maps = buildRuntimeMaps(asset, skinName)
  const skeleton = new Skeleton(asset)
  skeleton.applyRuntimeMaps(maps)
  const player = new AnimationPlayer(asset, skeleton)
  const view = new PixiHao2dView({
    asset,
    skeleton,
    player,
    maps,
    textures: new TextureStore(),
    nestedAssets,
    ppu: 1,
    skinName,
    isRoot: true
  })
  view.buildSetupPose()
  return view
}

describe('pixi 版运行库：IHao2DView 换装 / 显隐 / 显示下标', () => {
  it('按名字或下标查询插槽 / 附件，换装后状态可读回', () => {
    const asset = sampleAsset()
    const slot = asset.skins[0].slots[0]
    const extraName = 'extra-attachment'
    slot.attachments.push({ ...slot.attachments[0], name: extraName })
    const view = makeView(asset)
    try {
      const si = view.findSlotIndex(slot.slotName)
      expect(si).toBeGreaterThanOrEqual(0)
      expect(view.findSlotIndex('不存在的插槽')).toBe(-1)
      expect(view.slotNames).toContain(slot.slotName)
      expect(view.attachmentNames(si)).toContain(extraName)
      const extraIndex = view.findAttachmentIndex(si, extraName)
      expect(extraIndex).toBeGreaterThanOrEqual(0)

      expect(view.setSlotAttachment(slot.slotName, extraName)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      expect(view.setSlotAttachment(si, extraIndex)).toBe(true)
      expect(view.setSlotAttachment(si, '不存在的附件')).toBe(false)
      expect(view.setSlotAttachment(9999, extraName)).toBe(false)

      expect(view.setSlotVisible(slot.slotName, false)).toBe(true)
      expect(view.skeleton.slotVisible[si]).toBe(0)
      expect(view.setSlotVisible(si, true)).toBe(true)
      expect(view.skeleton.slotVisible[si]).toBe(1)

      expect(view.setSlotDisplayIndex(si, -1, true)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(-1)
      expect(view.setSlotDisplayIndex(si, extraIndex, true)).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      expect(view.setSlotDisplayIndex('不存在的插槽', 0)).toBe(false)

      // 换肤后按名字重放换装
      expect(view.setSkin('')).toBe(true)
      expect(view.getSlotDisplayIndex(si)).toBe(extraIndex)
      expect(view.setSkin('没有这个皮肤')).toBe(false)

      expect(view.clearSlotAttachmentOverride(si)).toBe(true)
      expect(view.clearSlotVisibleOverride(si)).toBe(true)
      expect(view.setSlotDisplayIndex(si, extraIndex, true)).toBe(true)
      expect(view.clearSlotDisplayOverride(si)).toBe(true)
      expect(view.clearSlotDisplayOverride(9999)).toBe(false)
    } finally {
      view.destroy()
    }
  })

  it('嵌套子骨架：GetNested / HasNested / nestedCount 与 SetNested* 可用', () => {
    const parent = sampleAsset()
    const child = sampleAsset()
    child.armatureName = 'child-armature'
    const skinSlot = parent.skins[0].slots[0]
    const armatureIndex = skinSlot.attachments.length
    skinSlot.attachments.push({
      ...skinSlot.attachments[0],
      name: 'nested',
      type: AttachmentType.Armature,
      subArmature: 'child-armature',
      subAnimation: '',
      subPlayTimes: 0,
      subOffset: 0,
      subSpeed: 1
    })

    const view = makeView(parent, new Map([['child-armature', child]]))
    try {
      expect(view.nestedCount).toBe(0)
      expect(view.hasNested(skinSlot.slotName)).toBe(false)
      expect(view.getNested(skinSlot.slotName)).toBeNull()

      expect(view.setSlotDisplayIndex(skinSlot.slotName, armatureIndex, true)).toBe(true)
      view.update(0)
      const nested = view.getNested(skinSlot.slotName)
      expect(nested).not.toBeNull()
      expect(view.hasNested(skinSlot.slotName)).toBe(true)
      expect(view.nestedCount).toBe(1)
      expect(nested!.slotNames.length).toBeGreaterThan(0)
      expect(nested!.skeleton.slotCount).toBeGreaterThan(0)

      expect(view.setNestedSlotVisible(skinSlot.slotName, nested!.slotNames[0], false)).toBe(true)
      expect(view.setNestedSlotDisplayIndex(skinSlot.slotName, 0, -1, true)).toBe(true)
      expect(view.setNestedSkin(skinSlot.slotName, '')).toBe(true)

      expect(view.setSlotVisible(skinSlot.slotName, false)).toBe(true)
      expect(view.getNested(skinSlot.slotName)).toBeNull()
    } finally {
      view.destroy()
    }
  })
})
