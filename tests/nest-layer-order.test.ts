import { describe, expect, it } from 'vitest'
import {
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { compileDocument } from '@core/codec/compile'
import { buildRuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { AnimationPlayer } from '@core/anim/player'
import { NestRuntime } from '@core/nesting/nestRuntime'
import type { NestSource } from '@core/nesting/nestRuntime'

/** 子骨架：一根骨骼 + 一个插槽，够 NestRuntime 建实例即可 */
function childDoc(): EditorDocument {
  const doc = createEmptyDocument('knife')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [createAuthoringSlot({ name: 'blade', bone: 'root' })]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'blade',
          attachments: [createAuthoringAttachment({ name: 'blade', type: 'region' })]
        }
      ]
    }
  ]
  return doc
}

/** 父骨架：两个**相邻**的 armature display（中间没有任何几何） */
function parentDoc(): EditorDocument {
  const doc = createEmptyDocument('hero')
  doc.bones = [createAuthoringBone({ name: 'root' })]
  doc.slots = [
    createAuthoringSlot({ name: 'a', bone: 'root', attachment: 'a_arm' }),
    createAuthoringSlot({ name: 'b', bone: 'root', attachment: 'b_arm' })
  ]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'a',
          attachments: [createAuthoringAttachment({ name: 'a_arm', type: 'armature', subArmature: 'knife' })]
        },
        {
          slot: 'b',
          attachments: [createAuthoringAttachment({ name: 'b_arm', type: 'armature', subArmature: 'knife' })]
        }
      ]
    }
  ]
  return doc
}

describe('多个子骨架 + slot 层级变化', () => {
  const parent = compileDocument(parentDoc()).asset
  const child = compileDocument(childDoc()).asset
  const resolver = (name: string): NestSource | null =>
    name === 'knife' ? { asset: child, skinName: '' } : null

  function state(order: number[]): {
    anchors: ReturnType<MeshBuilder['build']>['nestAnchors']
    instances: ReturnType<NestRuntime['update']>
  } {
    const skeleton = new Skeleton(parent)
    skeleton.applyRuntimeMaps(buildRuntimeMaps(parent, ''))
    skeleton.drawOrder.set(order)
    skeleton.updateFk()
    const builder = new MeshBuilder(parent, '')
    const result = builder.build(skeleton)
    const nest = new NestRuntime(resolver, '')
    const instances = nest.update(parent, skeleton, new AnimationPlayer(parent, skeleton), result.nestAnchors)
    return { anchors: result.nestAnchors, instances }
  }

  it('相邻的两个嵌套 display 层号相同，但各自带绘制顺序 order', () => {
    const { anchors } = state([0, 1])
    expect(anchors.map((a) => a.slotIndex)).toEqual([0, 1])
    expect(anchors[0].layer).toBe(anchors[1].layer)
    expect(anchors.map((a) => a.order)).toEqual([0, 1])
  })

  it('drawOrder 交换后 order 跟着交换（否则同层会按创建顺序画反）', () => {
    const { anchors } = state([1, 0])
    expect(anchors.map((a) => a.slotIndex)).toEqual([1, 0])
    expect(anchors.map((a) => a.order)).toEqual([0, 1])
    // 层号仍相同：只靠 layer 排不出先后，必须用 order
    expect(anchors[0].layer).toBe(anchors[1].layer)
  })

  it('NestRuntime 把 order 带给子骨架实例', () => {
    const { instances } = state([1, 0])
    const bySlot = new Map(instances.map((instance) => [instance.slotIndex, instance]))
    expect(bySlot.get(1)!.order).toBe(0) // 先画 b
    expect(bySlot.get(0)!.order).toBe(1) // 后画 a
  })

  it('中间插入几何后，后一个嵌套落到下一层', () => {
    const doc = parentDoc()
    // 在 a、b 之间插一个 region 插槽
    doc.slots.splice(1, 0, createAuthoringSlot({ name: 'mid', bone: 'root', attachment: 'mid_img' }))
    doc.skins[0].slots.splice(1, 0, {
      slot: 'mid',
      attachments: [createAuthoringAttachment({ name: 'mid_img', type: 'region' })]
    })
    const asset = compileDocument(doc).asset
    const skeleton = new Skeleton(asset)
    skeleton.applyRuntimeMaps(buildRuntimeMaps(asset, ''))
    skeleton.drawOrder.set([0, 1, 2]) // a(0) → mid(1) → b(2)
    skeleton.updateFk()
    const builder = new MeshBuilder(asset, '')
    const anchors = builder.build(skeleton).nestAnchors
    expect(anchors.map((a) => a.slotIndex)).toEqual([0, 2])
    expect(anchors[1].layer).toBe(anchors[0].layer + 1)
  })
})
