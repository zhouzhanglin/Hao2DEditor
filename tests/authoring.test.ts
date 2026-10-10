import { beforeEach, describe, expect, it } from 'vitest'
import { baseBrushMode, brushModeFor, wrapDegrees } from '@editor/tools/authoringTools'
import { useSelectionStore } from '@editor/store/selectionStore'
import {
  createGridMesh,
  fitUvField,
  inCircle,
  isInteriorVertex,
  polygonUvs,
  refineAroundVertex,
  signedArea,
  triangulatePolygon
} from '@core/mesh/triangulate'
import { createEmptyDocument } from '@core/model/authoring'
import type { AuthoringAnimData } from '@core/model/authoring'
import { Easing } from '@core/model/animation'
import {
  addImageDisplay,
  addWeightBone,
  autoWeights,
  convertMeshToRegion,
  convertRegionToMesh,
  createRegionFromImage,
  deleteAttachment,
  deleteMeshVertex,
  findAttachment,
  resolveAttachment,
  insertMeshVertex,
  paintWeights,
  removeWeightBone,
  applyVertexWeight,
  setVertexWeight,
  toggleSlotDisplay,
  weightBonesOf
} from '@editor/commands/authoringCommands'
import { parseDocument, serializeDocument } from '@core/codec/projectJson'
import { compileDocument } from '@core/codec/compile'
import { buildRuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import {
  ensureBoneAnim,
  keyBoneChannel,
  keyDeform,
  pruneEmptyTracks,
  removeBoneKeyframe,
  removeDeformKeyframe
} from '@editor/commands/animationCommands'
import { applyRename, checkRename } from '@editor/commands/authoringCommands'
import { createAuthoringAttachment, createAuthoringSlot } from '@core/model/authoring'

describe('栅格网格', () => {
  it('顶点 / 三角面数量符合 (n+1)^2 与 2n^2', () => {
    const grid = createGridMesh({ x: 1, y: 1 }, 4)
    expect(grid.vertices).toHaveLength(25)
    expect(grid.triangles).toHaveLength(4 * 4 * 2 * 3)
    expect(grid.uvs).toHaveLength(50)
  })

  it('uv 的 v 轴以底部为 0（与 Runtime 约定一致）', () => {
    const grid = createGridMesh({ x: 1, y: 2 }, 2)
    // 行 0 在最下方
    expect(grid.vertices[0].y).toBeCloseTo(-1, 5)
    expect(grid.uvs[1]).toBeCloseTo(0, 5)
    // 最后一行在最上方
    const last = grid.vertices.length - 1
    expect(grid.vertices[last].y).toBeCloseTo(1, 5)
    expect(grid.uvs[last * 2 + 1]).toBeCloseTo(1, 5)
  })

  it('顶点以原点为中心（可直接替换 Region 四边形）', () => {
    const grid = createGridMesh({ x: 4, y: 2 }, 1)
    const xs = grid.vertices.map((v) => v.x)
    expect(Math.min(...xs)).toBeCloseTo(-2, 5)
    expect(Math.max(...xs)).toBeCloseTo(2, 5)
  })
})

describe('三角化', () => {
  it('凸四边形切成 2 个三角形', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 }
    ]
    expect(triangulatePolygon(square)).toHaveLength(6)
  })

  it('凹多边形（L 形）切成 n-2 个三角形且总面积一致', () => {
    const shape = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 }
    ]
    const triangles = triangulatePolygon(shape)
    expect(triangles).toHaveLength((shape.length - 2) * 3)
    expect(triangleAreaSum(shape, triangles)).toBeCloseTo(Math.abs(signedArea(shape)), 5)
  })

  it('顺时针输入也能正确三角化', () => {
    const cw = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 }
    ]
    const triangles = triangulatePolygon(cw)
    expect(triangles).toHaveLength(6)
    expect(triangleAreaSum(cw, triangles)).toBeCloseTo(1, 5)
  })

  it('顶点不足或退化时安全返回', () => {
    expect(triangulatePolygon([])).toEqual([])
    expect(triangulatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([])
  })

  it('多边形 UV 按包围盒映射且 v 以底部为 0', () => {
    const uvs = polygonUvs([{ x: -5, y: -5 }, { x: 5, y: 5 }], { x: 10, y: 10 })
    expect(uvs).toEqual([0, 0, 1, 1])
  })
})

describe('Region 转网格', () => {
  const setup = () => {
    const doc = createEmptyDocument('t')
    doc.bones.push({ ...requireBone('root'), name: 'root' })
    createRegionFromImage(doc, { image: 'body.png', bone: 'root', width: 200, height: 100 })
    return doc
  }

  it('用图片创建 Region 附件：尺寸按 PPU 折算', () => {
    const doc = setup()
    expect(doc.slots).toHaveLength(1)
    const attachment = findAttachment(doc, doc.slots[0].name, doc.slots[0].attachment)
    expect(attachment?.size.x).toBeCloseTo(2, 5)
    expect(attachment?.size.y).toBeCloseTo(1, 5)
    expect(attachment?.uvs).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
  })

  it('拖放落点写进附件位置，可以指定落到哪个皮肤', () => {
    const doc = createEmptyDocument('t')
    doc.bones.push({ ...requireBone('root'), name: 'root' })
    doc.skins.push({ name: 'skin1', slots: [] })

    const created = createRegionFromImage(doc, {
      image: 'body.png',
      bone: 'root',
      width: 200,
      height: 100,
      position: { x: 1.5, y: -2.25 },
      skin: 'skin1'
    })

    expect(created?.slot).toBe('body')
    const skinSlot = doc.skins.find((skin) => skin.name === 'skin1')?.slots.find((item) => item.slot === 'body')
    expect(skinSlot?.attachments[0].position).toEqual({ x: 1.5, y: -2.25 })
    // 指定皮肤后，default 里不该再留一份
    expect(doc.skins[0].slots).toHaveLength(0)
  })

  it('一个插槽可以挂多个 display，追加时切换显示到新加的那个', () => {
    const doc = setup()
    const slot = doc.slots[0]

    const added = addImageDisplay(doc, { image: 'head.png', slot: slot.name, width: 80, height: 80 })
    const skinSlot = doc.skins[0].slots.find((item) => item.slot === slot.name)

    expect(added?.attachment).toBe('head')
    expect(skinSlot?.attachments.map((item) => item.name)).toEqual(['body', 'head'])
    // 同时只显示一个：新加的 display 顶上
    expect(slot.attachment).toBe('head')

    // 重名自动加后缀，且仍然只多一个 display
    const again = addImageDisplay(doc, { image: 'head.png', slot: slot.name, width: 80, height: 80 })
    expect(again?.attachment).toBe('head_2')
    expect(slot.attachment).toBe('head_2')
    expect(skinSlot?.attachments).toHaveLength(3)
  })

  it('往不存在的插槽加 display 直接失败，不产生脏数据', () => {
    const doc = createEmptyDocument('t')
    expect(addImageDisplay(doc, { image: 'x.png', slot: 'nope', width: 10, height: 10 })).toBeNull()
    expect(doc.skins[0].slots).toHaveLength(0)
  })

  it('再点当前显示的 display 则隐藏（空串 = 一个都不显示），再点一次恢复', () => {
    const doc = setup()
    const slot = doc.slots[0]
    addImageDisplay(doc, { image: 'head.png', slot: slot.name, width: 80, height: 80 })
    expect(slot.attachment).toBe('head')

    // 点当前显示的 → 隐藏（插槽进入「都不显示」状态）
    expect(toggleSlotDisplay(doc, slot.name, 'head')).toBe(true)
    expect(slot.attachment).toBe('')
    // 再点一次同一个 → 又显示回来
    toggleSlotDisplay(doc, slot.name, 'head')
    expect(slot.attachment).toBe('head')
    // 点另一个 display → 是切换而不是隐藏
    toggleSlotDisplay(doc, slot.name, 'body')
    expect(slot.attachment).toBe('body')
  })

  it('切换不存在的插槽返回失败，不产生脏数据', () => {
    const doc = setup()
    expect(toggleSlotDisplay(doc, 'nope', 'body')).toBe(false)
  })

  it('隐藏后运行期 setup 显示项解析为「不显示」（displayIndex -1）', () => {
    const doc = setup()
    const slot = doc.slots[0]
    // 把当前显示的 display 再点一次 → 隐藏
    toggleSlotDisplay(doc, slot.name, slot.attachment)
    expect(slot.attachment).toBe('')

    const { asset } = compileDocument(doc)
    const index = asset.slots.findIndex((item) => item.name === slot.name)
    expect(asset.slots[index].setupAttachment).toBe('')
    const skeleton = new Skeleton(asset)
    skeleton.applyRuntimeMaps(buildRuntimeMaps(asset))
    // -1 是「不显示任何附件」的合法值（不是「退化成第一个附件」）
    expect(skeleton.setupDisplayIndex[index]).toBe(-1)
  })

  it('转网格后带权重与三角面，UV 保持在原 Region 矩形内', () => {
    const doc = setup()
    const slot = doc.slots[0]
    const result = convertRegionToMesh(doc, slot.name, slot.attachment, 3)
    expect(result).not.toBeNull()
    expect(result?.vertices).toBe(16)
    expect(result?.triangles).toBe(18)

    const attachment = findAttachment(doc, slot.name, slot.attachment)
    expect(attachment?.type).toBe('mesh')
    expect(attachment?.vertices.every((v) => v.weights.length === 1 && v.weights[0].bone === 'root')).toBe(true)
    for (const uv of attachment?.uvs ?? []) {
      expect(uv).toBeGreaterThanOrEqual(0)
      expect(uv).toBeLessThanOrEqual(1)
    }
  })

  it('删除附件会同时清掉 setup 附件名与 FFD 轨道', () => {
    const doc = setup()
    const slot = doc.slots[0]
    doc.animations.push({
      name: 'a',
      duration: 1,
      bones: [],
      slots: [],
      deforms: [{ slot: slot.name, attachment: slot.attachment, frames: [] }],
      drawOrder: [],
      events: [],
      constraints: []
    })
    deleteAttachment(doc, slot.name, slot.attachment)
    expect(findAttachment(doc, slot.name, slot.attachment)).toBeNull()
    expect(doc.slots[0].attachment).toBe('')
    expect(doc.animations[0].deforms).toHaveLength(0)
  })
})

describe('拖动内部顶点时的 UV 重算', () => {
  it('isInteriorVertex：中心点算内部，角点与边点不算', () => {
    const grid = createGridMesh({ x: 1, y: 1 }, 3)
    // 4×4 顶点，编号 = row * 4 + col，行 0 在底部
    expect(isInteriorVertex(grid.triangles, 5)).toBe(true)
    expect(isInteriorVertex(grid.triangles, 10)).toBe(true)
    expect(isInteriorVertex(grid.triangles, 0)).toBe(false) // 角点
    expect(isInteriorVertex(grid.triangles, 1)).toBe(false) // 底边
    expect(isInteriorVertex(grid.triangles, 4)).toBe(false) // 左边
  })

  it('fitUvField：用邻居样本拟合出原映射，任意位置都能还原应有的 UV', () => {
    const grid = createGridMesh({ x: 2, y: 1 }, 3)
    const centre = 5
    const neighbours = new Set<number>()
    for (let t = 0; t + 2 < grid.triangles.length; t += 3) {
      const triangle = [grid.triangles[t], grid.triangles[t + 1], grid.triangles[t + 2]]
      if (!triangle.includes(centre)) continue
      for (const index of triangle) if (index !== centre) neighbours.add(index)
    }
    const field = fitUvField(
      [...neighbours].map((index) => ({
        x: grid.vertices[index].x,
        y: grid.vertices[index].y,
        u: grid.uvs[index * 2],
        v: grid.uvs[index * 2 + 1]
      }))
    )!

    // 邻居自己的位置喂回去 → 得到它们自己的 UV（栅格映射是线性的，应精确吻合）
    for (const index of neighbours) {
      const uv = field(grid.vertices[index].x, grid.vertices[index].y)
      expect(uv.u).toBeCloseTo(grid.uvs[index * 2], 6)
      expect(uv.v).toBeCloseTo(grid.uvs[index * 2 + 1], 6)
    }
    // 中心点原位置亦然
    const centreUv = field(grid.vertices[centre].x, grid.vertices[centre].y)
    expect(centreUv.u).toBeCloseTo(grid.uvs[centre * 2], 6)
    expect(centreUv.v).toBeCloseTo(grid.uvs[centre * 2 + 1], 6)
    // 顶点被挪到右边后：UV 换成「原映射在该处应有的值」——u 变大，贴图不被拽出尖角
    const moved = field(grid.vertices[centre].x + 0.2, grid.vertices[centre].y)
    expect(moved.u).toBeGreaterThan(grid.uvs[centre * 2])
  })

  it('fitUvField：样本不足或共线（退化）时返回 null，调用方保持原 UV', () => {
    expect(fitUvField([])).toBeNull()
    expect(
      fitUvField([
        { x: 0, y: 0, u: 0, v: 0 },
        { x: 1, y: 0, u: 1, v: 0 }
      ])
    ).toBeNull()
    expect(
      fitUvField([
        { x: 0, y: 0, u: 0, v: 0 },
        { x: 1, y: 0, u: 1, v: 0 },
        { x: 2, y: 0, u: 2, v: 0 }
      ])
    ).toBeNull()
  })
})

describe('网格拓扑编辑与还原', () => {
  const setup = () => {
    const doc = createEmptyDocument('t')
    doc.bones.push({ ...requireBone('root'), name: 'root' })
    createRegionFromImage(doc, { image: 'body.png', bone: 'root', width: 200, height: 100 })
    const slot = doc.slots[0]
    convertRegionToMesh(doc, slot.name, slot.attachment, 2)
    return { doc, slot: slot.name, attachment: slot.attachment }
  }

  it('Region → Mesh → Region：尺寸与 UV 精确还原，顶点 / 三角面清空', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)
    expect(mesh?.type).toBe('mesh')
    // 转换时留下源 Region 快照
    expect(mesh?.regionSnapshot?.uvs).toEqual([0, 0, 1, 0, 1, 1, 0, 1])

    expect(deleteMeshVertex(doc, slot, attachment, 0)).toBe(true)
    expect(convertMeshToRegion(doc, slot, attachment)).toBe(true)

    const region = findAttachment(doc, slot, attachment)
    expect(region?.type).toBe('region')
    expect(region?.vertices).toHaveLength(0)
    expect(region?.triangles).toHaveLength(0)
    expect(region?.size.x).toBeCloseTo(2, 5)
    expect(region?.size.y).toBeCloseTo(1, 5)
    expect(region?.uvs).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
    expect(region?.regionSnapshot).toBeUndefined()

    // 已经不是网格了，再还原一次应当失败
    expect(convertMeshToRegion(doc, slot, attachment)).toBe(false)
  })

  it('插入顶点：三角形一分为三，UV 与权重按位置插值', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeVertices = mesh.vertices.length
    const beforeTriangles = mesh.triangles.length / 3

    const index = insertMeshVertex(doc, slot, attachment, { x: 0, y: 0 })
    expect(index).toBe(beforeVertices)
    expect(mesh.vertices).toHaveLength(beforeVertices + 1)
    expect(mesh.triangles.length / 3).toBe(beforeTriangles + 2)
    // 网格正中心：UV 应落在图片中间
    expect(mesh.uvs[index! * 2]).toBeCloseTo(0.5, 2)
    expect(mesh.uvs[index! * 2 + 1]).toBeCloseTo(0.5, 2)
    expect(mesh.vertices[index!].weights.map((weight) => weight.bone)).toEqual(['root'])

    // 网格之外插不进去
    expect(insertMeshVertex(doc, slot, attachment, { x: 99, y: 99 })).toBeNull()
  })

  it('插入顶点后做局部重连：贴近边插入不再留下细长三角形', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeTriangles = mesh.triangles.length / 3

    // 网格 2×2、尺寸 2×1（x ∈ [-1,1]、y ∈ [-0.5,0.5]）：
    // (-0.5,-0.45) 贴近底边、但离边 0.05 > 吸附容差（约 0.033）→ 走「三角形内部」分支
    const index = insertMeshVertex(doc, slot, attachment, { x: -0.5, y: -0.45 })
    expect(index).not.toBeNull()
    // 拆三份 + 翻转：数量仍是 +2（翻转只换对角线，不增删三角形）
    expect(mesh.triangles.length / 3).toBe(beforeTriangles + 2)

    // 只拆三份时新点只连 3 个邻居；局部翻转后连到 4 个（与 DragonBones 添加顶点一致）
    const neighbours = new Set<number>()
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      const tri = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]]
      if (tri.includes(index!)) for (const v of tri) if (v !== index) neighbours.add(v)
    }
    expect(neighbours.size).toBeGreaterThanOrEqual(4)

    // 拓扑合法：无退化三角形，绕向与插入前一致
    const orient = (t: number): number => {
      const a = mesh.vertices[mesh.triangles[t]]
      const b = mesh.vertices[mesh.triangles[t + 1]]
      const c = mesh.vertices[mesh.triangles[t + 2]]
      return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
    }
    const sign = Math.sign(orient(0))
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      expect(Math.abs(orient(t))).toBeGreaterThan(1e-9)
      expect(Math.sign(orient(t))).toBe(sign)
    }
  })

  it('局部翻转的几何判据：外接圆判定与绕向无关，翻转只换对角线', () => {
    // (0,0)(1,0)(0,1) 的外接圆：圆心 (0.5,0.5)、半径 √0.5 ≈ 0.707
    expect(inCircle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0.25, y: 0.25 })).toBe(true)
    expect(inCircle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: 3 })).toBe(false)
    // 三个点顺时针给出时，判据不变（行列式符号随绕向翻转，已抵消）
    expect(inCircle({ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0.25, y: 0.25 })).toBe(true)

    // 方形 + 贴底边的新点（按「拆三份」的星形三角化给出）
    const vertices = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0.5, y: 0.05 }
    ]
    const split = [0, 1, 4, 1, 2, 4, 2, 0, 4, 0, 2, 3]
    const neighbours = (triangles: readonly number[]): number => {
      const set = new Set<number>()
      for (let t = 0; t + 2 < triangles.length; t += 3) {
        const tri = [triangles[t], triangles[t + 1], triangles[t + 2]]
        if (tri.includes(4)) for (const v of tri) if (v !== 4) set.add(v)
      }
      return set.size
    }
    expect(neighbours(split)).toBe(3)

    const refined = refineAroundVertex(vertices, split, 4)

    expect(neighbours(refined)).toBe(4)
    expect(refined).toHaveLength(split.length)
  })

  it('点在已有网格线上：把那条边一分为二（相邻两个三角形各拆成两个）', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeVertices = mesh.vertices.length
    const beforeTriangles = mesh.triangles.length / 3
    const areaOf = (t: number): number => {
      const p = mesh.vertices[mesh.triangles[t]]
      const q = mesh.vertices[mesh.triangles[t + 1]]
      const r = mesh.vertices[mesh.triangles[t + 2]]
      return ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2
    }
    const sign = Math.sign(areaOf(0))

    // 内部边 (-1,0)-(0,0) 的中点：这条边被上下两个三角形共享
    const index = insertMeshVertex(doc, slot, attachment, { x: -0.5, y: 0 })

    expect(index).toBe(beforeVertices)
    expect(mesh.vertices).toHaveLength(beforeVertices + 1)
    // 两个三角形各一分为二 → 三角面 +2
    expect(mesh.triangles.length / 3).toBe(beforeTriangles + 2)
    // 新顶点精确落在边线上
    expect(mesh.vertices[index!].x).toBeCloseTo(-0.5, 5)
    expect(mesh.vertices[index!].y).toBeCloseTo(0, 5)
    // UV 按边上的比例插值（中点 = 两端平均）
    const vertexAt = (x: number, y: number): number =>
      mesh.vertices.findIndex((v) => Math.abs(v.x - x) < 1e-6 && Math.abs(v.y - y) < 1e-6)
    const iLeft = vertexAt(-1, 0)
    const iRight = vertexAt(0, 0)
    expect(mesh.uvs[index! * 2]).toBeCloseTo((mesh.uvs[iLeft * 2] + mesh.uvs[iRight * 2]) / 2, 5)
    expect(mesh.uvs[index! * 2 + 1]).toBeCloseTo((mesh.uvs[iLeft * 2 + 1] + mesh.uvs[iRight * 2 + 1]) / 2, 5)
    // 绕向不变：拆边不能把三角形拆翻面
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      expect(Math.sign(areaOf(t))).toBe(sign)
    }
  })

  it('点在凸包边上：只拆相邻的那一个三角形', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeTriangles = mesh.triangles.length / 3

    // 外边界边 (-1,-0.5)-(0,-0.5) 的中点：只属于一个三角形
    const index = insertMeshVertex(doc, slot, attachment, { x: -0.5, y: -0.5 })

    expect(index).not.toBeNull()
    expect(mesh.triangles.length / 3).toBe(beforeTriangles + 1)
    expect(mesh.vertices[index!].y).toBeCloseTo(-0.5, 5)
  })

  it('端点附近（点在已有顶点上）仍走三角形内部插点，不会被当成「线上」', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeTriangles = mesh.triangles.length / 3

    // (0,0) 正是 3x3 网格的中心顶点：距离最近边为 0 但处于端点 → 保持原行为（拆成 3 个）
    insertMeshVertex(doc, slot, attachment, { x: 0, y: 0 })
    expect(mesh.triangles.length / 3).toBe(beforeTriangles + 2)
  })

  it('删除顶点：顶点与相关三角面移除，用邻居重新三角化补洞且不留悬空下标', () => {
    const { doc, slot, attachment } = setup()
    const mesh = findAttachment(doc, slot, attachment)!
    const beforeVertices = mesh.vertices.length

    expect(deleteMeshVertex(doc, slot, attachment, 0)).toBe(true)
    expect(mesh.vertices).toHaveLength(beforeVertices - 1)
    expect(mesh.triangles.length % 3).toBe(0)
    expect(mesh.triangles.length).toBeGreaterThan(0)
    expect(Math.max(...mesh.triangles)).toBeLessThan(mesh.vertices.length)
    expect(mesh.uvs).toHaveLength(mesh.vertices.length * 2)
  })
})

describe('权重', () => {
  const samples = [
    { slot: 's', attachment: 'a', vertex: 0, x: 0, y: 0 },
    { slot: 's', attachment: 'a', vertex: 1, x: 10, y: 0 }
  ]

  const setup = () => {
    const doc = createEmptyDocument('w')
    doc.bones.push(requireBone('root'), requireBone('arm'))
    createRegionFromImage(doc, { image: 'x.png', bone: 'root', width: 100, height: 100, slotName: 's', attachmentName: 'a' })
    convertRegionToMesh(doc, 's', 'a', 1)
    return doc
  }

  it('刷权重后总权重仍为 1', () => {
    const doc = setup()
    // 两个样本都在半径内（画笔按样本传入的世界坐标判定距离）
    const touched = paintWeights(doc, samples, 'arm', { x: 0, y: 0 }, 20, 1, 'replace')
    expect(touched).toBe(2)
    const vertex = findAttachment(doc, 's', 'a')?.vertices[0]
    const total = vertex?.weights.reduce((sum, w) => sum + w.weight, 0) ?? 0
    expect(total).toBeCloseTo(1, 5)
    expect(vertex?.weights.find((w) => w.bone === 'arm')?.weight).toBeCloseTo(1, 5)
  })

  it('半径外顶点不受影响', () => {
    const doc = setup()
    const touched = paintWeights(doc, samples, 'arm', { x: 0, y: 0 }, 0.5, 1, 'add')
    expect(touched).toBe(1)
  })

  it('衰减：中心权重高于边缘', () => {
    const doc = setup()
    paintWeights(doc, samples, 'arm', { x: 5, y: 0 }, 12, 0.8, 'replace')
    const vertex = findAttachment(doc, 's', 'a')?.vertices[1]
    const weight = vertex?.weights.find((w) => w.bone === 'arm')?.weight ?? 0
    expect(weight).toBeGreaterThan(0.8 * 0.6)
    expect(weight).toBeLessThan(0.8)
  })

  it('subtract 可以把权重刷回 0 并归一化给其它骨骼', () => {
    const doc = setup()
    const vertex = findAttachment(doc, 's', 'a')?.vertices[0]
    applyVertexWeight(vertex!.weights, 'arm', 0.5)
    applyVertexWeight(vertex!.weights, 'arm', 0)
    expect(vertex?.weights.some((w) => w.bone === 'arm')).toBe(false)
    expect(vertex?.weights[0].weight).toBeCloseTo(1, 5)
  })

  it('单骨骼顶点：超过 1 停在 100%，减到 0 就保持 0（不会跳回 100%）', () => {
    const doc = setup()
    const vertex = findAttachment(doc, 's', 'a')!.vertices[0]
    // convertRegionToMesh 生成的顶点只绑宿主骨骼
    expect(vertex.weights).toEqual([{ bone: 'root', weight: 1 }])
    // 超过 1：夹在 100%，不会回绕成 0
    applyVertexWeight(vertex.weights, 'root', 1.5)
    expect(vertex.weights).toEqual([{ bone: 'root', weight: 1 }])
    // 减到 0：保持「空权重表」= 不受任何骨骼影响 —— 以前这里会被塞回 1（减到 0 又变 100%）
    applyVertexWeight(vertex.weights, 'root', 0)
    expect(vertex.weights).toEqual([])
  })

  it('grow（Unity 的 Grow and Shrink）：不会给还没受该骨骼影响的顶点新增权重', () => {
    const doc = setup()
    const vertex = findAttachment(doc, 's', 'a')!.vertices[0]
    expect(vertex.weights.some((w) => w.bone === 'arm')).toBe(false)

    // 普通 add 会把这根骨骼"引进"这个顶点（Unity 的 Add and Subtract）
    expect(paintWeights(doc, [samples[0]], 'arm', { x: 0, y: 0 }, 20, 0.5, 'add')).toBe(1)
    expect(vertex.weights.find((w) => w.bone === 'arm')?.weight ?? 0).toBeGreaterThan(0)

    // grow 跳过它：一根都没刷到
    const grown = setup()
    const other = findAttachment(grown, 's', 'a')!.vertices[0]
    expect(paintWeights(grown, [samples[0]], 'arm', { x: 0, y: 0 }, 20, 0.5, 'grow')).toBe(0)
    expect(other.weights.some((w) => w.bone === 'arm')).toBe(false)

    // 已经受影响的顶点上，grow 照常叠加
    const seeded = setup()
    const seededVertex = findAttachment(seeded, 's', 'a')!.vertices[0]
    const before = seededVertex.weights.find((w) => w.bone === 'root')?.weight ?? 0
    expect(paintWeights(seeded, [samples[0]], 'root', { x: 0, y: 0 }, 20, 0.5, 'grow')).toBe(1)
    expect(seededVertex.weights.find((w) => w.bone === 'root')?.weight ?? 0).toBeGreaterThanOrEqual(before)
  })

  it('smooth（Unity 的 Smooth）：把顶点权重朝邻居平均，并保持总和为 1', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    // 让 1 号顶点整根换成 arm，制造「自己和邻居不一样」的局面
    paintWeights(doc, [samples[1]], 'arm', { x: 10, y: 0 }, 20, 1, 'replace')
    expect(mesh.vertices[1].weights).toEqual([{ bone: 'arm', weight: 1 }])

    // 0 号顶点只有 root：平滑后应带上邻居的 arm，并接近均分
    expect(paintWeights(doc, [samples[0]], 'root', { x: 0, y: 0 }, 20, 1, 'smooth')).toBeGreaterThanOrEqual(1)
    const smoothed = mesh.vertices[0].weights
    expect(smoothed.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 5)
    expect(smoothed.find((w) => w.bone === 'arm')?.weight ?? 0).toBeGreaterThan(0.2)
    expect(smoothed.find((w) => w.bone === 'root')?.weight ?? 0).toBeGreaterThan(0.2)
  })

  it('Normalize 关掉（Unity 的 Normalize 取消勾选）时只改目标骨骼，不再重分配其它骨骼', () => {
    const doc = setup()
    const vertex = findAttachment(doc, 's', 'a')!.vertices[0]
    // 开着 Normalize：arm 0.5，root 被压到 0.5，总和仍是 1
    paintWeights(doc, [samples[0]], 'arm', { x: 0, y: 0 }, 20, 0.5, 'add')
    expect(vertex.weights.find((w) => w.bone === 'arm')?.weight ?? 0).toBeCloseTo(0.5, 5)
    expect(vertex.weights.find((w) => w.bone === 'root')?.weight ?? 0).toBeCloseTo(0.5, 5)

    // 关掉：arm 直接变成 1，root 原样留在 0.5（和 Unity 一样，权重和可以 ≠ 1）
    paintWeights(doc, [samples[0]], 'arm', { x: 0, y: 0 }, 20, 0.5, 'add', false)
    expect(vertex.weights.find((w) => w.bone === 'arm')?.weight ?? 0).toBeCloseTo(1, 5)
    expect(vertex.weights.find((w) => w.bone === 'root')?.weight ?? 0).toBeCloseTo(0.5, 5)
  })

  it('自动权重：结果与现状一致时不计入 touched（调用方据此提示「没有变化」）', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    mesh.vertices[0].weights = [] // 模拟还没绑过权重
    const one = [{ name: 'root', ax: 0, ay: 0, bx: 1, by: 0 }]
    // 从无到有 → 算作处理过
    expect(autoWeights(doc, [samples[0]], one, { falloff: 2 })).toBe(1)
    // 同样输入再算一次：结果完全一致 → 0（不是「失败」，而是本来就该是这个结果）
    expect(autoWeights(doc, [samples[0]], one, { falloff: 2 })).toBe(0)
  })

  it('自动权重：最近的骨骼权重最大且总和为 1', () => {
    const doc = setup()
    const touched = autoWeights(
      doc,
      [{ slot: 's', attachment: 'a', vertex: 0, x: 0, y: 0 }],
      [
        { name: 'root', ax: 0, ay: 0, bx: 1, by: 0 },
        { name: 'arm', ax: 50, ay: 50, bx: 51, by: 50 }
      ],
      { falloff: 2 }
    )
    expect(touched).toBe(1)
    const weights = findAttachment(doc, 's', 'a')?.vertices[0].weights ?? []
    expect(weights[0].bone).toBe('root')
    expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 5)
  })
})

describe('顶点权重：面板里改单根骨骼的权重（setVertexWeight）', () => {
  const setup = () => {
    const doc = createEmptyDocument('vw')
    doc.bones.push(requireBone('root'), requireBone('arm'))
    createRegionFromImage(doc, { image: 'x.png', bone: 'root', width: 100, height: 100, slotName: 's', attachmentName: 'a' })
    convertRegionToMesh(doc, 's', 'a', 1)
    const mesh = findAttachment(doc, 's', 'a')!
    mesh.bones = ['root', 'arm']
    // 顶点起初独占 root，模拟「刚绑上第二根骨骼、还没刷权重」的状态
    for (const vertex of mesh.vertices) vertex.weights = [{ bone: 'root', weight: 1 }]
    return doc
  }
  const weightsOf = (doc: ReturnType<typeof setup>) =>
    Object.fromEntries(
      findAttachment(doc, 's', 'a')!.vertices[0].weights.map((entry) => [
        entry.bone,
        Math.round(entry.weight * 1000) / 1000
      ])
    )

  it('设成 0.3 → 另一根拿 0.7，权和仍是 1', () => {
    const doc = setup()
    expect(setVertexWeight(doc, 's', 'a', 0, 'arm', 0.3)).toBe(true)
    expect(weightsOf(doc)).toEqual({ arm: 0.3, root: 0.7 })
  })

  it('设成 1 → 独占，其它骨骼被清掉（不留 0 权重残渣）', () => {
    const doc = setup()
    expect(setVertexWeight(doc, 's', 'a', 0, 'arm', 1)).toBe(true)
    expect(weightsOf(doc)).toEqual({ arm: 1 })
  })

  it('设成 0 → 这根骨骼被移除，剩下那根回到 1', () => {
    const doc = setup()
    setVertexWeight(doc, 's', 'a', 0, 'arm', 0.4)
    expect(setVertexWeight(doc, 's', 'a', 0, 'arm', 0)).toBe(true)
    expect(weightsOf(doc)).toEqual({ root: 1 })
  })

  it('已有其它骨骼时按原比例分摊剩余量', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    doc.bones.push(requireBone('hand'))
    mesh.bones = ['root', 'arm', 'hand']
    mesh.vertices[0].weights = [
      { bone: 'arm', weight: 0.25 },
      { bone: 'hand', weight: 0.75 }
    ]
    setVertexWeight(doc, 's', 'a', 0, 'arm', 0.5)
    expect(weightsOf(doc)).toEqual({ arm: 0.5, hand: 0.5 })
  })

  it('未绑定骨骼 / 越界顶点 / 无变化都不动作', () => {
    const doc = setup()
    expect(setVertexWeight(doc, 's', 'a', 0, 'nope', 0.5)).toBe(false)
    expect(setVertexWeight(doc, 's', 'a', 99, 'arm', 0.5)).toBe(false)
    expect(setVertexWeight(doc, 's', 'a', 0, 'root', 1)).toBe(false)
  })

  it('只绑一根骨骼的网格：权重只能是 1（权和 < 1 会让顶点朝原点塌陷）', () => {
    const doc = setup()
    findAttachment(doc, 's', 'a')!.bones = ['root']
    expect(setVertexWeight(doc, 's', 'a', 0, 'root', 0.3)).toBe(false)
    expect(weightsOf(doc)).toEqual({ root: 1 })
  })
})

describe('权重骨骼列表', () => {
  const setup = () => {
    const doc = createEmptyDocument('w')
    doc.bones.push(requireBone('root'), requireBone('arm'))
    createRegionFromImage(doc, { image: 'x.png', bone: 'root', width: 100, height: 100, slotName: 's', attachmentName: 'a' })
    convertRegionToMesh(doc, 's', 'a', 1)
    return doc
  }

  it('weightBonesOf：优先显式列表，没有时按顶点权重推断（兼容老数据）', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    // 转网格时顶点已经绑上宿主骨骼 root 的权重 → 按权重推断出的列表就是它
    expect(weightBonesOf(mesh)).toEqual(['root'])

    // 老工程没有 bones 字段也一样：顶点权重里出现过的骨骼都算绑定
    // （按顶点顺序收集，所以覆盖了顶点 0 的 arm 会排在 root 前面）
    mesh.vertices[0].weights = [{ bone: 'arm', weight: 1 }]
    expect(weightBonesOf(mesh)).toEqual(['arm', 'root'])

    // 显式列表优先，并且去重
    mesh.bones = ['root', 'arm', 'root']
    expect(weightBonesOf(mesh)).toEqual(['root', 'arm'])
  })

  it('addWeightBone：加入列表；重复或骨骼不存在时返回 false', () => {
    const doc = setup()
    expect(addWeightBone(doc, 's', 'a', 'arm')).toBe(true)
    expect(weightBonesOf(findAttachment(doc, 's', 'a')!)).toEqual(['root', 'arm'])
    expect(addWeightBone(doc, 's', 'a', 'arm')).toBe(false)
    expect(addWeightBone(doc, 's', 'a', 'ghost')).toBe(false)
  })

  it('removeWeightBone：移除骨骼并清掉顶点权重，剩下的按比例归一化', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    addWeightBone(doc, 's', 'a', 'root')
    addWeightBone(doc, 's', 'a', 'arm')
    for (const vertex of mesh.vertices) {
      vertex.weights = [
        { bone: 'root', weight: 0.25 },
        { bone: 'arm', weight: 0.75 }
      ]
    }

    expect(removeWeightBone(doc, 's', 'a', 'arm')).toBe(true)
    expect(weightBonesOf(mesh)).toEqual(['root'])
    expect(mesh.vertices[0].weights).toHaveLength(1)
    // 不能留下 0.25：权重和小于 1 会让顶点朝原点塌陷，要按比例放大回去
    expect(mesh.vertices[0].weights[0].weight).toBeCloseTo(1, 5)

    expect(removeWeightBone(doc, 's', 'a', 'arm')).toBe(false)
  })

  it('removeWeightBone：删掉顶点最后一根骨骼时退回列表下一根（不让顶点失去蒙皮）', () => {
    const doc = setup()
    const mesh = findAttachment(doc, 's', 'a')!
    addWeightBone(doc, 's', 'a', 'root')
    addWeightBone(doc, 's', 'a', 'arm')
    for (const vertex of mesh.vertices) vertex.weights = [{ bone: 'arm', weight: 1 }]

    expect(removeWeightBone(doc, 's', 'a', 'arm')).toBe(true)
    // 列表里还有 root → 顶点退回 root（权重 1），不会变成「无蒙皮」
    expect(mesh.vertices[0].weights).toEqual([{ bone: 'root', weight: 1 }])

    // 列表里什么都不剩时才留空权重
    expect(removeWeightBone(doc, 's', 'a', 'root')).toBe(true)
    expect(mesh.vertices[0].weights).toHaveLength(0)
  })

  it('绑定关系随工程序列化往返（读取白名单里有 bones）', () => {
    const doc = setup()
    addWeightBone(doc, 's', 'a', 'arm')
    const restored = parseDocument(serializeDocument(doc)).document
    expect(weightBonesOf(findAttachment(restored, 's', 'a')!)).toEqual(['root', 'arm'])
  })
})

describe('关键帧命令', () => {
  const baseAnim = (): AuthoringAnimData => ({
    name: 'a',
    duration: 1,
    bones: [],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    constraints: []
  })

  it('写入骨骼通道并按时间排序，同时间点覆盖', () => {
    const anim = baseAnim()
    keyBoneChannel(anim, 'root', 'rotate', 0.5, 30)
    keyBoneChannel(anim, 'root', 'rotate', 0.1, 10)
    keyBoneChannel(anim, 'root', 'rotate', 0.5, 45)
    const track = anim.bones[0]
    expect(track.rotate.map((k) => k.time)).toEqual([0.1, 0.5])
    expect(track.rotate[1].value).toBe(45)
  })

  it('translate 通道用二维关键帧', () => {
    const anim = baseAnim()
    keyBoneChannel(anim, 'root', 'translate', 0, { x: 1, y: 2 })
    expect(anim.bones[0].translate[0].value).toEqual({ x: 1, y: 2 })
  })

  it('删除最后一个关键帧会移除整条轨道', () => {
    const anim = baseAnim()
    keyBoneChannel(anim, 'root', 'rotate', 0, 10)
    expect(anim.bones).toHaveLength(1)
    expect(removeBoneKeyframe(anim, 'root', 'rotate', 0)).toBe(true)
    expect(anim.bones).toHaveLength(0)
  })

  it('pruneEmptyTracks 清理空轨道', () => {
    const anim = baseAnim()
    ensureBoneAnim(anim, 'root')
    anim.deforms.push({ slot: 's', attachment: 'a', frames: [] })
    pruneEmptyTracks(anim)
    expect(anim.bones).toHaveLength(0)
    expect(anim.deforms).toHaveLength(0)
  })

  it('FFD 关键帧写入与删除', () => {
    const anim = baseAnim()
    keyDeform(anim, 's', 'a', 0.25, [0.1, 0.2, 0, 0])
    const frame = anim.deforms[0].frames[0]
    expect(frame.offsets).toEqual([0.1, 0.2, 0, 0])
    expect(frame.easing).toBe(Easing.Linear)
    expect(removeDeformKeyframe(anim, 's', 'a', 0.25)).toBe(true)
    expect(anim.deforms).toHaveLength(0)
  })
})

describe('重命名（引用级联）', () => {
  function sampleDoc(): ReturnType<typeof createEmptyDocument> {
    const doc = createEmptyDocument('t')
    doc.bones.push({ ...requireBone('root'), name: 'root' })
    doc.bones.push({ ...requireBone('arm'), name: 'arm', parent: 'root' })
    doc.slots.push(
      createAuthoringSlot({
        name: 'hand',
        bone: 'arm',
        zOrder: 0,
        attachment: 'hand'
      })
    )
    // createEmptyDocument 自带 default 皮肤，附件清单直接挂进去
    doc.skins[0].slots.push({
      slot: 'hand',
      attachments: [
        createAuthoringAttachment({ name: 'hand', type: 'region', image: 'a.png' })
      ]
    })
    return doc
  }

  it('骨骼改名：父子引用、插槽宿主、动画轨道同步更新', () => {
    const doc = sampleDoc()
    doc.animations.push({
      name: 'walk',
      duration: 1,
      bones: [{ bone: 'arm', translate: [], rotate: [], scale: [], shear: [] }],
      slots: [],
      deforms: [],
      drawOrder: [],
      events: [],
      constraints: []
    })

    expect(checkRename(doc, { kind: 'bone' }, 'arm', 'forearm')).toBeNull()
    expect(applyRename(doc, { kind: 'bone' }, 'arm', 'forearm')).toBe(true)

    expect(doc.bones.find((b) => b.name === 'forearm')).toBeTruthy()
    expect(doc.bones.find((b) => b.name === 'arm')).toBeUndefined()
    // 子骨骼的 parent 跟着换（arm 没有子骨骼，root 的 parent 本来就是空）
    expect(doc.slots[0].bone).toBe('forearm')
    expect(doc.animations[0].bones[0].bone).toBe('forearm')
  })

  it('插槽改名：皮肤清单、绘制顺序帧、deform 轨道同步更新', () => {
    const doc = sampleDoc()
    doc.animations.push({
      name: 'walk',
      duration: 1,
      bones: [],
      slots: [{ slot: 'hand', color: [], displayIndex: [], displayAttachment: [], visible: [] }],
      deforms: [{ slot: 'hand', attachment: 'hand', frames: [] }],
      drawOrder: [{ time: 0, order: ['hand'] }],
      events: [],
      constraints: []
    })

    expect(applyRename(doc, { kind: 'slot' }, 'hand', 'palm')).toBe(true)
    expect(doc.slots[0].name).toBe('palm')
    expect(doc.skins[0].slots[0].slot).toBe('palm')
    expect(doc.animations[0].slots[0].slot).toBe('palm')
    expect(doc.animations[0].deforms[0].slot).toBe('palm')
    expect(doc.animations[0].drawOrder[0].order).toEqual(['palm'])
  })

  it('附件改名：插槽当前显示、动画 displayAttachment 同步更新', () => {
    const doc = sampleDoc()
    doc.animations.push({
      name: 'walk',
      duration: 1,
      bones: [],
      slots: [{ slot: 'hand', color: [], displayIndex: [], displayAttachment: ['hand', 'other'], visible: [] }],
      deforms: [{ slot: 'hand', attachment: 'hand', frames: [] }],
      drawOrder: [],
      events: [],
      constraints: []
    })

    expect(applyRename(doc, { kind: 'attachment', slot: 'hand' }, 'hand', 'fist')).toBe(true)
    expect(doc.skins[0].slots[0].attachments[0].name).toBe('fist')
    expect(doc.slots[0].attachment).toBe('fist')
    expect(doc.animations[0].slots[0].displayAttachment).toEqual(['fist', 'other'])
    expect(doc.animations[0].deforms[0].attachment).toBe('fist')
  })

  it('重名 / 空名被预检拦截，不产生改动', () => {
    const doc = sampleDoc()
    expect(checkRename(doc, { kind: 'bone' }, 'arm', 'root')).toBe('已经有一个叫「root」的骨骼了')
    expect(checkRename(doc, { kind: 'slot' }, 'hand', '  ')).toBe('名字不能为空')
    expect(applyRename(doc, { kind: 'bone' }, 'arm', 'root')).toBe(false)
    // 名字没变：文档保持原样
    expect(doc.bones.map((b) => b.name)).toEqual(['root', 'arm'])
  })
})

function triangleAreaSum(
  points: ReadonlyArray<{ x: number; y: number }>,
  triangles: readonly number[]
): number {
  let sum = 0
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = points[triangles[i]]
    const b = points[triangles[i + 1]]
    const c = points[triangles[i + 2]]
    sum += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5
  }
  return sum
}

function requireBone(name: string): import('@core/model/authoring').AuthoringBone {
  return {
    name,
    parent: '',
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 0.5,
    color: '#ffffff',
    locked: false
  }
}

describe('附件解析：皮肤优先、跨皮肤兜底（resolveAttachment）', () => {
  /** default 皮肤有 spear（mesh）；girl 皮肤只有 dagger —— 复现「切过皮肤」的现实结构 */
  function setup() {
    const doc = createEmptyDocument()
    doc.skins[0].slots.push({
      slot: 'hand',
      attachments: [{ name: 'spear', type: 'mesh' } as never]
    })
    doc.skins.push({
      name: 'girl',
      slots: [{ slot: 'hand', attachments: [{ name: 'dagger', type: 'region' } as never] }]
    })
    return doc
  }

  it('当前皮肤里有就用当前皮肤那份（同名附件在不同皮肤里可以不一样）', () => {
    const doc = setup()
    doc.skins[1].slots[0].attachments.push({ name: 'spear', type: 'region' } as never)
    expect(resolveAttachment(doc, 'hand', 'spear', 'girl')?.type).toBe('region')
    expect(resolveAttachment(doc, 'hand', 'spear', 'default')?.type).toBe('mesh')
  })

  it('当前皮肤里没有该附件时跨皮肤兜底（切过皮肤不该让选中项整段失效）', () => {
    const doc = setup()
    // 实测过的场景：皮肤切到 girl 后再选 default 里的 spear，原来返回 null、高亮整段消失
    expect(resolveAttachment(doc, 'hand', 'spear', 'girl')?.name).toBe('spear')
  })

  it('没指定皮肤同样能解析；到处都没有时返回 null', () => {
    const doc = setup()
    expect(resolveAttachment(doc, 'hand', 'spear')?.name).toBe('spear')
    expect(resolveAttachment(doc, 'hand', 'nope', 'girl')).toBeNull()
    expect(resolveAttachment(doc, 'nope', 'spear', 'default')).toBeNull()
  })
})

describe('权重刷模式（Unity Weight Brush 的 Mode）', () => {
  const plain = { alt: false, shift: false }

  it('没按修饰键时用面板里的 Mode', () => {
    expect(brushModeFor(plain, baseBrushMode('addSubtract'))).toBe('add')
    expect(brushModeFor(plain, baseBrushMode('growShrink'))).toBe('grow')
    expect(brushModeFor(plain, baseBrushMode('smooth'))).toBe('smooth')
  })

  it('修饰键优先于 Mode：Alt 减少 / Shift 覆盖 / Ctrl 平滑 / Ctrl+Shift 生长', () => {
    const base = baseBrushMode('growShrink')
    expect(brushModeFor({ alt: true, shift: false }, base)).toBe('subtract')
    expect(brushModeFor({ alt: false, shift: true }, base)).toBe('replace')
    expect(brushModeFor({ alt: false, shift: false, ctrl: true }, base)).toBe('smooth')
    expect(brushModeFor({ alt: false, shift: true, ctrl: true }, base)).toBe('grow')
    // Ctrl+Shift+Alt = 收缩（生长模式下按住 Alt）
    expect(brushModeFor({ alt: true, shift: true, ctrl: true }, base)).toBe('subtract')
  })
})

describe('骨骼多选', () => {
  const selection = () => useSelectionStore.getState()

  beforeEach(() => {
    useSelectionStore.getState().clear()
  })

  it('单选会取代整批；Shift / Cmd 点击增删，新加进来的成为主选中', () => {
    selection().selectBone('armL')
    expect(selection().bones).toEqual(['armL'])
    expect(selection().bone).toBe('armL')

    selection().toggleBone('armR')
    expect(selection().bones).toEqual(['armL', 'armR'])
    expect(selection().bone).toBe('armR')

    // 移除的若不是主选中，主选中不变
    selection().toggleBone('armL')
    expect(selection().bones).toEqual(['armR'])
    expect(selection().bone).toBe('armR')

    // 再点一次取消最后一根 → 回到「没有选中对象」
    selection().toggleBone('armR')
    expect(selection().bones).toEqual([])
    expect(selection().kind).toBe('none')

    selection().selectBone('armL')
    selection().toggleBone('armR')
    selection().selectBone('head')
    expect(selection().bones).toEqual(['head'])
  })

  it('切到插槽 / 附件 / 约束时骨骼集合清空（叠加层不会还画着上一批骨骼）', () => {
    selection().selectBone('armL')
    selection().toggleBone('armR')
    selection().selectSlot('head')
    expect(selection().bones).toEqual([])

    selection().selectBone('armL')
    selection().toggleBone('armR')
    selection().selectAttachment('head', 'mesh')
    expect(selection().bones).toEqual([])

    selection().selectBone('armL')
    selection().selectConstraint('look')
    expect(selection().bones).toEqual([])
  })

  it('selectBones 保留点选顺序（最后一根是主选中）并去掉重复项', () => {
    selection().selectBones(['armL', 'armR', 'armL', 'head'])
    expect(selection().bones).toEqual(['armL', 'armR', 'head'])
    expect(selection().bone).toBe('head')
    expect(selection().kind).toBe('bone')

    selection().selectBones([])
    expect(selection().kind).toBe('none')
    expect(selection().bone).toBe('')
  })

  it('wrapDegrees：把角度差收进 (-180, 180]，跨过 atan2 的 ±180° 断开处不会倒转一大圈', () => {
    expect(wrapDegrees(60)).toBe(60)
    expect(wrapDegrees(-45)).toBe(-45)
    // 170° → −170° 实际是 +20°：直接相减会得到 −340°，修完是 +20°
    expect(wrapDegrees(-170 - 170)).toBe(20)
    // 反向：−170° → 170° 实际是 −20°
    expect(wrapDegrees(170 - -170)).toBe(-20)
    expect(wrapDegrees(360 + 30)).toBe(30)
    expect(wrapDegrees(-360 - 30)).toBe(-30)
    expect(wrapDegrees(180)).toBe(-180)
  })

})
