import { describe, expect, it } from 'vitest'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { convertRegionToMesh } from '@editor/commands/authoringCommands'
import { connectMeshVertices, rebuildMeshBoundary } from '@editor/tools/authoringTools'
import type { Vec2 } from '@core/math/matrix'

/** 造一个工程，并在 body/art 上转出一个 2×2 网格（9 顶点 / 8 三角形） */
function docWithMesh(): EditorDocument {
  const doc = createEmptyDocument('t')
  doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
  doc.slots = [createAuthoringSlot({ name: 'body', bone: 'root', attachment: 'art' })]
  doc.images = [{ name: 'a.png', path: '/art/a.png', width: 100, height: 100, loose: true }]
  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'body',
          attachments: [
            createAuthoringAttachment({ name: 'art', type: 'region', image: 'a.png', size: { x: 4, y: 4 } })
          ]
        }
      ]
    }
  ]
  const result = convertRegionToMesh(doc, 'body', 'art', 2)
  expect(result).toBeTruthy()
  return doc
}

function attachmentOf(doc: EditorDocument) {
  return doc.skins[0].slots[0].attachments[0]
}

describe('rebuildMeshBoundary（重绘网格边界）', () => {
  it('用一圈点整块重画：顶点数换成点的数量、重新三角化、清空权重与 FFD', () => {
    const doc = docWithMesh()
    // 转网格后顶点带宿主骨骼权重、有 regionSnapshot
    const before = attachmentOf(doc)
    expect(before.vertices.every((vertex) => vertex.weights.length > 0)).toBe(true)

    const square: Vec2[] = [
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 }
    ]
    const result = rebuildMeshBoundary(doc, 'body', 'art', square)
    expect(result).toBeTruthy()
    expect(result!.vertices).toBe(4)
    expect(result!.triangles).toBe(2)

    const after = attachmentOf(doc)
    expect(after.type).toBe('mesh')
    expect(after.vertices).toHaveLength(4)
    expect(after.hull).toBe(4)
    expect(after.edges).toHaveLength(8) // 8 = 4 顶点成对下标绕一圈
    // UV 按点的数量铺满（4 顶点 → 8 个 UV 分量）
    expect(after.uvs).toHaveLength(8)
    // 权重与绑定骨骼列表被清空（回到只跟插槽走的刚性状态）
    expect(after.vertices.every((vertex) => vertex.weights.length === 0)).toBe(true)
    expect(after.bones).toEqual([])
  })

  it('重绘会清掉该附件的 FFD 关键帧（顶点数变了，旧 offsets 会错位）', () => {
    const doc = docWithMesh()
    const animation = createAuthoringAnim('idle')
    animation.deforms = [{ slot: 'body', attachment: 'art', frames: [] }]
    doc.animations.push(animation)

    expect(rebuildMeshBoundary(doc, 'body', 'art', [
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 }
    ])).toBeTruthy()

    expect(doc.animations[0].deforms.some((track) => track.slot === 'body' && track.attachment === 'art')).toBe(false)
  })

  it('目标不是网格 / 点不足 3 个时返回 null 且不改动', () => {
    const doc = docWithMesh()
    // 先转回 Region，再调重绘 → 非网格应返回 null
    expect(rebuildMeshBoundary(doc, 'body', 'art', [
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 }
    ])).toBeTruthy() // 这里仍是网格，先成功一次
    // 再取一个 Region 附件
    const regionDoc = createEmptyDocument('r')
    regionDoc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
    regionDoc.slots = [createAuthoringSlot({ name: 'body', bone: 'root', attachment: 'art' })]
    regionDoc.skins = [
      {
        name: 'default',
        slots: [
          { slot: 'body', attachments: [createAuthoringAttachment({ name: 'art', type: 'region', image: 'a.png', size: { x: 4, y: 4 } })] }
        ]
      }
    ]
    expect(rebuildMeshBoundary(regionDoc, 'body', 'art', [
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 }
    ])).toBeNull()

    // 点不足 3 个
    expect(rebuildMeshBoundary(doc, 'body', 'art', [
      { x: -2, y: -2 },
      { x: 2, y: -2 }
    ])).toBeNull()
  })
})

describe('connectMeshVertices（自定义布线）', () => {
  it('在网格的两个对角顶点间连线：顶点数不变、那条线成为真实三角边', () => {
    const doc = docWithMesh()
    const before = attachmentOf(doc)
    expect(before.vertices).toHaveLength(9)
    const triangleCount = before.triangles.length

    // 2×2 网格（9 顶点，角点角标差 (2,1)，gcd=1 → 线段不擦过任何中间顶点）：
    // 顶点 0（角点）连到顶点 5（右边缘中点）会斜穿网格内部，可成功布线
    const ok = connectMeshVertices(doc, 'body', 'art', 0, 5)
    expect(ok).toBe(true)

    const after = attachmentOf(doc)
    // 只重排通道上的三角形，顶点数与总三角形数都不变
    expect(after.vertices).toHaveLength(9)
    expect(after.triangles.length).toBe(triangleCount)
    // 0 与 5 之间生成了一条真实的三角边：至少有一个三角形同时包含这俩顶点
    let sharesEdge = false
    for (let t = 0; t + 2 < after.triangles.length; t += 3) {
      const corners = [after.triangles[t], after.triangles[t + 1], after.triangles[t + 2]]
      if (corners.includes(0) && corners.includes(5)) {
        sharesEdge = true
        break
      }
    }
    expect(sharesEdge).toBe(true)
  })

  it('同一点 / 非网格 / 越界下标连不上，返回 false 且不改动', () => {
    const doc = docWithMesh()
    const before = attachmentOf(doc)
    // 同一点
    expect(connectMeshVertices(doc, 'body', 'art', 3, 3)).toBe(false)
    // 越界下标
    expect(connectMeshVertices(doc, 'body', 'art', 0, 99)).toBe(false)
    // 文档没动
    expect(attachmentOf(doc)).toBe(before)

    // 非网格附件
    const regionDoc = createEmptyDocument('r')
    regionDoc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
    regionDoc.slots = [createAuthoringSlot({ name: 'body', bone: 'root', attachment: 'art' })]
    regionDoc.skins = [
      {
        name: 'default',
        slots: [
          { slot: 'body', attachments: [createAuthoringAttachment({ name: 'art', type: 'region', image: 'a.png', size: { x: 4, y: 4 } })] }
        ]
      }
    ]
    expect(connectMeshVertices(regionDoc, 'body', 'art', 0, 1)).toBe(false)
  })
})
