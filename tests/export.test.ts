import { describe, expect, it } from 'vitest'
import { packMaxRects } from '@core/atlas/packer'
import { remapPageUvs } from '@core/atlas/remap'
import { RUNTIME_PPU, parseRuntimeAtlas, parseRuntimeSke, serializeRuntimeAtlas, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import { assetFromJson, loadRuntime } from '@core/runtime/loader'
import { compileDocument } from '@core/codec/compile'
import { parseDocument } from '@core/codec/projectJson'
import { createSampleDocument } from '@core/sample'
import { prepareRuntimeExport } from '@editor/services/exportService'
import type { RuntimeExportPlan } from '@editor/services/exportService'
import { useProjectStore } from '@editor/store/projectStore'
import { buildRegionLookup, buildSpineJson, serializeSpineAtlas } from '@editor/services/spineExport'
import { importSpine } from '@importers/spine'
import type { AtlasRegion } from '@importers/uv'
import { createAuthoringAttachment } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { MeshBuilder } from '@core/skin/meshBuilder'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'

describe('MaxRects 图集打包', () => {
  it('图块互不重叠且都在页内', () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, width: 37 + (i % 5) * 11, height: 29 + (i % 7) * 13 }))
    const result = packMaxRects(items, { maxSize: 512, initialSize: 256, padding: 2, border: 2 })
    expect(result.failed).toEqual([])
    expect(result.placements).toHaveLength(items.length)

    for (const placement of result.placements) {
      const page = result.pages[placement.page]
      expect(placement.x).toBeGreaterThanOrEqual(0)
      expect(placement.y).toBeGreaterThanOrEqual(0)
      expect(placement.x + placement.width).toBeLessThanOrEqual(page.width)
      expect(placement.y + placement.height).toBeLessThanOrEqual(page.height)
    }

    for (let i = 0; i < result.placements.length; i++) {
      for (let j = i + 1; j < result.placements.length; j++) {
        const a = result.placements[i]
        const b = result.placements[j]
        if (a.page !== b.page) continue
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `${a.id} 与 ${b.id} 重叠`).toBe(false)
      }
    }
  })

  it('放不下时自动开新页', () => {
    const items = [
      { id: 'a', width: 200, height: 200 },
      { id: 'b', width: 200, height: 200 },
      { id: 'c', width: 200, height: 200 }
    ]
    const result = packMaxRects(items, { maxSize: 256, initialSize: 256, padding: 0, border: 0 })
    // 256 的页只能放一个 200×200
    expect(result.pages.length).toBe(3)
  })

  it('超过单页上限的图块被记为失败', () => {
    const result = packMaxRects([{ id: 'huge', width: 4096, height: 64 }], { maxSize: 1024 })
    expect(result.failed).toEqual(['huge'])
    expect(result.placements).toHaveLength(0)
  })

  it('空输入返回空结果', () => {
    const result = packMaxRects([], {})
    expect(result.pages).toEqual([])
    expect(result.placements).toEqual([])
  })
})

describe('UV 重映射', () => {
  it('整图放到新页后 UV 线性映射', () => {
    const uvs = [0, 0, 1, 0, 1, 1, 0, 1]
    const out = remapPageUvs(uvs, { x: 10, y: 20, width: 100, height: 100 }, { width: 200, height: 200 })
    expect(out[0]).toBeCloseTo(10 / 200, 5)
    expect(out[1]).toBeCloseTo(1 - 120 / 200, 5)
    expect(out[2]).toBeCloseTo(110 / 200, 5)
    expect(out[3]).toBeCloseTo(1 - 120 / 200, 5)
    expect(out[4]).toBeCloseTo(110 / 200, 5)
    expect(out[5]).toBeCloseTo(1 - 20 / 200, 5)
    expect(out[6]).toBeCloseTo(10 / 200, 5)
    expect(out[7]).toBeCloseTo(1 - 20 / 200, 5)
  })

  it('保持 UV 相对关系（缩放后仍是矩形）', () => {
    const out = remapPageUvs(
      [0.25, 0.5, 0.75, 0.5, 0.75, 0.9],
      { x: 0, y: 0, width: 64, height: 64 },
      { width: 128, height: 128 }
    )
    expect(out[2] - out[0]).toBeCloseTo(0.25, 5)
  })

  it('图集缩放：UV 按放置区尺寸映射，正好覆盖缩小后的整块图案', () => {
    // 100×100 的源图按 50% 打包 → 放置区只有 50×50
    const out = remapPageUvs(
      [0, 0, 1, 0, 1, 1, 0, 1],
      { x: 0, y: 0, width: 50, height: 50 },
      { width: 64, height: 64 }
    )
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[1]).toBeCloseTo(1 - 50 / 64, 5)
    expect(out[2]).toBeCloseTo(50 / 64, 5)
    expect(out[3]).toBeCloseTo(1 - 50 / 64, 5)
    expect(out[4]).toBeCloseTo(50 / 64, 5)
    expect(out[5]).toBeCloseTo(1, 5)
    expect(out[6]).toBeCloseTo(0, 5)
    expect(out[7]).toBeCloseTo(1, 5)
  })
})

describe('自定义运行时格式往返', () => {
  const doc = createSampleDocument()
  const { asset } = compileDocument(doc)

  it('ske.json 序列化后可解析并与原模型一致', () => {
    const text = serializeRuntimeSke(asset, { atlasFileName: 'hero_atlas.json' })
    const parsed = parseRuntimeSke(text)
    expect(parsed.armatureName).toBe(asset.armatureName)
    expect(parsed.bones).toHaveLength(asset.bones.length)
    expect(parsed.textureNames).toEqual(asset.textureNames)
    expect(parsed.atlas).toBe('hero_atlas.json')

    const rebuilt = assetFromJson(parsed, null)
    expect(rebuilt.bones.map((b) => b.name)).toEqual(asset.bones.map((b) => b.name))
    expect(rebuilt.bones[0].rotation).toBeCloseTo(asset.bones[0].rotation, 4)
    expect(rebuilt.slots.map((s) => s.name)).toEqual(asset.slots.map((s) => s.name))
    expect(rebuilt.skins[0].slots.length).toBe(asset.skins[0].slots.length)
    expect(rebuilt.animations.map((a) => a.name)).toEqual(asset.animations.map((a) => a.name))
    expect(rebuilt.bindposes.length).toBe(asset.bindposes.length)
  })

  it('重建后的模型能产出与原来相同的顶点数', () => {
    const text = serializeRuntimeSke(asset, { atlasFileName: 'a.json' })
    const rebuilt = assetFromJson(parseRuntimeSke(text), null)
    const original = new MeshBuilder(asset, '').build(new Skeleton(asset))
    const after = new MeshBuilder(rebuilt, '').build(new Skeleton(rebuilt))
    expect(after.vertexCount).toBe(original.vertexCount)
    expect(after.groups.length).toBe(original.groups.length)
    for (let i = 0; i < original.positions.length; i++) {
      expect(after.positions[i]).toBeCloseTo(original.positions[i], 4)
    }
  })

  it('重建后的模型可播放动画', () => {
    const text = serializeRuntimeSke(asset, { atlasFileName: 'a.json' })
    const rebuilt = assetFromJson(parseRuntimeSke(text), null)
    const skeleton = new Skeleton(rebuilt)
    const player = new AnimationPlayer(rebuilt, skeleton)
    expect(player.play('idle', true)).toBe(true)
    player.update(0.75)
    expect(skeleton.localRot[3]).not.toBeCloseTo(0, 3)
  })

  it('图集描述往返一致', () => {
    const atlas = {
      format: 'hao2d-atlas' as const,
      version: 1 as const,
      pages: [{ image: 'hero_0.png', width: 256, height: 256 }],
      regions: [{ name: 'body', page: 0, x: 0, y: 0, width: 100, height: 100 }]
    }
    const back = parseRuntimeAtlas(serializeRuntimeAtlas(atlas))
    expect(back).toEqual(atlas)
  })

  it('格式或版本不符时抛出可读错误', () => {
    expect(() => parseRuntimeSke('{"format":"other"}')).toThrow(/hao2d-ske/)
    expect(() => parseRuntimeSke('{"format":"hao2d-ske","version":9}')).toThrow(/版本/)
    expect(() => parseRuntimeAtlas('{"format":"nope"}')).toThrow(/hao2d-atlas/)
  })

  it('loadRuntime 一步完成加载（游戏侧用法）', () => {
    const ske = serializeRuntimeSke(asset, { atlasFileName: 'a.json' })
    const atlas = serializeRuntimeAtlas({
      format: 'hao2d-atlas',
      version: 1,
      pages: [{ image: 'a_0.png', width: 128, height: 128 }],
      regions: []
    })
    const loaded = loadRuntime(ske, atlas)
    expect(loaded.asset.bones.length).toBe(asset.bones.length)
    expect(loaded.atlas.pages[0].image).toBe('a_0.png')
    expect(loaded.asset.images[0].name).toBe('a_0.png')
  })
})

describe('导出准备（图集缩放）', () => {
  /** 示例文档的附件都指向各自的图片，这样图集里才有东西可打包 */
  function documentWithImages(): EditorDocument {
    const doc = createSampleDocument()
    const names = new Set<string>()
    for (const skin of doc.skins) {
      for (const skinSlot of skin.slots) {
        for (const attachment of skinSlot.attachments) {
          const name = `${attachment.name}.png`
          attachment.image = name
          names.add(name)
        }
      }
    }
    doc.images = [...names].map((name, index) => ({
      name,
      path: `/art/${name}`,
      width: 128 + index * 37,
      height: 96 + index * 23,
      loose: true
    }))
    return doc
  }

  const displaySizes = (plan: RuntimeExportPlan): Array<readonly [string, number, number]> =>
    plan.skeletons[0].asset.skins.flatMap((skin) =>
      skin.slots.flatMap((slot) =>
        slot.attachments.map((attachment) => [attachment.name, attachment.size.x, attachment.size.y] as const)
      )
    )

  it('缩放只动图集占位：页数不增加、显示尺寸不变、UV 仍在 0..1', () => {
    useProjectStore.getState().setDocument(documentWithImages(), null, false)
    const full = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    const half = prepareRuntimeExport({ scale: 0.5, maxSize: 2048 })

    expect(full.atlas.regions.length).toBeGreaterThan(0)
    expect(half.atlas.pages.length).toBeLessThanOrEqual(full.atlas.pages.length)

    // 每个图块在页里的占位按比例缩小
    for (const region of full.atlas.regions) {
      const scaled = half.atlas.regions.find((item) => item.name === region.name)
      expect(scaled).toBeDefined()
      expect(scaled?.width).toBe(Math.max(1, Math.round(region.width * 0.5)))
      expect(scaled?.height).toBe(Math.max(1, Math.round(region.height * 0.5)))
    }

    // 附件自身的显示尺寸完全不变（画面大小不受缩放影响）
    expect(displaySizes(half)).toEqual(displaySizes(full))

    // 重映射后的 UV 必须仍落在 0..1
    for (const skin of half.skeletons[0].asset.skins) {
      for (const slot of skin.slots) {
        for (const attachment of slot.attachments) {
          for (const value of attachment.uvs) {
            expect(value).toBeGreaterThanOrEqual(-1e-6)
            expect(value).toBeLessThanOrEqual(1 + 1e-6)
          }
        }
      }
    }
  })

  it('缩小后单页能装下更多内容（总占位面积下降）', () => {
    useProjectStore.getState().setDocument(documentWithImages(), null, false)
    const full = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    const tiny = prepareRuntimeExport({ scale: 0.25, maxSize: 2048 })
    const area = (plan: RuntimeExportPlan): number =>
      plan.atlas.regions.reduce((sum, region) => sum + region.width * region.height, 0)
    expect(area(tiny)).toBeLessThan(area(full))
    expect(tiny.pageFiles).toHaveLength(tiny.atlas.pages.length)
  })

  it('运行库读缩放后的产物：显示尺寸不变、UV 原样带过去（缩放不需要运行时补偿）', () => {
    useProjectStore.getState().setDocument(documentWithImages(), null, false)
    const full = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    const half = prepareRuntimeExport({ scale: 0.5, maxSize: 2048 })
    /*
     * resources/runtimes 里的 hao2d-pixi / hao2d-three 都从 `loadRuntime` 解码：
     * 它们只认 atlas 的页名 + ske 里已经烘焙好的归一化 UV 和附件 size，不读任何 scale 字段。
     * 这条断言把「缩放导出物能被运行库正确消费」钉住，防止以后有人往运行时加按原尺寸反算的逻辑。
     */
    const decode = (plan: RuntimeExportPlan) =>
      loadRuntime(
        serializeRuntimeSke(plan.skeletons[0].asset, { atlasFileName: plan.atlasName, ppu: RUNTIME_PPU }),
        serializeRuntimeAtlas(plan.atlas)
      )
    const a = decode(full)
    const b = decode(half)
    const attachments = (loaded: ReturnType<typeof loadRuntime>) =>
      loaded.asset.skins.flatMap((skin) => skin.slots.flatMap((slot) => slot.attachments))

    // 图块确实缩小了（缩放生效；页尺寸是 2 的幂，样本小的时候两档可能都是同一尺寸）
    const regionArea = (loaded: ReturnType<typeof loadRuntime>) =>
      loaded.atlas.regions.reduce((sum, region) => sum + region.width * region.height, 0)
    expect(regionArea(b)).toBeLessThan(regionArea(a))
    const sizeAndUvs = (loaded: ReturnType<typeof loadRuntime>) =>
      attachments(loaded).map((attachment) => [attachment.size.x, attachment.size.y, attachment.uvs.length])
    expect(sizeAndUvs(b)).toEqual(sizeAndUvs(a))
    // UV 随缩放重映射过，且仍全部落在 0..1（能正确采样缩小后的页）
    expect(attachments(b)[0].uvs).not.toEqual(attachments(a)[0].uvs)
    for (const attachment of attachments(b)) {
      for (const value of attachment.uvs) {
        expect(value).toBeGreaterThanOrEqual(-1e-6)
        expect(value).toBeLessThanOrEqual(1 + 1e-6)
      }
    }
  })

  it('多骨架：各自一份数据、图集共用且取名项目名；图集范围决定装哪些图', () => {
    const first = documentWithImages()
    const second = documentWithImages()
    // 第二套骨架用一组不同的图名，才分得出「所有骨架的图」和「选中骨架的图」
    for (const skin of second.skins) {
      for (const skinSlot of skin.slots) {
        for (const attachment of skinSlot.attachments) attachment.image = `B-${attachment.image}`
      }
    }
    second.images = second.images.map((image) => ({ ...image, name: `B-${image.name}` }))
    const pool = [...first.images, ...second.images]
    first.images = pool
    second.images = pool

    const store = useProjectStore.getState()
    store.setProject([first, second], 0, null, false)
    store.setProjectInfo({ projectName: '我的项目' })

    const both = prepareRuntimeExport({ scale: 1, maxSize: 2048, skeletons: [0, 1], atlasScope: 'all' })
    expect(both.skeletons).toHaveLength(2)
    // 两个骨架同名时文件名自动错开，不会互相覆盖
    expect(new Set(both.skeletons.map((entry) => entry.fileName)).size).toBe(2)
    expect(both.atlasName).toBe('我的项目_atlas.json')
    expect(both.pageFiles[0]?.startsWith('我的项目_')).toBe(true)
    // 默认范围：两套骨架用到的图都在同一张图集里
    const names = both.atlas.regions.map((region) => region.name)
    expect(names.some((name) => name.startsWith('B-'))).toBe(true)

    // 只导第一个骨架 + 只装它用到的图
    const onlyFirst = prepareRuntimeExport({ scale: 1, maxSize: 2048, skeletons: [0], atlasScope: 'selected' })
    expect(onlyFirst.skeletons).toHaveLength(1)
    expect(onlyFirst.atlas.regions.length).toBeGreaterThan(0)
    expect(onlyFirst.atlas.regions.some((region) => region.name.startsWith('B-'))).toBe(false)
  })

  it('骨骼数据文件名跟骨架名走、图集与图集配置跟项目名走（两边互不影响）', () => {
    const doc = documentWithImages()
    useProjectStore.getState().setDocument(doc, null, false)
    useProjectStore.getState().setProjectInfo({ projectName: '我的项目' })

    const plan = prepareRuntimeExport({ scale: 1, maxSize: 2048 })

    // 骨骼数据：文件名取自**骨架名**，这一条不动（Unity / 游戏侧的文件名与 GUID 都靠它稳定）
    expect(plan.skeletons[0].fileName).toBe(`${doc.armatureName}_ske.json`)
    expect(plan.skeletons[0].fileName).not.toContain('我的项目')

    // 图集与图集配置：一律跟项目名（图集页、atlas.json 是同一套命名）
    expect(plan.atlasName).toBe('我的项目_atlas.json')
    expect(plan.pageFiles.length).toBeGreaterThan(0)
    expect(plan.pageFiles.every((file) => file.startsWith('我的项目_'))).toBe(true)
  })
})

describe('已经是图集的资源：导出时不再重打包', () => {
  /**
   * 一张「本来就是图集」的图（`loose === false`，导入 Spine / DragonBones 时带进来的那种），
   * 附件只用到它的一小块（子区域 UV）—— 重打包会让 UV 变、整页复制则必须原样保留。
   */
  function atlasDocument(): EditorDocument {
    const doc = createSampleDocument()
    const attachments = doc.skins.flatMap((skin) => skin.slots.flatMap((slot) => slot.attachments))
    for (const attachment of attachments) {
      attachment.image = 'sheet.png'
      attachment.uvs = [0.25, 0.25, 0.5, 0.25, 0.5, 0.5, 0.25, 0.5]
    }
    doc.images = [{ name: 'sheet.png', path: '/art/sheet.png', width: 512, height: 256, loose: false }]
    return doc
  }

  const uvsOf = (doc: EditorDocument): number[][] =>
    compileDocument(doc).asset.skins.flatMap((skin) =>
      skin.slots.flatMap((slot) => slot.attachments.map((attachment) => Array.from(attachment.uvs)))
    )

  it('整页照搬：页名跟项目名、UV 原样、不产生打包页', () => {
    const doc = atlasDocument()
    const store = useProjectStore.getState()
    store.setDocument(doc, null, false)
    store.setProjectInfo({ projectName: '我的项目' })

    const before = uvsOf(doc)
    const plan = prepareRuntimeExport({ scale: 0.5, maxSize: 2048 })

    expect(plan.pageFiles).toEqual(['我的项目_0.png'])
    expect(plan.pageSources).toEqual([{ kind: 'copy', path: '/art/sheet.png', sourceName: 'sheet.png' }])
    expect(plan.atlas.pages).toEqual([{ image: '我的项目_0.png', width: 512, height: 256 }])
    // 页里只有「整页」这一块，没有碎图被塞进来
    expect(plan.atlas.regions).toEqual([
      { name: 'sheet.png', page: 0, x: 0, y: 0, width: 512, height: 256 }
    ])

    // UV 必须原样：它们是按这一页归一化的，重映射一次就错位了
    expect(
      plan.skeletons[0].asset.skins.flatMap((skin) =>
        skin.slots.flatMap((slot) => slot.attachments.map((attachment) => Array.from(attachment.uvs)))
      )
    ).toEqual(before)
    expect(plan.skeletons[0].asset.textureNames).toEqual(['我的项目_0.png'])
    // 缩放对「原图复制」的页无效，但要说清楚
    expect(plan.warnings.some((warning) => warning.includes('不参与'))).toBe(true)
  })

  it('碎图和图集页并存：复制页在前、打包页在后，只有碎图重映射 UV', () => {
    const doc = atlasDocument()
    const sprite = createAuthoringAttachment({
      name: 'sprite',
      image: 'sprite.png',
      size: { x: 40, y: 30 },
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      vertices: [{ x: 0, y: 0, weights: [] }],
      triangles: []
    })
    doc.skins[0].slots[0].attachments.push(sprite)
    doc.images.push({ name: 'sprite.png', path: '/art/sprite.png', width: 40, height: 30, loose: true })

    const store = useProjectStore.getState()
    store.setDocument(doc, null, false)
    store.setProjectInfo({ projectName: 'mix' })

    const plan = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    expect(plan.pageFiles).toHaveLength(2)
    expect(plan.pageFiles[0]).toBe('mix_0.png')
    expect(plan.pageSources[0]).toMatchObject({ kind: 'copy', sourceName: 'sheet.png' })
    expect(plan.pageSources[1]).toMatchObject({ kind: 'packed' })
    // 打包页里只有碎图
    const packed = plan.pageSources[1]
    expect(packed.kind === 'packed' && packed.plan.blits.map((blit) => blit.name)).toEqual(['sprite.png'])
    // 图集页的附件指向页名（UV 不动），碎图指向打包页
    const attachments = plan.skeletons[0].asset.skins.flatMap((skin) =>
      skin.slots.flatMap((slot) => slot.attachments)
    )
    const sheet = attachments.find((attachment) => attachment.name !== 'sprite')
    const packedSprite = attachments.find((attachment) => attachment.name === 'sprite')
    expect(sheet?.textureName).toBe('mix_0.png')
    expect(Array.from(sheet?.uvs ?? [])).toEqual([0.25, 0.25, 0.5, 0.25, 0.5, 0.5, 0.25, 0.5])
    expect(packedSprite?.textureName).toBe('mix_1.png')
  })

  it('Spine 导出的 mesh uvs 是区域相对坐标：按官方语义读回后与原整页 UV 完全一致', () => {
    const doc = atlasDocument()
    // 这一页里有一块子区域（导入 Spine / DragonBones 时会保留），网格就挂在这块上
    doc.images[0].regions = [{ name: 'head', x: 64, y: 32, width: 128, height: 96 }]
    const slot = doc.skins[0].slots[0]
    slot.attachments.push(
      createAuthoringAttachment({
        name: 'sheet_mesh',
        type: 'mesh',
        image: 'sheet.png',
        regionName: 'head',
        size: { x: 128, y: 96 },
        vertices: [
          { x: 0, y: 0, weights: [] },
          { x: 128, y: 0, weights: [] },
          { x: 128, y: 96, weights: [] },
          { x: 0, y: 96, weights: [] }
        ],
        triangles: [0, 1, 2, 0, 2, 3],
        // head 区域四角在整页 512×256 上的归一化坐标（v 左下原点）
        uvs: [0.125, 0.5, 0.375, 0.5, 0.375, 0.875, 0.125, 0.875]
      })
    )

    const store = useProjectStore.getState()
    store.setDocument(doc, null, false)
    store.setProjectInfo({ projectName: '我的项目' })

    const plan = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    const asset = plan.skeletons[0].asset
    const lookup = buildRegionLookup(plan.atlas)
    const json = buildSpineJson(asset, lookup)

    // Spine 侧的读法：页 UV = 区域原点 + 区域相对 UV × 区域尺寸（v 原点在页顶边，见官方
    // MeshAttachment.ComputeUVs）—— 用导入端（等价实现）读回来应当得到导出前的整页 UV。
    const atlasRegions: AtlasRegion[] = plan.atlas.regions.map((region) => ({
      name: region.name,
      page: plan.atlas.pages[region.page]?.image ?? '',
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      rotate: region.rotate ?? 0,
      origWidth: region.origWidth ?? region.width,
      origHeight: region.origHeight ?? region.height,
      offsetX: region.offsetX ?? 0,
      offsetY: region.offsetY ?? 0
    }))
    const pageSizes = Object.fromEntries(
      plan.atlas.pages.map((page) => [page.image, { width: page.width, height: page.height }])
    )
    const back = importSpine({ json, regions: atlasRegions, pageSizes }).asset
    const meshUvs = (target: typeof asset, name: string): number[] =>
      Array.from(
        target.skins.flatMap((skin) => skin.slots.flatMap((s) => s.attachments)).find((a) => a.name === name)?.uvs ?? []
      )
    const originalUvs = meshUvs(asset, 'sheet_mesh')

    // 原 UV 是「整页归一化」（v 左下原点），导出成 Spine 的后必须能按官方语义原样读回
    expect(originalUvs).toEqual([0.125, 0.5, 0.375, 0.5, 0.375, 0.875, 0.125, 0.875])
    expect(meshUvs(back, 'sheet_mesh')).toEqual(originalUvs)
  })

  it('老工程文件没有 loose 字段：按碎图处理，照旧重打包', () => {
    const doc = atlasDocument()
    // 模拟老工程：JSON 里根本没有 loose 字段
    const legacy = JSON.stringify({
      ...doc,
      images: doc.images.map((image) => ({
        name: image.name,
        path: image.path,
        width: image.width,
        height: image.height
      }))
    })
    const parsed = parseDocument(legacy).document
    expect(parsed.images[0].loose).toBe(true)

    useProjectStore.getState().setDocument(parsed, null, false)
    const plan = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    expect(plan.pageSources.map((source) => source.kind)).toEqual(['packed'])
  })
})

describe('Spine 导出：图集缩放由 regionScale 补偿（与运行期导出一致）', () => {
  /**
   * 切到 Spine 模式后「图集缩放」重新可用：纹理按比例缩小、region 附件的 JSON 仍写原图尺寸，
   * Spine 运行时用 regionScale = width / 区域宽 把四边形拉回原大小，角色视觉不变。钉住这条不变量，
   * 免得哪天又被误改成 scale 写死 1。
   */
  function oneImageDocument(): EditorDocument {
    const doc = createSampleDocument()
    for (const skin of doc.skins) {
      for (const slot of skin.slots) {
        for (const attachment of slot.attachments) attachment.image = 'hero.png'
      }
    }
    doc.images = [{ name: 'hero.png', path: '/art/hero.png', width: 200, height: 100, loose: true }]
    return doc
  }

  /** 从 Spine JSON 里捞出所有带 width/height 的附件（主要是 region）尺寸 */
  function spineAttachmentSizes(json: unknown): Array<{ w: number; h: number }> {
    const sizes: Array<{ w: number; h: number }> = []
    const skins = (json as { skins?: Array<{ attachments: Record<string, Record<string, { width?: number; height?: number }>> }> }).skins ?? []
    for (const skin of skins) {
      for (const slot of Object.values(skin.attachments)) {
        for (const attachment of Object.values(slot)) {
          if (attachment.width != null && attachment.height != null) {
            sizes.push({ w: attachment.width, h: attachment.height })
          }
        }
      }
    }
    return sizes
  }

  it('缩放只缩小图集占位，region 附件 JSON 宽高保持原图尺寸', () => {
    useProjectStore.getState().setDocument(oneImageDocument(), null, false)
    const full = prepareRuntimeExport({ scale: 1, maxSize: 2048 })
    const half = prepareRuntimeExport({ scale: 0.5, maxSize: 2048 })

    // 图集区域随 scale 缩小（200×100 → 100×50）
    expect(full.atlas.regions).toHaveLength(1)
    expect(full.atlas.regions[0].width).toBe(200)
    expect(full.atlas.regions[0].height).toBe(100)
    expect(half.atlas.regions[0].width).toBe(100)
    expect(half.atlas.regions[0].height).toBe(50)

    // 单页纹理尺寸也跟着缩（trimPages 取内容上限的 2 的幂：256 → 128）
    expect(half.atlas.pages[0].width).toBeLessThan(full.atlas.pages[0].width)

    // Spine JSON 里 region 附件尺寸与 scale 无关 —— 图集缩小、附件尺寸不变，
    // 运行时靠 regionScale = width / 区域宽 把四边形拉回原大小，角色视觉不变。
    const fullJson = buildSpineJson(full.skeletons[0].asset, buildRegionLookup(full.atlas))
    const halfJson = buildSpineJson(half.skeletons[0].asset, buildRegionLookup(half.atlas))
    const fullSizes = spineAttachmentSizes(fullJson)
    const halfSizes = spineAttachmentSizes(halfJson)
    expect(fullSizes.length).toBeGreaterThan(0)
    expect(halfSizes).toEqual(fullSizes)
  })

  it('.atlas 文本的 size:/bounds: 反映缩放后的像素', () => {
    useProjectStore.getState().setDocument(oneImageDocument(), null, false)
    const half = prepareRuntimeExport({ scale: 0.5, maxSize: 2048 })
    const text = serializeSpineAtlas(half.atlas)
    const page = half.atlas.pages[0]
    const region = half.atlas.regions[0]
    expect(text).toContain(`size: ${page.width}, ${page.height}`)
    expect(text).toContain(`bounds: ${region.x}, ${region.y}, ${region.width}, ${region.height}`)
  })
})
