import { describe, expect, it } from 'vitest'
import { importSpine } from '@importers/spine'
import { RUNTIME_PPU } from '@core/codec/runtimeSkeJson'
import type { RuntimeAsset } from '@core/model/asset'
import type { SpineJson, SpineSkinJson } from '@importers/spineTypes'
import type { AtlasRegion } from '@importers/uv'
import { buildSpineJson } from '@editor/services/spineExport'
import type { SpineRegionLookup } from '@editor/services/spineExport'

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
