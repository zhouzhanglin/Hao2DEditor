import { describe, expect, it } from 'vitest'
import { importSpine } from '@importers/spine'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import type { RuntimeAsset } from '@core/model/asset'
import type { SpineJson, SpineSkinJson } from '@importers/spineTypes'
import type { AtlasRegion } from '@importers/uv'
import {
  buildSpineJson,
  collectRegionTrim,
  serializeSpineAtlas,
  spineAtlasRegionNames
} from '@editor/services/spineExport'
import type { SpineRegionLookup } from '@editor/services/spineExport'
import { createAttachmentData } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAtlasJson, RuntimeAtlasRegion } from '@core/codec/runtimeSkeJson'

/**
 * Spine 4.x 导出的两个易错点：
 * - IK 的 `bendPositive` 与编辑器运行期的 `bendSign` 符号是**反**的（若照符号直译，四条腿膝盖全反）；
 * - FFD 必须写进 4.2+ 的 `attachments.<skin>.<slot>.<attachment>.deform`，顶层的 `deform` 官方运行库整段不读。
 */

const IK_BONES = [
  { name: 'root' },
  { name: 'thigh', parent: 'root', length: 20 },
  { name: 'shin', parent: 'thigh', length: 20, x: 20 },
  { name: 'target', parent: 'root', x: 30, y: 0 }
]

function importJson(json: unknown): RuntimeAsset {
  return importSpine({ json: json as never, regions: [], pageSizes: {} }).asset
}

function ikSkeleton(bendPositive: boolean): unknown {
  return {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: IK_BONES,
    slots: [],
    skins: [{ name: 'default', attachments: {} }],
    ik: [{ name: 'leg', bones: ['thigh', 'shin'], target: 'target', bendPositive }],
    animations: {}
  }
}

describe('IK 弯曲方向的读入 / 导出', () => {
  it.each([true, false])('bendPositive=%s 原样写回（不做符号直译）', (bendPositive) => {
    const asset = importJson(ikSkeleton(bendPositive))
    const ik = buildSpineJson(asset).constraints?.find((c) => c.type === 'ik')
    expect(ik).toBeDefined()
    expect(ik?.bendPositive).toBe(bendPositive)
  })
})

/** 非加权网格：3 顶点，deform 只动中间那个（offset 是浮点数组下标） */
const MESH_UNWEIGHTED = {
  skeleton: { spine: '4.2.0', fps: 30 },
  bones: [{ name: 'root' }],
  slots: [{ name: 'arm', bone: 'root' }],
  skins: [
    {
      name: 'default',
      attachments: {
        arm: {
          arm: {
            type: 'mesh',
            vertices: [0, 0, 10, 0, 10, 10],
            uvs: [0, 0, 1, 0, 1, 1],
            triangles: [0, 1, 2]
          }
        }
      }
    }
  ],
  animations: {
    wave: { deform: { default: { arm: { arm: [{ time: 0, offset: 2, vertices: [5, 5] }] } } } }
  }
}

/** 加权网格：1 个顶点绑 2 根骨骼（Spine 的 json 里按「影响」展开） */
function weightedSkeleton(): unknown {
  return {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: [{ name: 'root' }, { name: 'tilt', parent: 'root', rotation: 90, length: 10 }],
    slots: [{ name: 'arm', bone: 'tilt' }],
    skins: [
      {
        name: 'default',
        attachments: {
          arm: {
            arm: {
              type: 'mesh',
              // [count, boneIndex, x, y, weight] × 顶点
              vertices: [2, 0, 0, 0, 0.5, 1, 0, 0, 0.5],
              uvs: [0, 0, 1, 0, 1, 1],
              triangles: [0, 1, 2]
            }
          }
        }
      }
    ],
    animations: {
      wave: { deform: { default: { arm: { arm: [{ time: 0, offset: 0, vertices: [3, 4] }] } } } }
    }
  }
}

/** 骨骼 bindpose 的线性部分（显示空间偏移 → 骨内偏移），与运行期 meshBuilder 一致 */
function toBoneSpace(asset: RuntimeAsset, bone: number, x: number, y: number): [number, number] {
  const o = bone * 16
  return [asset.bindposes[o] * x + asset.bindposes[o + 4] * y, asset.bindposes[o + 1] * x + asset.bindposes[o + 5] * y]
}

function deformFrames(json: SpineJson, anim: string, slot: string, attachment: string): number[][] {
  const timelines = json.animations?.[anim]?.attachments?.['default']?.[slot]?.[attachment]
  const frames = timelines?.deform as Array<{ vertices: number[] }> | undefined
  expect(frames, `${anim}.attachments.default.${slot}.${attachment}.deform 缺失`).toBeDefined()
  return (frames ?? []).map((f) => f.vertices)
}

describe('FFD 导出（Spine 4.2+ 的附件级 deform）', () => {
  it('写在 attachments 里，不再写顶层 deform', () => {
    const json = buildSpineJson(importJson(MESH_UNWEIGHTED))
    expect(json.animations?.wave?.deform).toBeUndefined()
    expect(json.animations?.wave?.attachments?.default?.arm?.arm).toBeDefined()
  })

  it('数组长度对齐附件顶点数，值 = 显示空间偏移 × PPU', () => {
    const json = buildSpineJson(importJson(MESH_UNWEIGHTED))
    const [vertices] = deformFrames(json, 'wave', 'arm', 'arm')
    expect(vertices).toHaveLength(6) // 3 顶点 × 2
    expect(vertices[2]).toBeCloseTo(5, 6)
    expect(vertices[3]).toBeCloseTo(5, 6)
    expect(vertices[0]).toBeCloseTo(0, 6)
  })

  it('加权网格按影响展开，并逐个换算到骨内空间', () => {
    const asset = importJson(weightedSkeleton())
    const json = buildSpineJson(asset)
    const [vertices] = deformFrames(json, 'wave', 'arm', 'arm')
    // 2 个影响 → 4 个数（不是按顶点 2 个）
    expect(vertices).toHaveLength(4)

    // 导入侧存的是显示空间偏移 (0.03, 0.04)，导出时按每根影响的 bindpose 换算
    const track = asset.animations[0].deforms[0]
    const [dx, dy] = [track.frames[0].offsets[0], track.frames[0].offsets[1]]
    const root = toBoneSpace(asset, 0, dx, dy)
    const tilt = toBoneSpace(asset, 1, dx, dy)
    expect(vertices[0]).toBeCloseTo(root[0] * RUNTIME_PPU, 6)
    expect(vertices[1]).toBeCloseTo(root[1] * RUNTIME_PPU, 6)
    expect(vertices[2]).toBeCloseTo(tilt[0] * RUNTIME_PPU, 6)
    expect(vertices[3]).toBeCloseTo(tilt[1] * RUNTIME_PPU, 6)
  })

  it('顶点数多于偏移长度时按 0 补齐（短数组不会拖垮下标）', () => {
    const json = buildSpineJson(importJson(MESH_UNWEIGHTED))
    const [vertices] = deformFrames(json, 'wave', 'arm', 'arm')
    // 未覆盖的顶点保持 0，长度仍等于顶点数×2
    expect(vertices.slice(4)).toEqual([0, 0])
  })

  it('导出物能被导入端读回（4.2+ 层级的往返）', () => {
    const exported = buildSpineJson(importJson(MESH_UNWEIGHTED))
    const back = importJson(exported)
    const track = back.animations[0]?.deforms[0]
    expect(track).toBeDefined()
    // 导出的是 5px 偏移（写进 json 时乘了 PPU），回来仍是 (0.05, 0.05)
    expect(track.frames[0].offsets[2]).toBeCloseTo(5 / RUNTIME_PPU, 6)
    expect(track.frames[0].offsets[3]).toBeCloseTo(5 / RUNTIME_PPU, 6)
  })
})

/**
 * 导出侧的 mesh `uvs` 必须是**区域相对**坐标（v=0 指向区域顶边）。
 *
 * 编辑器运行期一律存整页归一化 UV（v 左下原点，见 core/atlas/remap.ts 的约定），
 * 直接写进 Spine JSON 会让 Unity 用整页坐标去乘区域尺寸 —— 每个网格都取到错位的贴图块。
 * 这里用「导入（区域相对 → 整页）→ 导出（整页 → 区域相对）」的往返来钉住这一对互逆变换。
 */
describe('mesh uvs 导出为区域相对坐标', () => {
  const REGION: AtlasRegion = {
    name: 'leg',
    page: 'armature.png',
    x: 628,
    y: 370,
    width: 122,
    height: 203,
    rotate: 0,
    origWidth: 122,
    origHeight: 203,
    offsetX: 0,
    offsetY: 0
  }
  const PAGE_SIZES = { 'armature.png': { width: 1024, height: 1024 } }
  const RELATIVE_UVS = [0.5299, 0.0012, 0.5197, 0.0958]
  const lookup: SpineRegionLookup = {
    regions: new Map([[REGION.name, REGION]]),
    pageSizes: PAGE_SIZES
  }

  /** 导出的 skins 可能是「具名皮肤对象」（4.2+）或旧式数组，测试里统一按数组取 */
  function meshUvs(json: SpineJson): number[] {
    const skins = json.skins as SpineSkinJson[] | undefined
    return skins?.[0]?.attachments?.leg?.leg?.uvs ?? []
  }

  function meshSkeleton(): unknown {
    return {
      skeleton: { spine: '4.3.0', fps: 30 },
      bones: [{ name: 'root' }],
      slots: [{ name: 'leg', bone: 'root' }],
      skins: [
        {
          name: 'default',
          attachments: {
            leg: {
              leg: {
                type: 'mesh',
                path: 'leg',
                vertices: [0, 0, 10, 0, 10, 10, 0, 10],
                uvs: RELATIVE_UVS,
                triangles: [0, 1, 2, 0, 2, 3]
              }
            }
          }
        }
      ],
      animations: {}
    }
  }

  it('往返后与原 json 的区域相对 uvs 一致（而不是整页坐标）', () => {
    const asset = importSpine({
      json: meshSkeleton() as never,
      regions: [REGION],
      pageSizes: PAGE_SIZES
    }).asset
    const raw = meshUvs(buildSpineJson(asset))
    const uvs = meshUvs(buildSpineJson(asset, lookup))

    // 不带区域表时保持旧行为（整页 UV，v 已翻转）；一旦取到区域就必须是区域相对坐标
    expect(raw[0]).not.toBeCloseTo(RELATIVE_UVS[0], 4)
    expect(uvs).toHaveLength(RELATIVE_UVS.length)
    for (const [i, value] of RELATIVE_UVS.entries()) expect(uvs[i]).toBeCloseTo(value, 4)
  })

  it.each([90, 180, 270])('旋转 %i° 的区域同样可逆', (rotate) => {
    const region: AtlasRegion = { ...REGION, rotate }
    const asset = importSpine({
      json: meshSkeleton() as never,
      regions: [region],
      pageSizes: PAGE_SIZES
    }).asset
    const uvs = meshUvs(
      buildSpineJson(asset, {
        regions: new Map([[region.name, region]]),
        pageSizes: PAGE_SIZES
      })
    )
    for (const [i, value] of RELATIVE_UVS.entries()) expect(uvs[i]).toBeCloseTo(value, 4)
  })
})

/**
 * `.atlas` 文本要能被 spine-unity 直接吃下，三处是踩过的坑：
 * - 区域名以图片后缀结尾 → `SpineAtlasAsset.CreateRuntimeInstance` 按「行尾是图片后缀」找页，
 *   会把它当成新的一页，材质数与区域归属全乱；
 * - 老语法（`xy:` / `size:` / `orig:` / `offset:` / `index:`）该换成 4.2+ 的 `bounds:` / `offsets:`；
 * - DB 导入的工程把裁剪放在附件上，`.atlas` 不写 `offsets` 就丢裁剪，那几个 sprite 在 Unity 里偏几像素。
 */
function atlasFixture(): RuntimeAtlasJson {
  return {
    format: 'hao2d-atlas',
    version: 1,
    pages: [
      { image: 'Sheep_0.png', width: 1024, height: 512 },
      { image: 'Sheep_1.png', width: 256, height: 256 }
    ],
    regions: [
      { name: 'head', page: 0, x: 10, y: 20, width: 30, height: 40 },
      {
        name: 'beak',
        page: 0,
        x: 50,
        y: 60,
        width: 39,
        height: 14,
        origWidth: 73,
        origHeight: 53,
        offsetX: 24,
        offsetY: 5
      },
      { name: 'wing', page: 1, x: 1, y: 2, width: 8, height: 9, rotate: 90 }
    ]
  }
}

function renameRegions(atlas: RuntimeAtlasJson, names: Map<string, string>): RuntimeAtlasJson {
  return { ...atlas, regions: atlas.regions.map((r) => ({ ...r, name: names.get(r.name) ?? r.name })) }
}

describe('.atlas 文本对齐 4.2+ 语法', () => {
  it('写 bounds:/offsets:，不写 xy/size/orig/offset/index/全局 scale', () => {
    const text = serializeSpineAtlas(atlasFixture())
    expect(text).toBe(
      [
        'Sheep_0.png',
        '\tsize: 1024, 512',
        '\tfilter: Linear, Linear',
        'head',
        '\tbounds: 10, 20, 30, 40',
        'beak',
        '\tbounds: 50, 60, 39, 14',
        '\toffsets: 24, 5, 73, 53',
        '',
        'Sheep_1.png',
        '\tsize: 256, 256',
        '\tfilter: Linear, Linear',
        'wing',
        '\tbounds: 1, 2, 8, 9',
        '\trotate: 90',
        ''
      ].join('\n')
    )
    expect(text).not.toMatch(/\torig:/)
    expect(text).not.toMatch(/\toffset:/)
    expect(text).not.toMatch(/\tindex:/)
    expect(text).not.toMatch(/^scale:/m)
    expect(text).not.toMatch(/rotate: true/)
  })

  it('页之间留空行（Spine 靠空行切页，缺了第二页页名会变成上一页的区域名）', () => {
    const lines = serializeSpineAtlas(atlasFixture()).split('\n')
    expect(lines[lines.indexOf('Sheep_1.png') - 1]).toBe('')
  })

  it('区域名去掉图片后缀，重名时加序号（页名保持原样）', () => {
    const atlas = atlasFixture()
    atlas.regions.push({ name: 'Sheep_0.png', page: 0, x: 0, y: 0, width: 1024, height: 512 })
    atlas.regions.push({ name: 'head.PNG', page: 0, x: 1, y: 1, width: 2, height: 2 })
    const names = spineAtlasRegionNames(atlas)
    expect(names.get('Sheep_0.png')).toBe('Sheep_0')
    expect(names.get('head.PNG')).toBe('head_1')
    expect(names.has('head')).toBe(false)

    const text = serializeSpineAtlas(renameRegions(atlas, names))
    // 只有真正的图集页名才以 .png 结尾
    expect(text.split('\n').filter((line) => /\.png$/i.test(line))).toEqual(['Sheep_0.png', 'Sheep_1.png'])
    expect(text).toContain('Sheep_0\n\tbounds: 0, 0, 1024, 512')
  })

  it('附件 path 跟着区域改名（查表仍用原名）', () => {
    const att = createAttachmentData({ name: 'head', size: { x: 0.3, y: 0.4 }, textureName: 'head.PNG' })
    const asset = createRuntimeAsset({
      skins: [{ name: 'default', slots: [{ slotName: 'head', attachments: [att] }] }]
    })
    const lookup: SpineRegionLookup = {
      regions: new Map([
        [
          'head.PNG',
          {
            name: 'head.PNG',
            page: 'Sheep_0.png',
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            rotate: 0,
            origWidth: 30,
            origHeight: 40,
            offsetX: 0,
            offsetY: 0
          }
        ]
      ]),
      pageSizes: { 'Sheep_0.png': { width: 1024, height: 512 } },
      names: new Map([['head.PNG', 'head']])
    }
    const json = buildSpineJson(asset, lookup)
    const skins = json.skins as SpineSkinJson[]
    expect(skins[0].attachments?.head?.head?.path).toBe('head')
  })
})

describe('DB 附件上的裁剪回填进 .atlas', () => {
  // 取自 DragonBones 的 Rooster 下嘴：帧 73×53 / 区域 39×14 / frameX=-24, frameY=-34
  const REGION: RuntimeAtlasRegion = { name: 'beak_lower', page: 0, x: 50, y: 60, width: 39, height: 14 }

  function atlasWith(region: RuntimeAtlasRegion): RuntimeAtlasJson {
    return {
      format: 'hao2d-atlas',
      version: 1,
      pages: [{ image: 'Rooster_Ani_tex.png', width: 1024, height: 1024 }],
      regions: [region]
    }
  }

  function assetWith(...attachments: ReturnType<typeof createAttachmentData>[]) {
    return createRuntimeAsset({
      skins: [{ name: 'default', slots: [{ slotName: 'beak_lower', attachments }] }]
    })
  }

  /** DB 导入的形态：size = 裁剪后尺寸，frameSize = 原图尺寸，contentOffset = 内容中心相对原图中心 */
  function dbAttachment(partial: Partial<ReturnType<typeof createAttachmentData>> = {}) {
    return createAttachmentData({
      name: 'beak_lower',
      textureName: 'beak_lower',
      size: { x: 0.39, y: 0.14 },
      frameSize: { x: 0.73, y: 0.53 },
      contentOffset: { x: 0.07, y: -0.145 },
      ...partial
    })
  }

  it('按官方 ComputeUVs 反解 offsets（offsetY 是距原图底边，不是距顶边）', () => {
    const { trim, conflicts } = collectRegionTrim(assetWith(dbAttachment()), atlasWith(REGION))
    expect(conflicts).toEqual([])
    expect(trim.get('beak_lower')).toEqual({ origWidth: 73, origHeight: 53, offsetX: 24, offsetY: 5 })
  })

  it('区域自带裁剪时以区域为准（Spine 图集导入的工程不回推）', () => {
    const trimmed = { ...REGION, origWidth: 73, origHeight: 53, offsetX: 24, offsetY: 5 }
    expect(collectRegionTrim(assetWith(dbAttachment()), atlasWith(trimmed)).trim.size).toBe(0)
  })

  it('区域尺寸与附件对不上（倍率导出 / 重新打包）时不回推', () => {
    const scaled = { ...REGION, width: 20, height: 7 }
    expect(collectRegionTrim(assetWith(dbAttachment()), atlasWith(scaled)).trim.size).toBe(0)
  })

  it('没裁剪的附件不回推', () => {
    const flat = dbAttachment({ frameSize: { x: 0.39, y: 0.14 }, contentOffset: { x: 0, y: 0 } })
    expect(collectRegionTrim(assetWith(flat), atlasWith(REGION)).trim.size).toBe(0)
  })

  it('同一块区域被不同裁剪引用时报冲突，宁可不写', () => {
    const other = dbAttachment({ name: 'beak_lower_2', contentOffset: { x: 0.1, y: -0.145 } })
    const { trim, conflicts } = collectRegionTrim(assetWith(dbAttachment(), other), atlasWith(REGION))
    expect(conflicts).toEqual(['beak_lower'])
    expect(trim.size).toBe(0)
  })

  it('裁剪过的附件在 json 里写原图尺寸（否则 Spine 的 regionScale 会把内容缩小一圈）', () => {
    const json = buildSpineJson(assetWith(dbAttachment()))
    const skins = json.skins as SpineSkinJson[]
    const written = skins[0].attachments?.beak_lower?.beak_lower
    expect(written?.width).toBe(73)
    expect(written?.height).toBe(53)

    // 没裁剪的附件仍是区域尺寸
    const plain = buildSpineJson(
      assetWith(dbAttachment({ frameSize: { x: 0, y: 0 }, contentOffset: { x: 0, y: 0 } }))
    )
    const plainSkins = plain.skins as SpineSkinJson[]
    expect(plainSkins[0].attachments?.beak_lower?.beak_lower?.width).toBe(39)
  })
})
