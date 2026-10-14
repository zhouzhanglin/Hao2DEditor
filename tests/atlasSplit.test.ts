import { describe, expect, it } from 'vitest'
import { createAuthoringAttachment, createEmptyDocument } from '@core/model/authoring'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { applyAtlasSplit } from '@editor/commands/authoringCommands'
import type { AtlasSplitPlan } from '@editor/commands/authoringCommands'
import { cropMatrix } from '@editor/services/pngEncoder'
import { mapRegionRelativeUvs, pageUvsToRegionRelative, regionUvs } from '@importers/uv'
import type { AtlasRegion, PageSizes } from '@importers/uv'

/**
 * 图集拆碎图。
 *
 * 页 512×256：`head` 是没裁剪的正块，`tail` 是转了 90° 存放的块
 * （90° 时页里占位宽高互换：x..x+height / y..y+width）。
 */
const PAGE: PageSizes = { 'sheet.png': { width: 512, height: 256 } }
const HEAD: AtlasRegion = {
  name: 'head',
  page: 'sheet.png',
  x: 10,
  y: 20,
  width: 100,
  height: 60,
  rotate: 0,
  origWidth: 120,
  origHeight: 80,
  offsetX: 5,
  offsetY: 6
}
const TAIL: AtlasRegion = {
  name: 'tail',
  page: 'sheet.png',
  x: 200,
  y: 30,
  width: 80,
  height: 40,
  rotate: 90,
  origWidth: 80,
  origHeight: 40,
  offsetX: 0,
  offsetY: 0
}

const SPLIT_IMAGES: AuthoringImage[] = [
  { name: 'head.png', path: '/art/sheet_split/head.png', width: 100, height: 60, loose: true },
  { name: 'tail.png', path: '/art/sheet_split/tail.png', width: 80, height: 40, loose: true }
]

function plan(extra: AtlasSplitPlan['entries'] = []): AtlasSplitPlan {
  return {
    atlas: 'sheet.png',
    pageWidth: 512,
    pageHeight: 256,
    entries: [
      { region: 'head', image: 'head.png', x: 10, y: 20, width: 100, height: 60, rotate: 0 },
      { region: 'tail', image: 'tail.png', x: 200, y: 30, width: 80, height: 40, rotate: 90 },
      ...extra
    ]
  }
}

/** 两个附件引用图集的子区域，一个引用别的碎图（不该被动到） */
function atlasDocument(): EditorDocument {
  const doc = createEmptyDocument()
  doc.images = [
    {
      name: 'sheet.png',
      path: '/art/sheet.png',
      width: 512,
      height: 256,
      loose: false,
      regions: [HEAD, TAIL].map(({ page, ...region }) => region)
    },
    { name: 'other.png', path: '/art/other.png', width: 16, height: 16, loose: true }
  ]

  const head = createAuthoringAttachment({
    name: 'head',
    image: 'sheet.png',
    regionName: 'head',
    size: { x: 1, y: 0.6 },
    // 裁剪过的图：框比内容大，内容相对原图中心有偏移 —— 拆图后这两个值都不该变
    frameSize: { x: 1.2, y: 0.8 },
    contentOffset: { x: 0.05, y: -0.06 },
    uvs: Array.from(regionUvs(HEAD, PAGE))
  })
  const tail = createAuthoringAttachment({
    name: 'tail',
    image: 'sheet.png',
    regionName: 'tail',
    size: { x: 0.8, y: 0.4 },
    uvs: Array.from(regionUvs(TAIL, PAGE))
  })
  const other = createAuthoringAttachment({
    name: 'other',
    image: 'other.png',
    uvs: [0, 0, 1, 0, 1, 1, 0, 1]
  })

  doc.skins[0].slots.push({ slot: 'head', attachments: [head] })
  // 另一个皮肤里也放一份引用：拆的时候要一起改
  doc.skins.push({ name: 'alt', slots: [{ slot: 'head', attachments: [tail] }] })
  doc.skins[0].slots.push({ slot: 'other', attachments: [other] })
  return doc
}

const fullQuad = [0, 0, 1, 0, 1, 1, 0, 1]

describe('图集拆碎图（文档侧）', () => {
  it('附件改指碎图，UV 换算成「整张碎图」的四角', () => {
    const doc = atlasDocument()
    const repointed = applyAtlasSplit(doc, plan(), SPLIT_IMAGES)

    expect(repointed).toBe(2)
    const head = doc.skins[0].slots[0].attachments[0]
    const tail = doc.skins[1].slots[0].attachments[0]
    expect(head.image).toBe('head.png')
    expect(tail.image).toBe('tail.png')

    // 区域自己的四角落到碎图上就是整张图（旋转的区域也一样：碎图已经转正了）
    head.uvs.forEach((value, index) => expect(value).toBeCloseTo(fullQuad[index], 5))
    tail.uvs.forEach((value, index) => expect(value).toBeCloseTo(fullQuad[index], 5))
  })

  it('只换贴图：尺寸 / 裁剪框 / 内容偏移 / 顶点原样保留', () => {
    const doc = atlasDocument()
    const head = doc.skins[0].slots[0].attachments[0]
    const before = {
      size: { ...head.size },
      frameSize: { ...head.frameSize },
      contentOffset: { ...head.contentOffset },
      position: { ...head.position },
      vertices: head.vertices.length
    }

    applyAtlasSplit(doc, plan(), SPLIT_IMAGES)

    expect(head.size).toEqual(before.size)
    expect(head.frameSize).toEqual(before.frameSize)
    expect(head.contentOffset).toEqual(before.contentOffset)
    expect(head.position).toEqual(before.position)
    expect(head.vertices.length).toBe(before.vertices)
  })

  it('区域名换成碎图名：碎图导出时会被重新打包，sprite 名要跟图名一致', () => {
    const doc = atlasDocument()
    applyAtlasSplit(doc, plan(), SPLIT_IMAGES)
    expect(doc.skins[0].slots[0].attachments[0].regionName).toBe('head.png')
    expect(doc.skins[1].slots[0].attachments[0].regionName).toBe('tail.png')
  })

  it('图集从图片池消失，碎图进来；没引用图集的附件不动', () => {
    const doc = atlasDocument()
    applyAtlasSplit(doc, plan(), SPLIT_IMAGES)

    expect(doc.images.map((image) => image.name)).toEqual(['other.png', 'head.png', 'tail.png'])
    expect(doc.images.find((image) => image.name === 'head.png')?.loose).toBe(true)
    // 其他图的附件一点没动
    const other = doc.skins[0].slots[1].attachments[0]
    expect(other.image).toBe('other.png')
    expect(Array.from(other.uvs)).toEqual(fullQuad)
  })

  it('区域名对不上：落到「整页」兜底上，UV 与原样一致（画面不变）', () => {
    const doc = atlasDocument()
    const attachment = doc.skins[0].slots[0].attachments[0]
    attachment.regionName = 'gone'
    const before = Array.from(attachment.uvs)

    const images: AuthoringImage[] = [
      { name: 'sheet_page.png', path: '/art/sheet_split/sheet_page.png', width: 512, height: 256, loose: true }
    ]
    const withFallback = plan([
      { region: 'sheet.png', image: 'sheet_page.png', x: 0, y: 0, width: 512, height: 256, rotate: 0 }
    ])
    applyAtlasSplit(doc, withFallback, images)

    expect(attachment.image).toBe('sheet_page.png')
    // 整页碎图 = 原页拷贝，UV 不该有任何变化
    Array.from(attachment.uvs).forEach((value, index) => expect(value).toBeCloseTo(before[index], 5))
  })
})

describe('碎图裁剪与 UV 换算互为逆运算', () => {
  /** 区域在页里占的块尺寸：90°/270° 宽高互换 */
  const blockOf = (region: AtlasRegion): { bw: number; bh: number } =>
    region.rotate % 180 === 0
      ? { bw: region.width, bh: region.height }
      : { bw: region.height, bh: region.width }

  for (const rotate of [0, 90, 180, 270]) {
    it(`rotate=${rotate}：块里的每个像素裁到碎图后，UV 指回页里的同一个像素`, () => {
      const region: AtlasRegion = {
        name: 'r',
        page: 'sheet.png',
        x: 40,
        y: 24,
        width: 32,
        height: 20,
        rotate,
        origWidth: 32,
        origHeight: 20,
        offsetX: 0,
        offsetY: 0
      }
      const { bw, bh } = blockOf(region)
      const [a, b, c, d, e, f] = cropMatrix(rotate, region.width, region.height)
      const samples: Array<[number, number]> = [
        [0, 0],
        [bw - 1, 0],
        [0, bh - 1],
        [bw - 1, bh - 1],
        [Math.floor(bw / 2), Math.floor(bh / 2)]
      ]

      for (const [x, y] of samples) {
        // 源图里这一块的像素中心 → 碎图里的像素中心（canvas 变换口径，v 向下）
        const u = a * (x + 0.5) + c * (y + 0.5) + e
        const v = b * (x + 0.5) + d * (y + 0.5) + f
        // 碎图 UV（v 左下原点，`applyAtlasSplit` 算出来的就是它）→ 区域相对 UV（relV 向下）
        const splitV = 1 - v / region.height
        const relU = u / region.width
        const relV = 1 - splitV
        const mapped = mapRegionRelativeUvs([relU, relV], region, PAGE)

        // 应当正好回到源像素中心对应的整页 UV
        expect(mapped[0]).toBeCloseTo((region.x + x + 0.5) / PAGE['sheet.png'].width, 5)
        expect(mapped[1]).toBeCloseTo(1 - (region.y + y + 0.5) / PAGE['sheet.png'].height, 5)
      }
    })
  }

  it('pageUvsToRegionRelative 与 regionUvs 互为逆运算（拆图换算就靠它）', () => {
    for (const region of [HEAD, TAIL]) {
      const page = regionUvs(region, PAGE)
      const back = pageUvsToRegionRelative(page, region, PAGE)
      // 四角顺序：左下 → 右下 → 右上 → 左上（内容相对 UV：relV 向下）
      const expected = [0, 1, 1, 1, 1, 0, 0, 0]
      Array.from(back).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5))
    }
  })
})
