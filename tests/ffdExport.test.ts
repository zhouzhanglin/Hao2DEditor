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
import { AttachmentType } from '@core/model/types'

/**
 * 一个「加权网格附件 + 骨内 FFD」的工程：骨骼带旋转与缩放，
 * 这样 bindpose 不是单位阵，换算是否等价才有意义。
 */
function docWithBoneSpaceFfd(options: { ffdInBoneSpace?: boolean; withFrames?: boolean } = {}): EditorDocument {
  const { ffdInBoneSpace = true, withFrames = true } = options
  const doc = createEmptyDocument('t')
  doc.bones = [
    createAuthoringBone({ name: 'root', length: 1 }),
    createAuthoringBone({ name: 'arm', parent: 'root', localPosition: { x: 1, y: 0.5 }, rotation: 40, localScale: { x: 1.7, y: 0.6 } })
  ]
  doc.slots = [createAuthoringSlot({ name: 'body', bone: 'arm', attachment: 'shield', zOrder: 0 })]
  const mesh = createAuthoringAttachment({ name: 'shield', type: 'mesh', image: 'shield.png', size: { x: 2, y: 2 } })
  mesh.vertices = [
    { x: -1, y: -1, weights: [{ bone: 'arm', weight: 1 }] },
    { x: 1, y: -1, weights: [{ bone: 'arm', weight: 1 }] },
    { x: 1, y: 1, weights: [{ bone: 'arm', weight: 1 }] },
    { x: -1, y: 1, weights: [{ bone: 'arm', weight: 1 }] }
  ]
  mesh.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
  mesh.triangles = [0, 1, 2, 0, 2, 3]
  mesh.edges = [0, 1, 2, 3]
  mesh.hull = 4
  mesh.ffdInBoneSpace = ffdInBoneSpace
  doc.skins = [{ name: 'default', slots: [{ slot: 'body', attachments: [mesh] }] }]
  doc.images = [{ name: 'shield.png', path: '/art/shield.png', width: 128, height: 128, loose: true } satisfies AuthoringImage]

  const anim = createAuthoringAnim('idle')
  if (withFrames) {
    anim.deforms = [
      {
        slot: 'body',
        attachment: 'shield',
        frames: [
          { time: 0, offsets: [0.3, -0.2, 0.1, 0.4, -0.5, 0.25, 0.15, -0.35], vertexOffset: 0, easing: 0, curve: null }
        ]
      }
    ]
  }
  doc.animations = [anim]
  return doc
}

/** 用某骨骼的 bindpose 线性部分把偏移变换一次（等价于运行期 `local += bindpose · ffd`） */
function applyBindpose(bindposes: Float32Array, bone: number, x: number, y: number): { x: number; y: number } {
  const o = bone * 16
  return {
    x: bindposes[o] * x + bindposes[o + 4] * y,
    y: bindposes[o + 1] * x + bindposes[o + 5] * y
  }
}

describe('骨内 FFD 导出归一化', () => {
  it('标记被清掉，且换算后「bindpose · 新偏移 = 原偏移」（编辑器表现不变）', () => {
    const doc = docWithBoneSpaceFfd()
    const original = [...doc.animations[0].deforms[0].frames[0].offsets]
    const { asset, boneIndex } = compileDocument(doc)

    const attachment = asset.skins[0].slots[0].attachments[0]
    expect(attachment.ffdInBoneSpace).toBe(false)

    const frame = asset.animations[0].deforms[0].frames[0]
    const bone = boneIndex['arm']
    expect(bone).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 4; i++) {
      const moved = applyBindpose(asset.bindposes, bone, frame.offsets[i * 2], frame.offsets[i * 2 + 1])
      // 换算后经 bindpose 变换 = 原来的骨内偏移：编辑器（显示空间支路）与 Unity 都会得到同样位移
      expect(moved.x).toBeCloseTo(original[i * 2], 5)
      expect(moved.y).toBeCloseTo(original[i * 2 + 1], 5)
    }
  })

  it('确实是「换算过」的：偏移数组被改写（否则等于没处理）', () => {
    const doc = docWithBoneSpaceFfd()
    const original = [...doc.animations[0].deforms[0].frames[0].offsets]
    const { asset } = compileDocument(doc)
    const now = asset.animations[0].deforms[0].frames[0].offsets
    const changed = now.some((value, index) => Math.abs(value - original[index]) > 1e-6)
    expect(changed).toBe(true)
  })

  it('编译不污染工程数据：连编两次结果一致，offsets 不会被反复换算', () => {
    const doc = docWithBoneSpaceFfd()
    const original = [...doc.animations[0].deforms[0].frames[0].offsets]

    const first = compileDocument(doc).asset.animations[0].deforms[0].frames[0].offsets.slice()
    const second = compileDocument(doc).asset.animations[0].deforms[0].frames[0].offsets.slice()

    // 若编译期直接改到工程数据上，第二次会再换算一次 —— 结果就不同了
    expect(second).toEqual(first)
    // 工程数据本身必须原样保留（撤销、重开、再导出都依赖它）
    expect(doc.animations[0].deforms[0].frames[0].offsets).toEqual(original)
    // 附件标记也不该被改到文档上（编译期改的是新建的运行时附件）
    expect(doc.skins[0].slots[0].attachments[0].ffdInBoneSpace).toBe(true)
  })

  it('本来就是显示空间的 FFD（ffdInBoneSpace = false）完全不动', () => {
    const doc = docWithBoneSpaceFfd({ ffdInBoneSpace: false })
    const original = [...doc.animations[0].deforms[0].frames[0].offsets]
    const { asset } = compileDocument(doc)
    expect(asset.animations[0].deforms[0].frames[0].offsets).toEqual(original)
    expect(asset.skins[0].slots[0].attachments[0].ffdInBoneSpace).toBe(false)
  })

  it('没有 FFD 轨道的附件：标记同样被清掉，且不产生多余告警', () => {
    const doc = docWithBoneSpaceFfd({ withFrames: false })
    const { asset, warnings } = compileDocument(doc)
    expect(asset.skins[0].slots[0].attachments[0].ffdInBoneSpace).toBe(false)
    expect(warnings.filter((text) => text.includes('bindpose 退化'))).toHaveLength(0)
  })

  it('顶点绑在带旋转缩放的骨骼上时，换算矩阵是可逆的（无退化告警）', () => {
    const doc = docWithBoneSpaceFfd()
    const { warnings } = compileDocument(doc)
    expect(warnings.filter((text) => text.includes('bindpose 退化'))).toHaveLength(0)
  })
})
