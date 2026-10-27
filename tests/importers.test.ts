import { describe, expect, it } from 'vitest'
import { importSpine } from '@importers/spine'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { mapRegionRelativeUvs, regionUvs } from '@importers/uv'
import type { AtlasRegion } from '@importers/uv'
import { MAX_ANGLE_SPAN, bakeSpineAnimations, markSteppedScalar, markSteppedVec2, simplifyScalar, simplifyVec2, wrapRotateKeys } from '@importers/spineBake'
import { buildRuntimeMaps } from '@core/model/asset'
import { expandDrawOrder, importDragonBones } from '@importers/dragonBones'
import { dbTextureNames, parseDbTextureJson } from '@importers/dragonBonesAtlas'
import { detectSkeletonFormat, isDbTextureJson, looksLikeSpineAtlasText } from '@importers/detect'
import { registerLooseImages } from '@importers/looseImages'
import { AttachmentType, BlendMode } from '@core/model/types'
import { Easing } from '@core/model/animation'

const SPINE_ATLAS = `hero.png
size: 256,256
filter: Linear,Linear
body
  xy: 0, 0
  size: 100, 100
  orig: 100, 100
  offset: 0, 0
hand
  xy: 100, 0
  size: 40, 40
  orig: 40, 40
  offset: 0, 0
rotated
  rotate: true
  xy: 200, 0
  size: 20, 30
  orig: 30, 20
  offset: 0, 0
`

const SPINE_JSON = {
  skeleton: { spine: '4.1.0', fps: 30 },
  bones: [
    { name: 'root' },
    { name: 'arm', parent: 'root', length: 50, x: 50, y: 0 }
  ],
  slots: [
    { name: 'body', bone: 'root', attachment: 'body' },
    { name: 'hand', bone: 'arm', blend: 'add' }
  ],
  skins: [
    {
      name: 'default',
      attachments: {
        body: { body: { type: 'region', width: 100, height: 100 } },
        hand: {
          hand: { type: 'region', width: 40, height: 40 },
          handMesh: {
            type: 'mesh',
            width: 40,
            height: 40,
            uvs: [0, 1, 1, 1, 0.5, 0],
            vertices: [-20, -20, 20, -20, 0, 20],
            triangles: [0, 1, 2]
          }
        }
      }
    }
  ],
  ik: [{ name: 'armIK', bones: ['root', 'arm'], target: 'arm', mix: 0.5, bendPositive: false }],
  animations: {
    idle: {
      bones: {
        arm: {
          rotate: [
            // curve 是「本帧 → 下一帧」的缓动，控制点是 (时间, 值) 空间的**绝对坐标**
            { time: 0, angle: 0, curve: [0.42, 0, 0.58, 1] },
            { time: 1, angle: 90 }
          ],
          translate: [{ time: 0, x: 0, y: 0 }]
        }
      },
      slots: { hand: { attachment: [{ time: 0, name: 'handMesh' }] } },
      events: [{ time: 0.5, name: 'roar', int: 3, string: 's' }],
      drawOrder: [{ time: 0, offsets: [{ slot: 'hand', offset: -1 }] }]
    }
  }
}

describe('DragonBones 蒙皮网格权重', () => {
  /**
   * 权重段结构：[骨骼数, (骨骼下标, 权重) × 骨骼数] —— 每组占 1 + 2×count 个数。
   * 顶点 0 绑 1 根、顶点 1 绑 2 根（错位触发点）、顶点 2 绑 1 根、顶点 3 绑 1 根。
   */
  const DB_MESH = {
    armature: [
      {
        name: 'test',
        frameRate: 24,
        bone: [{ name: 'root' }, { name: 'arm', parent: 'root', transform: { x: 50, y: 0 } }],
        slot: [{ name: 'body', parent: 'root' }],
        skin: [
          {
            name: 'default',
            slot: [
              {
                name: 'body',
                display: [
                  {
                    name: 'mesh',
                    type: 'mesh',
                    width: 100,
                    height: 100,
                    vertices: [0, 0, 50, 0, 100, 0, 0, 50],
                    uvs: [0, 1, 0.5, 1, 1, 1, 0, 0.5],
                    triangles: [0, 1, 2, 0, 2, 3],
                    weights: [1, 0, 1, 2, 0, 0.7, 1, 0.3, 1, 1, 1, 1, 0, 1],
                    slotPose: [1, 0, 0, 1, 0, 0]
                  }
                ]
              }
            ]
          }
        ],
        animation: []
      }
    ]
  }

  it('绑多根骨骼的顶点不会让后续顶点整体错位', () => {
    const { asset } = importDragonBones({ json: DB_MESH, subTextures: [], pageSizes: {} })
    const mesh = asset.skins[0].slots[0].attachments[0]
    expect(mesh.type).toBe(AttachmentType.Mesh)
    expect(mesh.weights).toHaveLength(4)

    // 顶点 0：只绑 root
    expect(mesh.weights[0].b0).toBe(0)
    expect(mesh.weights[0].w0).toBeCloseTo(1, 5)

    // 顶点 1：root 0.7 + arm 0.3（早先按固定 3 个数推进时，这里会从错位的数据里取骨骼）
    expect(mesh.weights[1].b0).toBe(0)
    expect(mesh.weights[1].w0).toBeCloseTo(0.7, 5)
    expect(mesh.weights[1].b1).toBe(1)
    expect(mesh.weights[1].w1).toBeCloseTo(0.3, 5)

    // 顶点 2：只绑 arm —— 错位时它会拿到别的骨骼，权重也不是 1
    expect(mesh.weights[2].b0).toBe(1)
    expect(mesh.weights[2].w0).toBeCloseTo(1, 5)

    // 顶点 3：回到 root
    expect(mesh.weights[3].b0).toBe(0)
    expect(mesh.weights[3].w0).toBeCloseTo(1, 5)
  })
})

describe('DragonBones 裁剪区域（trim）：Region 按图集区域 1:1 显示', () => {
  /*
   * 数据取自 Rooster 的 beak_lower：区域 39×14 塞在 73×53 的逻辑帧里，
   * frameX/Y = -24/-34（= 左/上裁剪量取反），显示变换来自 skin 里的 transform。
   *
   * 三件事各归各位：
   * - `size`（渲染四边形）= **图集区域** 39×14；用 frame 尺寸会把裁掉的部分一起拉长；
   * - `frameSize`（编辑器画框）= 原图 73×53，于是框包含被裁掉的空白；
   * - `contentOffset` = 裁剪块中心相对原图中心的位移，**在附件自身坐标轴里** ——
   *   加进 `position` 会被骨骼的旋转带偏（Rooster 的下嘴因此跑到上嘴上方）。
   */
  const DB_TRIM = {
    frameRate: 24,
    name: 'trim',
    armature: [
      {
        type: 'Armature',
        bone: [{ name: 'root' }],
        slot: [{ name: 'beak_lower', parent: 'root' }],
        skin: [
          {
            name: '',
            slot: [
              {
                name: 'beak_lower',
                display: [
                  {
                    type: 'image',
                    name: 'beak_lower',
                    transform: { x: 26.0849, y: 12.9644, skX: 167, skY: 167 }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }

  const SUB_TEXTURES = [
    {
      name: 'beak_lower',
      path: 'beak_lower',
      textureName: 'p.png',
      x: 293,
      y: 310,
      width: 39,
      height: 14,
      frameX: -24,
      frameY: -34,
      frameWidth: 73,
      frameHeight: 53,
      textureWidth: 512,
      textureHeight: 1024
    }
  ]

  it('尺寸取图集区域、位置补裁剪中心偏移、旋转取反', () => {
    const { asset } = importDragonBones({
      json: DB_TRIM as never,
      subTextures: SUB_TEXTURES,
      pageSizes: { 'p.png': { width: 512, height: 1024 } }
    })
    const att = asset.skins[0].slots[0].attachments[0]

    // 尺寸 = 图集区域 39×14（此前误用 frame 尺寸 73×53，内容被整体拉长）
    expect(att.size.x).toBeCloseTo(0.39, 6)
    expect(att.size.y).toBeCloseTo(0.14, 6)

    // 位置 = **显示变换本身**（= 原图中心）；裁剪块的位置不在这里，见 contentOffset
    expect(att.position.x).toBeCloseTo(0.260849, 6)
    expect(att.position.y).toBeCloseTo(-0.129644, 6)

    // 旋转 = -skX（y-down → y-up 取反）
    expect(att.rotation).toBeCloseTo(-167, 6)

    // 原图（含裁剪留白）：编辑器画框 / 变换手柄按它走，于是框包含被裁掉的空白
    expect(att.frameSize.x).toBeCloseTo(0.73, 6)
    expect(att.frameSize.y).toBeCloseTo(0.53, 6)

    // 内容中心相对原图中心的位移 = 裁剪中心偏移，**在附件自身坐标轴里**（渲染时在局部叠加）
    expect(att.contentOffset.x).toBeCloseTo(0.07, 6)
    expect(att.contentOffset.y).toBeCloseTo(-0.145, 6)

    // UV 覆盖区域本身：左下角 (293, 310+14) → (x/tw, 1 - y/th)
    expect(att.uvs[0]).toBeCloseTo(293 / 512, 6)
    expect(att.uvs[1]).toBeCloseTo(1 - 324 / 1024, 6)
  })
})

describe('DragonBones 5.x 动画通道与网格 UV', () => {
  const DB_ANIM = {
    armature: [
      {
        name: 'test',
        frameRate: 30,
        bone: [{ name: 'root' }],
        slot: [{ name: 'body', parent: 'root' }],
        skin: [
          {
            name: 'default',
            slot: [
              {
                name: 'body',
                display: [
                  {
                    name: 'mesh',
                    type: 'mesh',
                    width: 100,
                    height: 100,
                    vertices: [0, 0, 100, 0, 0, 100],
                    uvs: [0, 0, 1, 0, 0, 1],
                    triangles: [0, 1, 2]
                  }
                ]
              }
            ]
          }
        ],
        animation: [
          {
            name: 'stand',
            duration: 30,
            playTimes: 0,
            bone: [
              {
                name: 'root',
                // 每帧的 duration = 这一帧持续多少帧；缺省的分量表示「增量为 0」（保持 setup）
                translateFrame: [{ duration: 8 }, { duration: 7, x: 10, y: -20 }, { duration: 15 }],
                rotateFrame: [{ duration: 8 }, { duration: 7, rotate: 90 }, { duration: 15 }]
              }
            ],
            ffd: []
          }
        ]
      }
    ]
  }

  const SUB_TEXTURES = [
    {
      name: 'mesh',
      // DB 的子区域 path 通常为空（等于 name）；类型里是必填
      path: '',
      textureName: 'p.png',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      textureWidth: 100,
      textureHeight: 100,
      frameWidth: 0,
      frameHeight: 0,
      frameX: 0,
      frameY: 0
    }
  ]

  it('拆通道的骨骼动画：每帧都成关键帧、缺省帧保持 setup、缓动是线性', () => {
    const { asset } = importDragonBones({
      json: DB_ANIM,
      subTextures: SUB_TEXTURES,
      pageSizes: { 'p.png': { width: 100, height: 100 } }
    })
    const anim = asset.animations[0]
    expect(anim.bones).toHaveLength(1)
    const track = anim.bones[0]

    // 三帧 translateFrame → 三个关键帧（含"没给值"的帧），时间按 duration 累加；
    // 末尾的 1.0 是循环闭合帧（playTimes=0 时补首帧值，与参考实现一致）
    expect(track.translate.map((key) => Number(key.time.toFixed(4)))).toEqual([0, 0.2667, 0.5, 1])
    expect(track.translate[0].value.x).toBeCloseTo(0, 6)
    expect(track.translate[0].value.y).toBeCloseTo(0, 6)
    // 增量：x = 10px / 100 = 0.1；y = -(-20px) / 100 = 0.2（y 轴翻转）
    expect(track.translate[1].value.x).toBeCloseTo(0.1, 6)
    expect(track.translate[1].value.y).toBeCloseTo(0.2, 6)
    expect(track.rotate[1].value).toBeCloseTo(-90, 6)

    // 关键回归：tweenEasing 缺省 = **线性补间**（早先误当成阶跃，动画每段都会瞬间跳变）
    for (const key of track.translate) expect(key.easing).toBe(Easing.Linear)
    for (const key of track.rotate) expect(key.easing).toBe(Easing.Linear)
  })

  it('网格 UV：DB 的 v=0 指向区域顶边，映射后不该再翻一次', () => {
    const { asset } = importDragonBones({
      json: DB_ANIM,
      subTextures: SUB_TEXTURES,
      pageSizes: { 'p.png': { width: 100, height: 100 } }
    })
    const mesh = asset.skins[0].slots[0].attachments[0]
    expect(mesh.type).toBe(AttachmentType.Mesh)
    // 顶点 1 的 DB uv = (1, 0)（区域右上）→ 图集 uv = (50/100, 1 - 0/100) = (0.5, 1)
    expect(mesh.uvs[2]).toBeCloseTo(0.5, 6)
    expect(mesh.uvs[3]).toBeCloseTo(1, 6)
    // 顶点 2 的 DB uv = (0, 1)（区域左下）→ (0, 1 - 50/100) = (0, 0.5)
    expect(mesh.uvs[5]).toBeCloseTo(0.5, 6)
  })
})

describe('Spine 导入：图集 bounds / 加权网格 / 曲线归一化', () => {
  const ATLAS = ['spine.png', '\tsize: 1024, 1024', 'body', '\tbounds: 978, 865, 36, 34', ''].join('\n')

  it('atlas 的 bounds 是 x, y, 宽, 高（不是 x1,y1,x2,y2）', () => {
    const { regions } = parseSpineAtlas(ATLAS)
    expect(regions).toHaveLength(1)
    const r = regions[0]
    expect(r.x).toBe(978)
    expect(r.y).toBe(865)
    expect(r.width).toBe(36)
    expect(r.height).toBe(34)
    // 早先按 x1,y1,x2,y2 解析会得到 36-978 = -942
    expect(r.width).toBeGreaterThan(0)
    expect(r.origWidth).toBe(36)
  })

  it('加权网格：数据在 vertices 里（Spine 没有 weights 字段），逐顶点解析骨骼权重', () => {
    const json = {
      skeleton: { spine: '4.1.0' },
      bones: [{ name: 'root' }, { name: 'arm' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [
        {
          name: 'default',
          attachments: {
            slot: {
              mesh: {
                type: 'mesh',
                width: 100,
                height: 100,
                // 每顶点：count, (bone, x, y, w) × count —— 长度与 uvs 不等即加权
                vertices: [2, 0, 10, 20, 0.8, 1, 30, 40, 0.2, 1, 1, 50, 60, 1],
                uvs: [0, 0, 1, 1],
                triangles: [0, 1, 0]
              }
            }
          }
        }
      ]
    }
    const { asset } = importSpine({
      json: json as never,
      regions: [],
      pageSizes: { 'spine.png': { width: 1024, height: 1024 } }
    })
    const mesh = asset.skins[0].slots[0].attachments[0]
    expect(mesh.weights).toHaveLength(2)
    expect(mesh.weights[0].b0).toBe(0)
    expect(mesh.weights[0].b1).toBe(1)
    expect(mesh.weights[0].w0).toBeCloseTo(0.8, 5)
    expect(mesh.weights[0].w1).toBeCloseTo(0.2, 5)
    // 骨骼局部坐标（像素 → 世界单位）
    expect(mesh.weights[0].lx0).toBeCloseTo(0.1, 5)
    expect(mesh.weights[0].ly0).toBeCloseTo(0.2, 5)
  })

  it('首帧缺省 time 视为 0（Spine 导出时第一帧通常不写 time）', () => {
    const json = {
      skeleton: { spine: '4.1.0' },
      bones: [{ name: 'root' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      animations: {
        idle: {
          bones: {
            root: {
              rotate: [{ angle: 0 }, { time: 1, angle: 90 }],
              translate: [{ x: 0, y: 0 }, { time: 1, x: 100, y: 0 }]
            }
          }
        }
      }
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const track = asset.animations[0].bones[0]
    expect(track.rotate[0].time).toBe(0)
    expect(track.translate[0].time).toBe(0)
    expect(track.rotate[1].time).toBeCloseTo(1, 6)
    expect(track.translate[1].time).toBeCloseTo(1, 6)
    // 时间不该是 undefined/NaN，缓动归一化也就不会被污染
    for (const key of track.rotate) expect(Number.isFinite(key.time)).toBe(true)
  })

  it('动画 curve 是 (时间,值) 绝对坐标：归一化成 0..1 的贝塞尔控制点', () => {
    const json = {
      skeleton: { spine: '4.1.0' },
      bones: [{ name: 'root' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      animations: {
        walk: {
          bones: {
            root: {
              translate: [
                // 控制点是绝对坐标：x 通道 (0.01, 10)(0.02, 20)、y 通道 (0.011, 11)(0.022, 22)
                { time: 0, x: 0, y: 0, curve: [0.01, 10, 0.02, 20, 0.011, 11, 0.022, 22] },
                { time: 1, x: 100, y: 50 }
              ]
            }
          }
        }
      }
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const key = asset.animations[0].bones[0].translate[0]
    expect(key.easing).toBe(Easing.Bezier)
    // 归一化：(0.01-0)/1、(10-0)/100、(0.02-0)/1、(20-0)/100
    expect(key.curve![0]).toBeCloseTo(0.01, 5)
    expect(key.curve![1]).toBeCloseTo(0.1, 5)
    expect(key.curve![2]).toBeCloseTo(0.02, 5)
    expect(key.curve![3]).toBeCloseTo(0.2, 5)
    // 关键回归：绝不能把绝对值（10 / 20）当成归一化控制点 —— 那会让插值爆炸
    for (const v of key.curve!) expect(Math.abs(v)).toBeLessThanOrEqual(1)
  })
})

describe('Spine 图集解析', () => {
  it('解析页尺寸与区域字段', () => {
    const { regions, pageSizes, warnings } = parseSpineAtlas(SPINE_ATLAS)
    expect(warnings).toEqual([])
    expect(pageSizes['hero.png']).toEqual({ width: 256, height: 256 })
    expect(regions).toHaveLength(3)
    const body = regions[0]
    expect(body.name).toBe('body')
    expect(body.page).toBe('hero.png')
    expect([body.x, body.y, body.width, body.height]).toEqual([0, 0, 100, 100])
    expect([body.origWidth, body.origHeight]).toEqual([100, 100])
  })

  it('rotate: true 解析为 90 度', () => {
    const { regions } = parseSpineAtlas(SPINE_ATLAS)
    const rotated = regions.find((r) => r.name === 'rotated')
    expect(rotated?.rotate).toBe(90)
    expect(rotated?.origWidth).toBe(30)
    expect(rotated?.origHeight).toBe(20)
  })
})

describe('Spine 烘焙后处理：阶跃还原与关键帧简化', () => {
  it('共线的中间帧被删掉（保留首尾），拐点必须保留', () => {
    const straight = [0, 0.5, 1, 1.5, 2].map((t) => ({ time: t, x: t, y: 0 }))
    expect(simplifyVec2(straight, 1e-4)).toHaveLength(2)

    const bent = [
      { time: 0, x: 0, y: 0 },
      { time: 1, x: 1, y: 0 },
      { time: 2, x: 1, y: 1 }
    ]
    expect(simplifyVec2(bent, 1e-4)).toHaveLength(3)
  })

  it('静止的轨道被压成两个端点（采样 31 帧 → 2 帧）', () => {
    const still = Array.from({ length: 31 }, (_, i) => ({ time: i / 30, x: 0.25, y: -0.5 }))
    expect(simplifyVec2(still, 1e-4)).toHaveLength(2)
    const stillRotate = Array.from({ length: 31 }, (_, i) => ({ time: i / 30, value: 12 }))
    expect(simplifyScalar(stillRotate, 0.05)).toHaveLength(2)
  })

  it('角度合并受跨度上限约束（相邻键超过 180° 会被最短弧当成反向旋转）', () => {
    const spin = [
      { time: 0, value: 0 },
      { time: 1 / 3, value: 100 },
      { time: 2 / 3, value: 200 },
      { time: 1, value: 300 }
    ]
    // 不设上限时整段就是一条直线 → 只剩两端（这正是 Dragon 的 COG 第 10–19 帧被压成 282.5° 的原因）
    expect(simplifyScalar(spin, 0.05)).toHaveLength(2)
    // 设上限后必须留中间键，把每段都压进 180° 以内
    const kept = simplifyScalar(spin, 0.05, MAX_ANGLE_SPAN)
    expect(kept.length).toBeGreaterThan(2)
    for (let i = 0; i + 1 < kept.length; i++) {
      expect(Math.abs(kept[i + 1].value - kept[i].value)).toBeLessThanOrEqual(MAX_ANGLE_SPAN)
    }
  })

  it('wrapRotateKeys：rotate 取值按最短弧连续化（337.8 → -22.2，不再跨过 180°）', () => {
    const json = {
      skeleton: { spine: '3.3.07' },
      animations: {
        flying: {
          bones: {
            // 老文件写 angle：本意是「抬到 23.93° 再回摆 -22.2°」
            COG: {
              rotate: [
                { time: 0, angle: 0 },
                { time: 0.33, angle: 23.93 },
                { time: 0.67, angle: 337.8 },
                { time: 1, angle: 0 }
              ]
            },
            // 4.2+ 写 value：190° 与 -170° 等价，取跨度小的那个
            head: {
              rotate: [
                { time: 0, value: 0 },
                { time: 1, value: 190 }
              ]
            }
          }
        }
      }
    }
    const out = wrapRotateKeys(json) as typeof json
    expect(out.animations.flying.bones.COG.rotate.map((key) => Math.round(key.angle * 100) / 100)).toEqual([
      0, 23.93, -22.2, 0
    ])
    // 字段名保持原样（老文件仍是 angle，交给后面的老格式规整改名）
    expect(out.animations.flying.bones.COG.rotate[2]).not.toHaveProperty('value')
    expect(out.animations.flying.bones.head.rotate[1].value).toBeCloseTo(-170, 6)
    // 入参不被改动
    expect(json.animations.flying.bones.COG.rotate[2].angle).toBe(337.8)
  })

  it('压缩视觉无损：在原采样点上求值，误差都在阈值内', () => {
    const keys: Array<{ time: number; x: number; y: number }> = []
    // 0~0.5s：匀速直线（应被压成两点）
    for (let i = 0; i <= 30; i++) {
      const t = i / 60
      keys.push({ time: t, x: t * 2, y: 0 })
    }
    // 0.5~1s：半周期正弦（只在弯曲处保留关键帧）
    for (let i = 1; i <= 30; i++) {
      const t = 0.5 + i / 60
      const phase = (t - 0.5) * Math.PI * 2
      keys.push({ time: t, x: 1 + 0.5 * Math.sin(phase), y: 0.2 * Math.sin(phase) })
    }
    const out = simplifyVec2(keys, 1e-4)
    // eps 取得很严（0.01 像素）：匀速/静止段被大量压缩，弯曲段按精度保留
    expect(out.length).toBeLessThan(keys.length * 0.7)

    const sampleAt = (
      list: ReadonlyArray<{ time: number; x: number; y: number }>,
      time: number
    ): { x: number; y: number } => {
      const last = list[list.length - 1]
      if (time <= list[0].time) return { x: list[0].x, y: list[0].y }
      if (time >= last.time) return { x: last.x, y: last.y }
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i]
        const b = list[i + 1]
        if (time >= a.time && time <= b.time) {
          const f = (time - a.time) / (b.time - a.time)
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
        }
      }
      return { x: last.x, y: last.y }
    }

    for (const original of keys) {
      const got = sampleAt(out, original.time)
      expect(Math.hypot(got.x - original.x, got.y - original.y)).toBeLessThanOrEqual(1e-4 + 1e-9)
    }
  })

  it('阶跃（瞬间切换）被识别，且阶跃段不参与简化', () => {
    // head-turn 的镜像切换：scale 1 → -1
    // `stepped` 是 markSteppedVec2 写上去的标记，本地推断类型里要先声明出来
    const scale: Array<{ time: number; x: number; y: number; stepped?: boolean }> = [
      { time: 0.1, x: 1, y: 1 },
      { time: 0.1 + 1 / 30, x: -1, y: 1 }
    ]
    markSteppedVec2(scale, 1)
    expect(scale[0].stepped).toBe(true)

    // 阶跃段不能被压掉，否则瞬间切换会变成平滑过渡
    const keys = [
      { time: 0, x: 0, y: 0, stepped: true },
      { time: 1, x: 1, y: 0 },
      { time: 2, x: 2, y: 0 }
    ]
    expect(simplifyVec2(keys, 1e-4)).toHaveLength(3)
  })

  it('正常运动不会被误标为阶跃（位移 0.1 世界单位 / 旋转 60 度阈值）', () => {
    const smooth: Array<{ time: number; x: number; y: number; stepped?: boolean }> = [
      { time: 0, x: 0, y: 0 },
      { time: 1 / 30, x: 0.03, y: 0.02 }
    ]
    markSteppedVec2(smooth, 0.1)
    expect(smooth[0].stepped).toBeUndefined()

    const rotate: Array<{ time: number; value: number; stepped?: boolean }> = [
      { time: 0, value: 0 },
      { time: 0.5, value: 20 },
      { time: 1, value: 120 }
    ]
    markSteppedScalar(rotate, 60)
    expect(rotate[0].stepped).toBeUndefined()
    expect(rotate[1].stepped).toBe(true)
  })
})

describe('Spine 烘焙：常量通道压缩（源里没有这条通道才整条删掉）', () => {
  const MINI_ATLAS = [
    'body.png',
    'size: 16,16',
    'filter: Linear,Linear',
    'body',
    '  bounds: 0, 0, 10, 10',
    ''
  ].join('\n')

  const MINI_SKELETON = {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: [
      { name: 'root' },
      // 全程不动的骨骼（动画里没有它的任何通道）→ 采样值恒等于 setup
      { name: 'static', parent: 'root', x: 10, y: 20, rotation: 5 },
      // 有实际运动的骨骼
      { name: 'mover', parent: 'root' }
    ],
    slots: [{ name: 'body', bone: 'static' }],
    skins: [
      {
        name: 'default',
        attachments: { body: { body: { type: 'region', path: 'body', width: 10, height: 10 } } }
      }
    ],
    animations: {
      walk: {
        bones: {
          mover: {
            // 4.2 起关键帧字段是 `value`（旧版是 `angle`）
            rotate: [
              { time: 0, value: 0 },
              { time: 0.5, value: 45 },
              { time: 1, value: 0 }
            ]
          }
        }
      }
    }
  }

  it('烘焙产出的采样值必须全部有限（老格式会采样出 NaN，此时应放弃烘焙）', () => {
    const baked = bakeSpineAnimations({
      json: MINI_SKELETON,
      atlasText: MINI_ATLAS,
      boneNames: ['root', 'static', 'mover'],
      slotNames: ['body'],
      fps: 30
    })
    // 要么整体放弃（返回 null，调用方回退内置解析），要么每个值都是有限数 ——
    // 一旦 NaN 混进轨道，播放时整条骨骼链连同网格顶点都会 NaN，角色直接消失
    if (baked) {
      for (const anim of baked) {
        for (const track of anim.bones) {
          for (const key of track.translate) {
            expect(Number.isFinite(key.x)).toBe(true)
            expect(Number.isFinite(key.y)).toBe(true)
          }
          for (const key of track.rotate) expect(Number.isFinite(key.value)).toBe(true)
          for (const key of track.scale) {
            expect(Number.isFinite(key.x)).toBe(true)
            expect(Number.isFinite(key.y)).toBe(true)
          }
        }
      }
    }
  })

  it('不动的骨骼整条轨道消失，运动的骨骼保留', () => {
    const baked = bakeSpineAnimations({
      json: MINI_SKELETON,
      atlasText: MINI_ATLAS,
      boneNames: ['root', 'static', 'mover'],
      slotNames: ['body'],
      fps: 30
    })
    expect(baked).not.toBeNull()
    const walk = baked![0]
    // root / static 全程停在 setup（四条通道都是常量且等于 setup）→ 不产生轨道
    expect(walk.bones.map((track) => track.bone)).toEqual([2])
    const mover = walk.bones[0]
    expect(mover.rotate.length).toBeGreaterThanOrEqual(3)
    expect(mover.translate).toEqual([])
    expect(mover.scale).toEqual([])
  })

  it('源动画里显式有这条通道就保留（哪怕值恒等于 setup）；源里没有才删', () => {
    const json = {
      skeleton: { spine: '4.2.0', fps: 30 },
      bones: [
        { name: 'root' },
        // 源动画对它写了 translate 轨道，但值恒为 0 —— Spine 的 translate 帧是「相对 setup 的
        // 增量」，所以采样值全程等于 setup：正是以前会被整条删掉的那种通道
        { name: 'pinned', parent: 'root', x: 10, y: 20, rotation: 5 }
      ],
      slots: [{ name: 'body', bone: 'pinned' }],
      skins: [
        {
          name: 'default',
          attachments: { body: { body: { type: 'region', path: 'body', width: 10, height: 10 } } }
        }
      ],
      animations: {
        hold: {
          bones: {
            pinned: {
              translate: [
                { time: 0, x: 0, y: 0 },
                { time: 1, x: 0, y: 0 }
              ]
            }
          }
        },
        // 一条通道都没有的动画：骨骼轨道应当照旧整体消失
        plain: {}
      }
    }
    const baked = bakeSpineAnimations({
      json,
      atlasText: MINI_ATLAS,
      boneNames: ['root', 'pinned'],
      slotNames: ['body'],
      fps: 30
    })
    expect(baked).not.toBeNull()

    const hold = baked!.find((anim) => anim.name === 'hold')!
    const pinned = hold.bones.find((track) => track.bone === 1)
    // 源里有 translate 通道 → 通道保留（常量压成 1 帧），骨骼轨道不消失
    expect(pinned).toBeDefined()
    expect(pinned!.translate).toHaveLength(1)
    // 其余三条通道源里没有 → 照旧删干净
    expect(pinned!.rotate).toEqual([])
    expect(pinned!.scale).toEqual([])
    expect(pinned!.shear).toEqual([])

    const plain = baked!.find((anim) => anim.name === 'plain')!
    expect(plain.bones).toHaveLength(0)
  })
})

describe('DragonBones 的 IK 链（chain 展开）', () => {
  // DB 的 `bone` 是**末端**骨骼、`chain` 是「还要向上追溯的骨骼数」。
  // 曾经只放一根末端骨骼，两骨腿会退化成 CCD 迭代解 → 脚解不到 IK 目标（穿地）。
  const DB = {
    version: '5.5',
    frameRate: 24,
    armature: [
      {
        frameRate: 24,
        bone: [
          { name: 'root' },
          { name: 'upper', parent: 'root', length: 50, transform: { x: 0, y: 0 } },
          { name: 'lower', parent: 'upper', length: 40, transform: { x: 50, y: 0 } },
          { name: 'ikTarget', parent: 'root', transform: { x: 60, y: 20 } }
        ],
        slot: [],
        skin: [{ slot: [] }],
        ik: [{ name: 'legIk', bone: 'lower', target: 'ikTarget', chain: 1 }],
        animation: []
      }
    ]
  }

  it('chain=1 → 两骨链，顺序为「根 → 末端」', () => {
    const { asset } = importDragonBones({ json: DB, subTextures: [], pageSizes: {} })
    expect(asset.constraints).toHaveLength(1)
    const ik = asset.constraints[0]
    const upper = asset.bones.findIndex((b) => b.name === 'upper')
    const lower = asset.bones.findIndex((b) => b.name === 'lower')
    // 根在前、末端在最后（solveIkTwoBone 取 [0] 作根、[1] 作末端）
    expect(ik.boneIndices).toEqual([upper, lower])
    expect(ik.targetBoneIndex).toBe(asset.bones.findIndex((b) => b.name === 'ikTarget'))
    // `Constraint` 是判别联合：先确认类型，`useBoneLength` 才在收窄后的类型上
    if (ik.type !== 'ik') throw new Error(`期望 IK 约束，实际是 ${ik.type}`)
    expect(ik.useBoneLength).toBe(true)
  })
})

describe('DragonBones 皮肤名：空串回落成 default', () => {
  /**
   * DB 的默认皮肤常常写成 `"name": ""`（而不是省掉 name）—— 原来只判 `??`，
   * 空串就原样进来了，皮肤面板上是一个空白标签（Demon 实测如此）。
   * 口径与 createEmptyDocument / 编译器查找默认皮肤的名字一致。
   */
  function dbWith(skin: Array<{ name?: string; slot: never[] }>) {
    return {
      version: '5.5',
      frameRate: 24,
      armature: [{ frameRate: 24, bone: [{ name: 'root' }], slot: [], skin, animation: [] }]
    }
  }

  it('空串 → default', () => {
    const { asset } = importDragonBones({ json: dbWith([{ name: '', slot: [] }]), subTextures: [], pageSizes: {} })
    expect(asset.skins.map((skin) => skin.name)).toEqual(['default'])
  })

  it('缺 name 字段 → 同样是 default', () => {
    const { asset } = importDragonBones({ json: dbWith([{ slot: [] }]), subTextures: [], pageSizes: {} })
    expect(asset.skins.map((skin) => skin.name)).toEqual(['default'])
  })

  it('真的有名字就原样保留', () => {
    const { asset } = importDragonBones({ json: dbWith([{ name: 'goblin', slot: [] }]), subTextures: [], pageSizes: {} })
    expect(asset.skins.map((skin) => skin.name)).toEqual(['goblin'])
  })

  it('第二套皮肤的空串名按序号补齐', () => {
    const { asset } = importDragonBones({
      json: dbWith([
        { name: '', slot: [] },
        { name: '', slot: [] }
      ]),
      subTextures: [],
      pageSizes: {}
    })
    expect(asset.skins.map((skin) => skin.name)).toEqual(['default', 'skin1'])
  })
})

describe('Spine 换装皮肤的「皮肤名/」前缀', () => {
  // 换装角色（如 Goblins）的皮肤附件名带皮肤前缀：goblin 皮肤里是 `goblin/head`，
  // 而 slot 的 setup 附件名与动画轨道用裸名 `head` —— 两边必须能对上，
  // 否则切换皮肤后所有槽位都显示不出附件（角色整个消失）。
  const SKIN_SKELETON = {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'head', bone: 'root', attachment: 'head' }],
    skins: [
      {
        name: 'default',
        attachments: { head: { head: { type: 'region', width: 10, height: 10 } } }
      },
      {
        name: 'goblin',
        attachments: {
          head: { head: { name: 'goblin/head', type: 'region', width: 10, height: 10 } }
        }
      }
    ],
    animations: {}
  }
  const SKIN_ATLAS = [
    'p.png',
    'size: 32,32',
    'filter: Linear,Linear',
    'head',
    '  bounds: 0, 0, 10, 10',
    'goblin/head',
    '  bounds: 10, 0, 10, 10',
    ''
  ].join('\n')

  it('带前缀的附件名能找到区域，setup 裸名也能命中', () => {
    const atlas = parseSpineAtlas(SKIN_ATLAS)
    const { asset } = importSpine({
      json: SKIN_SKELETON,
      regions: atlas.regions,
      pageSizes: { 'p.png': { width: 32, height: 32 } }
    })
    const goblin = asset.skins.find((skin) => skin.name === 'goblin')
    expect(goblin?.slots[0].attachments[0].textureName).toBe('p.png')

    // 切到 goblin 皮肤：slot.setupAttachment 是裸名 `head`，要能命中带前缀的附件
    const maps = buildRuntimeMaps(asset, 'goblin')
    expect(maps.setupDisplayIndex[0]).toBeGreaterThanOrEqual(0)
    expect(maps.slotAttIndex[0]?.size).toBeGreaterThanOrEqual(1)
  })
})

describe('Spine FFD（deform）的偏移语义', () => {
  // 非加权网格的 deform 帧，json 里的 `vertices` 就是「相对绑定顶点的偏移」，
  // 运行期是「绑定顶点 + 偏移」→ 导入侧必须原样保留（官方 SkeletonJson 也是拿它
  // 加上绑定顶点才得到绝对坐标）。早先又减了一次绑定顶点，FFD 会彻底错乱。
  const DEFORM_SKELETON = {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: [{ name: 'root' }, { name: 'arm', parent: 'root' }],
    slots: [{ name: 'arm', bone: 'arm' }],
    skins: [
      {
        name: 'default',
        attachments: {
          arm: {
            arm: {
              type: 'mesh',
              width: 10,
              height: 10,
              // 绑定顶点：第 1 个顶点在 (10, 0)（像素）
              vertices: [0, 0, 10, 0, 10, 10],
              uvs: [0, 0, 1, 0, 1, 1],
              triangles: [0, 1, 2]
            }
          }
        }
      }
    ],
    animations: {
      wave: {
        deform: {
          default: {
            arm: {
              // offset 是「浮点数组下标」（2 → 第 1 个顶点的 x 分量）
              arm: [{ time: 0, offset: 2, vertices: [5, 5] }]
            }
          }
        }
      }
    }
  }

  it('deform 帧的值原样当偏移使用，不再减绑定顶点', () => {
    const { asset } = importSpine({ json: DEFORM_SKELETON, regions: [], pageSizes: {} })
    const deform = asset.animations[0].deforms[0]
    expect(deform).toBeDefined()
    const offsets = deform.frames[0].offsets
    // 第 1 个顶点的偏移 = (5px, 5px) → (0.05, 0.05) 世界单位
    // （若错误地再减去绑定顶点 (10, 0)，x 会变成 -0.05）
    expect(offsets[2]).toBeCloseTo(0.05, 6)
    expect(offsets[3]).toBeCloseTo(0.05, 6)
    // 未覆盖的顶点保持 0 偏移
    expect(offsets[0]).toBeCloseTo(0, 6)
  })

  // 4.2 的 deform 唯一位置是 `attachments.<skin>...`：多个皮肤的轨道都必须收下来
  //（早先只取第一个皮肤，其余皮肤的 FFD 直接丢），顶点基线也要按皮肤分开。
  const TWO_SKIN_DEFORM = {
    skeleton: { spine: '4.3.0', fps: 30 },
    bones: [{ name: 'root' }, { name: 'arm', parent: 'root' }],
    slots: [{ name: 'arm', bone: 'arm', attachment: 'arm' }],
    skins: [
      {
        name: 'default',
        attachments: {
          arm: {
            arm: {
              type: 'mesh',
              width: 10,
              height: 10,
              // 3 顶点 → 6 个分量
              vertices: [0, 0, 10, 0, 10, 10],
              uvs: [0, 0, 1, 0, 1, 1],
              triangles: [0, 1, 2]
            }
          }
        }
      },
      {
        name: 'armor',
        attachments: {
          arm: {
            // 同名附件但 4 顶点 → 8 个分量：顶点基线必须按皮肤分开
            arm: {
              type: 'mesh',
              width: 10,
              height: 10,
              vertices: [0, 0, 10, 0, 10, 10, 0, 10],
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3]
            }
          }
        }
      }
    ],
    animations: {
      wave: {
        attachments: {
          default: { arm: { arm: { deform: [{ time: 0, offset: 0, vertices: [1, 1] }] } } },
          armor: { arm: { arm: { deform: [{ time: 0, offset: 0, vertices: [2, 2, 2, 2] }] } } }
        }
      }
    }
  }

  it('每个皮肤的 deform 轨道都收，顶点长度按各自皮肤的基线对齐', () => {
    const { asset } = importSpine({ json: TWO_SKIN_DEFORM, regions: [], pageSizes: {} })
    const tracks = asset.animations[0].deforms
    expect(tracks.map((track) => track.skin)).toEqual(['default', 'armor'])
    const bySkin = new Map(tracks.map((track) => [track.skin, track]))
    expect(bySkin.get('default')?.frames[0].offsets.length).toBe(6)
    expect(bySkin.get('armor')?.frames[0].offsets.length).toBe(8)
  })

  /*
   * 加权网格的 deform 在 Spine 里是**逐影响点**的骨内偏移（长度 = 影响数 × 2），
   * 编辑器按顶点存显示空间位移。折叠公式（见 collapseInfluenceOffsets）：
   *   D = Σ w_k · W_k_setup · d_k
   *
   * 这里两根骨骼朝向差 90°、权重各半、两根影响的偏移都是 (4,0)px：
   *   W_a = 单位矩阵     → 0.5 * (0.04, 0)
   *   W_b = rot90        → 0.5 * (0, 0.04)
   *   D = (0.02, 0.02)
   * 若按「顶点下标」硬切（旧实现），第 0 个顶点会读到 (0.04, 0) 与 (0.04, 0)，
   * 长度也会是 12（3 顶点 × 2 影响 × 2）而不是 6。
   */
  const WEIGHTED_DEFORM = {
    skeleton: { spine: '4.3.0', fps: 30 },
    bones: [
      { name: 'root' },
      { name: 'a', parent: 'root' },
      { name: 'b', parent: 'root', x: 500, y: 0, rotation: 90 }
    ],
    slots: [{ name: 's', bone: 'a', attachment: 'mesh' }],
    skins: [
      {
        name: 'default',
        attachments: {
          s: {
            mesh: {
              type: 'mesh',
              width: 10,
              height: 10,
              // 每顶点 2 根影响：[count, (boneIdx, lx, ly, w) × 2]
              // 三个顶点的绑定位置分别是 (10,10)、(11,10)、(10,11)（世界单位 = 像素 / 100）
              vertices: [
                2, 1, 1000, 1000, 0.5, 2, 1000, -500, 0.5,
                2, 1, 1100, 1000, 0.5, 2, 1100, -500, 0.5,
                2, 1, 1000, 1100, 0.5, 2, 1000, -600, 0.5
              ],
              uvs: [0, 0, 1, 0, 1, 1],
              triangles: [0, 1, 2]
            }
          }
        }
      }
    ],
    animations: {
      wave: {
        attachments: {
          default: {
            s: { mesh: { deform: [{ time: 0, vertices: [4, 0, 4, 0, 4, 0, 4, 0, 4, 0, 4, 0] }] } }
          }
        }
      }
    }
  }

  it('加权网格的 deform 按影响点折叠成逐顶点显示空间位移', () => {
    const { asset } = importSpine({ json: WEIGHTED_DEFORM, regions: [], pageSizes: {} })
    const frames = asset.animations[0].deforms[0].frames
    // 逐顶点：3 个顶点 × 2 个分量
    expect(frames[0].offsets.length).toBe(6)
    for (let i = 0; i < 3; i++) {
      expect(frames[0].offsets[i * 2]).toBeCloseTo(0.02, 6)
      expect(frames[0].offsets[i * 2 + 1]).toBeCloseTo(0.02, 6)
    }
  })
})

describe('Spine 图集旋转区域的 UV 映射（rotate 90/180/270）', () => {
  // spineboy-pro 的真实图集条目（页 2048×1024）
  const PAGE = { 'p.png': { width: 2048, height: 1024 } }
  const HEAD: AtlasRegion = {
    name: 'head',
    page: 'p.png',
    x: 917,
    y: 2,
    width: 271,
    height: 298,
    rotate: 180,
    origWidth: 271,
    origHeight: 298,
    offsetX: 0,
    offsetY: 0
  }
  const GOGGLES: AtlasRegion = {
    name: 'goggles',
    page: 'p.png',
    x: 731,
    y: 34,
    width: 261,
    height: 166,
    rotate: 90,
    origWidth: 261,
    origHeight: 166,
    offsetX: 0,
    offsetY: 0
  }

  it('rotate: 180 的 mesh UV 整块倒转（head 贴图不再上下颠倒）', () => {
    // 内容左上 (0,0) → 图集矩形右下角
    const uvs = mapRegionRelativeUvs(Float32Array.from([0, 0, 1, 1]), HEAD, PAGE)
    expect(uvs[0]).toBeCloseTo((917 + 271) / 2048, 6)
    expect(uvs[1]).toBeCloseTo(1 - (2 + 298) / 1024, 6)
    // 内容右下 (1,1) → 图集矩形左上角
    expect(uvs[2]).toBeCloseTo(917 / 2048, 6)
    expect(uvs[3]).toBeCloseTo(1 - 2 / 1024, 6)
  })

  it('rotate: 90 的 mesh UV 占位宽高互换（goggles 不再横竖错位）', () => {
    const uvs = mapRegionRelativeUvs(Float32Array.from([0, 0, 1, 1]), GOGGLES, PAGE)
    // 内容左上 (0,0) → px = x，py = y + 原始宽（占位高 = 原始宽）
    expect(uvs[0]).toBeCloseTo(731 / 2048, 6)
    expect(uvs[1]).toBeCloseTo(1 - (34 + 261) / 1024, 6)
    // 内容右下 (1,1) → px = x + 原始高（占位宽 = 原始高），py = y
    expect(uvs[2]).toBeCloseTo((731 + 166) / 2048, 6)
    expect(uvs[3]).toBeCloseTo(1 - 34 / 1024, 6)
  })

  it('region 四角走同一套旋转逻辑：左下→右下→右上→左上', () => {
    const uvs = regionUvs(HEAD, PAGE)
    // 几何左下 ← 内容左下 (0,1) → 图集矩形右上角（180° 后原图左下内容在右上位置）
    expect(uvs[0]).toBeCloseTo((917 + 271) / 2048, 6)
    expect(uvs[1]).toBeCloseTo(1 - 2 / 1024, 6)
    // 几何右下 ← 内容右下 (1,1) → 图集矩形左上角
    expect(uvs[2]).toBeCloseTo(917 / 2048, 6)
    expect(uvs[3]).toBeCloseTo(1 - 2 / 1024, 6)
    // 几何右上 ← 内容右上 (1,0) → 图集矩形左下角
    expect(uvs[4]).toBeCloseTo(917 / 2048, 6)
    expect(uvs[5]).toBeCloseTo(1 - (2 + 298) / 1024, 6)
    // 几何左上 ← 内容左上 (0,0) → 图集矩形右下角
    expect(uvs[6]).toBeCloseTo((917 + 271) / 2048, 6)
    expect(uvs[7]).toBeCloseTo(1 - (2 + 298) / 1024, 6)
  })
})

describe('Spine 导入', () => {
  const parsed = parseSpineAtlas(SPINE_ATLAS)
  const result = importSpine({
    json: SPINE_JSON,
    regions: parsed.regions,
    pageSizes: parsed.pageSizes,
    pageImages: { 'hero.png': '/tmp/hero.png' }
  })

  it('骨骼拓扑排序后重映射父下标', () => {
    expect(result.asset.bones.map((b) => b.name)).toEqual(['root', 'arm'])
    expect(result.asset.bones[1].parentIndex).toBe(0)
    expect(result.asset.bones[1].localPosition.x).toBeCloseTo(0.5, 6)
    expect(result.asset.bones[1].length).toBeCloseTo(0.5, 6)
  })

  it('插槽颜色与混合模式被映射', () => {
    expect(result.asset.slots.map((s) => s.name)).toEqual(['body', 'hand'])
    expect(result.asset.slots[1].blendMode).toBe(BlendMode.Additive)
    expect(result.asset.slots[0].boneIndex).toBe(0)
  })

  it('setup 附件名被解析成默认显示下标', () => {
    expect(result.asset.slots[0].setupAttachment).toBe('body')
    expect(result.asset.slots[0].defaultDisplayIndex).toBe(0)
  })

  it('Region 附件的尺寸与 UV 来自图集', () => {
    const attachment = result.asset.skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe(AttachmentType.Region)
    expect(attachment.textureName).toBe('hero.png')
    expect(attachment.size.x).toBeCloseTo(1, 6)
    expect(attachment.size.y).toBeCloseTo(1, 6)
    // 四角顺序 BL → BR → TR → TL，v 已按左下原点翻转
    expect(attachment.uvs[0]).toBeCloseTo(0, 6)
    expect(attachment.uvs[1]).toBeCloseTo(1 - 100 / 256, 6)
    expect(attachment.uvs[2]).toBeCloseTo(100 / 256, 6)
    expect(attachment.uvs[3]).toBeCloseTo(1 - 100 / 256, 6)
    expect(attachment.uvs[4]).toBeCloseTo(100 / 256, 6)
    expect(attachment.uvs[5]).toBeCloseTo(1, 6)
  })

  it('Mesh 附件的顶点被换算成世界单位', () => {
    const mesh = result.asset.skins[0].slots[1].attachments[1]
    expect(mesh.type).toBe(AttachmentType.Mesh)
    expect(mesh.vertices[0]).toBeCloseTo(-0.2, 6)
    expect(mesh.vertices[5]).toBeCloseTo(0.2, 6)
    expect(mesh.triangles).toEqual([0, 1, 2])
  })

  it('骨架绑定矩阵数量与骨骼数一致', () => {
    expect(result.asset.bindposes.length).toBe(result.asset.bones.length * 16)
  })

  it('IK 约束被映射（bendSign 由 bendPositive 决定）', () => {
    expect(result.asset.constraints).toHaveLength(1)
    const ik = result.asset.constraints[0]
    expect(ik.type).toBe('ik')
    if (ik.type === 'ik') {
      expect(ik.boneIndices).toEqual([0, 1])
      expect(ik.targetBoneIndex).toBe(1)
      expect(ik.mix).toBeCloseTo(0.5, 5)
      // 与 Unity 端 Hao2D 运行时一致：bendPositive(false) → +1（解算器把 bendSign 当旋转方向符号，
      // `kneeDir = Rotate(u, a1 * bendSign)`，符号反了膝盖会朝另一侧弯）
      expect(ik.bendSign).toBe(1)
      expect(ik.useBoneLength).toBe(false)
    }
  })

  it('4.2+ 的约束在顶层 constraints 数组里（旧的 ik 字段为空）', () => {
    const json = {
      skeleton: { spine: '4.3.0' },
      bones: [{ name: 'root' }, { name: 'upper' }, { name: 'lower' }, { name: 'goal' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      // 4.2+ 格式：统一放 constraints，每项带 type（没有顶层 ik 字段）
      constraints: [{ type: 'ik', name: 'leg_goal', target: 'goal', bones: ['upper', 'lower'] }]
    }
    const { asset, warnings } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    // 早先只读 json.ik → 4.2+ 资源一个约束都读不到，IK 完全不生效
    expect(asset.constraints).toHaveLength(1)
    const ik = asset.constraints[0]
    expect(ik.type).toBe('ik')
    if (ik.type === 'ik') {
      expect(ik.boneIndices).toEqual([1, 2])
      expect(ik.targetBoneIndex).toBe(3)
      expect(ik.mix).toBeCloseTo(1, 6)
      // 缺省 bendPositive = true → -1
      expect(ik.bendSign).toBe(-1)
    }
    expect(warnings.filter((w) => w.includes('IK'))).toHaveLength(0)
  })

  it('附件关键帧对齐到帧（连续播放不会在一帧之内提前切换）', () => {
    /*
     * 官方运行库把关键帧时间存成 float32：`"time": 1.1` → `1.1000000238`，
     * 判定用 `time < frames[0]`，所以「正好停在第 33 帧」（33/30 = 1.1）时该键还没到。
     * 而骨骼轨道是 30fps 烘焙的（关键帧只在「帧时间 ≥ 关键帧时间」的那一帧生效），
     * 附件切换必须落在同一帧；否则连续播放 / 关掉吸附慢慢拖时间轴时，
     * 会看到 flare 贴图先在旧位置闪一下（portal 第 33→34 帧）。
     */
    const json = {
      skeleton: { spine: '4.3.0', fps: 30 },
      bones: [{ name: 'root' }],
      slots: [{ name: 'flare', bone: 'root' }],
      skins: [{ name: 'default', attachments: { flare: { flare: { type: 'region', width: 10, height: 10 } } } }],
      animations: { a: { slots: { flare: { attachment: [{ time: 0 }, { time: 1.1, name: 'flare' }] } } } }
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const track = asset.animations[0].slots[0]
    // 1.1 → 34/30（而不是恰好 1.1，正好落在两个采样帧之间）
    expect(track.displayIndex[1].time).toBeCloseTo(34 / 30, 10)
    expect(track.displayIndex[1].time).toBeGreaterThan(1.1)
  })

  it('transform 约束的 4.x 字段名（offsetRotation / offsetX…）能被读出', () => {
    const json = {
      skeleton: { spine: '4.3.0' },
      bones: [{ name: 'root' }, { name: 'target' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      constraints: [
        {
          type: 'transform',
          name: 'tc',
          bones: ['root'],
          target: 'target',
          mixRotate: 0.25,
          mixX: 0.5,
          offsetRotation: 30,
          offsetX: 100, // px → 1 世界单位
          offsetY: -50,
          offsetScaleX: 0.2
        }
      ]
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const tc = asset.constraints[0]
    expect(tc.type).toBe('transform')
    if (tc.type !== 'transform') return
    // 早先只读 3.8 的 rotate / x / y，4.x 资源里的偏移会整段读成 0
    expect(tc.offsetRotate).toBeCloseTo(30, 6)
    expect(tc.offsetX).toBeCloseTo(1, 6)
    expect(tc.offsetY).toBeCloseTo(-0.5, 6)
    expect(tc.offsetScaleX).toBeCloseTo(0.2, 6)
    // 混合系数：新名优先，缺省的仍是 1
    expect(tc.mixRotate).toBeCloseTo(0.25, 6)
    expect(tc.mixX).toBeCloseTo(0.5, 6)
    expect(tc.mixY).toBeCloseTo(1, 6)
  })

  it('transform 约束的 3.8 字段名（rotate / x / translateMix…）仍然认', () => {
    const json = {
      skeleton: { spine: '3.8.75' },
      bones: [{ name: 'root' }, { name: 'target' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      transform: [
        {
          name: 'tc',
          bones: ['root'],
          target: 'target',
          rotateMix: 0.4,
          translateMix: 0.6,
          rotate: -15,
          x: 200
        }
      ]
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const tc = asset.constraints[0]
    expect(tc.type).toBe('transform')
    if (tc.type !== 'transform') return
    expect(tc.offsetRotate).toBeCloseTo(-15, 6)
    expect(tc.offsetX).toBeCloseTo(2, 6)
    // translateMix 同时管 X 与 Y
    expect(tc.mixRotate).toBeCloseTo(0.4, 6)
    expect(tc.mixX).toBeCloseTo(0.6, 6)
    expect(tc.mixY).toBeCloseTo(0.6, 6)
  })

  it('4.2+ 的 curve 是 (时间,值) 绝对坐标 → 归一化；旧版 0..1 直接用', () => {
    const json = {
      skeleton: { spine: '4.3.0' },
      bones: [{ name: 'root' }],
      slots: [{ name: 'slot', bone: 'root' }],
      skins: [{ name: 'default', attachments: {} }],
      animations: {
        walk: {
          bones: {
            root: {
              translate: [
                // 绝对坐标：控制点 (0.018, 81.5) (0.0414, 81.6)，帧值 80.965 → 82.52
                { x: 80.965, y: 0, curve: [0.018, 81.5, 0.0414, 81.6, 0.018, 0, 0.0414, 0] },
                { time: 0.0667, x: 82.52, y: 0 }
              ]
            }
          }
        }
      }
    }
    const { asset } = importSpine({ json: json as never, regions: [], pageSizes: {} })
    const key = asset.animations[0].bones[0].translate[0]
    expect(key.easing).toBe(Easing.Bezier)
    const curve = key.curve!
    // x 通道归一化到 [0,1] 时间 × 帧值区间；y 通道帧值相同（0→0）时取 0/1
    expect(curve[0]).toBeCloseTo((0.018 - 0) / 0.0667, 4)
    expect(curve[2]).toBeCloseTo((0.0414 - 0) / 0.0667, 4)
    expect(curve[1]).toBeCloseTo((81.5 - 80.965) / (82.52 - 80.965), 4)
    expect(curve[3]).toBeCloseTo((81.6 - 80.965) / (82.52 - 80.965), 4)
    for (const v of curve) expect(Number.isFinite(v)).toBe(true)
  })

  it('骨骼动画增量叠加 setup 值', () => {
    const animation = result.asset.animations[0]
    const rotate = animation.bones[0].rotate
    expect(rotate).toHaveLength(2)
    expect(rotate[0].value).toBeCloseTo(0, 5)
    expect(rotate[1].value).toBeCloseTo(90, 5)
    // curve 的控制点是绝对坐标 (0.42, 0) (0.58, 1)：归一化到 [0,1] 时间 × [0,90] 角度
    expect(rotate[0].easing).toBe(Easing.Bezier)
    expect(rotate[0].curve![0]).toBeCloseTo(0.42, 5)
    expect(rotate[0].curve![1]).toBeCloseTo(0, 5)
    expect(rotate[0].curve![2]).toBeCloseTo(0.58, 5)
    // 四个分量都落在 [0,1] → 旧版（≤4.1）的**归一化**写法，直接用
    expect(rotate[0].curve![3]).toBeCloseTo(1, 5)
    // 最后一帧没有「下一帧」，缓动无意义 → 线性
    expect(rotate[1].easing).toBe(Easing.Linear)
  })

  it('attachment 轨道产出附件名与烘焙下标', () => {
    const slotTrack = result.asset.animations[0].slots[0]
    expect(slotTrack.slotIndex).toBe(1)
    expect(slotTrack.displayAttachment).toEqual(['handMesh'])
    expect(slotTrack.displayIndex[0].value).toBe(1)
    expect(slotTrack.displayIndex[0].easing).toBe(Easing.Stepped)
  })

  it('drawOrder 展开成完整插槽顺序', () => {
    const order = result.asset.animations[0].drawOrder[0].order
    expect(order).toEqual([1, 0])
  })

  it('事件被映射', () => {
    const event = result.asset.animations[0].events[0]
    expect(event.name).toBe('roar')
    expect(event.intParam).toBe(3)
    expect(event.stringParam).toBe('s')
  })

  it('图集页成为材质槽', () => {
    expect(result.asset.textureNames).toEqual(['hero.png'])
    expect(result.asset.images[0].path).toBe('/tmp/hero.png')
  })
})

const DB_TEXTURE_JSON = {
  imagePath: 'hero.png',
  width: 256,
  height: 256,
  SubTexture: [
    { name: 'body', x: 0, y: 0, width: 100, height: 100, frameX: 0, frameY: 0, frameWidth: 100, frameHeight: 100 }
  ]
}

const DB_JSON = {
  frameRate: 24,
  name: 'hero',
  armature: [
    {
      name: 'hero',
      frameRate: 24,
      bone: [
        { name: 'root' },
        { name: 'arm', parent: 'root', length: 50, transform: { x: 50, y: 0, skX: 30 } }
      ],
      slot: [{ name: 'body', parent: 'root', displayIndex: 0 }],
      skin: [
        {
          name: 'default',
          slot: [{ name: 'body', display: [{ type: 'image', name: 'body', path: 'body' }] }]
        }
      ],
      ik: [{ name: 'armIK', bone: 'arm', target: 'arm', weight: 1 }],
      animation: [
        {
          name: 'idle',
          duration: 24,
          playTimes: 0,
          bone: [
            {
              name: 'arm',
              frame: [
                { duration: 12, transform: { skX: 0 } },
                { duration: 12, transform: { skX: 45 } }
              ]
            }
          ]
        }
      ]
    }
  ]
}

describe('DragonBones 导入', () => {
  const subTextures = parseDbTextureJson(DB_TEXTURE_JSON, { 'hero.png': { width: 256, height: 256 } })
  const result = importDragonBones({
    json: DB_JSON,
    subTextures,
    pageSizes: { 'hero.png': { width: 256, height: 256 } },
    pageImages: { 'hero.png': '/tmp/hero.png' }
  })

  it('骨骼 y-down 被翻转为 y-up，旋转取反', () => {
    expect(result.asset.bones.map((b) => b.name)).toEqual(['root', 'arm'])
    expect(result.asset.bones[1].localPosition.x).toBeCloseTo(0.5, 6)
    expect(result.asset.bones[1].localPosition.y).toBeCloseTo(0, 6)
    expect(result.asset.bones[1].rotation).toBeCloseTo(-30, 6)
  })

  it('图集页名进入材质槽', () => {
    expect(dbTextureNames(subTextures)).toEqual(['hero.png'])
    expect(result.asset.textureNames).toEqual(['hero.png'])
  })

  it('image 附件被映射为 Region 并带 UV', () => {
    const attachment = result.asset.skins[0].slots[0].attachments[0]
    expect(attachment.type).toBe(AttachmentType.Region)
    expect(attachment.textureName).toBe('hero.png')
    expect(attachment.size.x).toBeCloseTo(1, 6)
    expect(attachment.uvs[4]).toBeCloseTo(100 / 256, 6)
  })

  it('动画时间为帧 ÷ frameRate，并在循环动画末尾补闭合帧', () => {
    const rotate = result.asset.animations[0].bones[0].rotate
    expect(rotate[0].time).toBeCloseTo(0, 6)
    expect(rotate[1].time).toBeCloseTo(0.5, 6)
    expect(rotate[2].time).toBeCloseTo(1, 6)
    // 补的闭合帧等于首帧（-30 的 setup 值）
    expect(rotate[2].value).toBeCloseTo(rotate[0].value, 4)
  })

  it('IK 使用 useBoneLength（DragonBones 语义）', () => {
    const ik = result.asset.constraints[0]
    expect(ik.type).toBe('ik')
    if (ik.type === 'ik') expect(ik.useBoneLength).toBe(true)
  })
})

describe('格式判别', () => {
  it('按内容区分 Spine / DragonBones / 图集', () => {
    expect(detectSkeletonFormat(SPINE_JSON)).toBe('spine')
    expect(detectSkeletonFormat(DB_JSON)).toBe('dragonbones')
    expect(detectSkeletonFormat(DB_TEXTURE_JSON)).toBe('dbTexture')
    expect(detectSkeletonFormat({ foo: 1 })).toBe('unknown')
  })

  it('识别 Spine .atlas 文本', () => {
    expect(looksLikeSpineAtlasText(SPINE_ATLAS)).toBe(true)
    expect(looksLikeSpineAtlasText('{"a":1}')).toBe(false)
  })

  it('识别 DragonBones 图集 JSON', () => {
    expect(isDbTextureJson(DB_TEXTURE_JSON)).toBe(true)
    expect(isDbTextureJson(SPINE_JSON)).toBe(false)
  })
})

describe('碎图登记', () => {
  it('重名自动加序号', () => {
    const { images, warnings } = registerLooseImages([
      { path: '/a/hero.png', name: 'hero.png', width: 32, height: 32 },
      { path: '/a/hero.png', name: 'hero.png', width: 32, height: 32 }
    ])
    expect(images).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('同一路径只登记一次', () => {
    const { images } = registerLooseImages([
      { path: '/a/hero.png', name: 'hero.png', width: 32, height: 32 },
      { path: '/b/hero.png', name: 'hero.png', width: 32, height: 32 }
    ])
    expect(images).toHaveLength(2)
    expect(images[1].name).toBe('hero_2.png')
    expect(images[1].loose).toBe(true)
  })

  it('尺寸异常时给出告警', () => {
    const { warnings } = registerLooseImages([{ path: '/a/x.png', name: 'x.png', width: 0, height: 0 }])
    expect(warnings.some((w) => w.includes('尺寸'))).toBe(true)
  })
})

describe('DragonBones zOrder 展开（照参考 ExpandDrawOrder）', () => {
  it('空 pairs 保持声明顺序', () => {
    expect(expandDrawOrder([], [], 5)).toEqual([0, 1, 2, 3, 4])
  })

  it('Dora_zorder 真实帧：pairs [21,-8, 23,-11, 24,-10, 34,-19] 展开成绝对位次', () => {
    // 39 个插槽，帧里只列出 4 个被移动的槽（DB 的稀疏表示）
    const order = expandDrawOrder([21, 23, 24, 34], [-8, -11, -10, -19], 39)
    // 参考实现的结果：被移动的槽占据「原下标 + 偏移」的位次（21-8=13、23-11=12、24-10=14、34-19=15）
    expect(order.slice(0, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(order[12]).toBe(23)
    expect(order[13]).toBe(21)
    expect(order[14]).toBe(24)
    expect(order[15]).toBe(34)
    // 不丢不重（旧的「逐个 splice」实现会把 21 挤出去、让 12 错位到 13）
    expect(order).toHaveLength(39)
    expect(new Set(order).size).toBe(39)
  })

  it('越界偏移夹到两端，非法下标跳过且不丢槽', () => {
    const head = expandDrawOrder([2], [-99], 4)
    expect(head[0]).toBe(2)
    expect(new Set(head).size).toBe(4)

    const tail = expandDrawOrder([0], [99], 4)
    expect(tail[3]).toBe(0)
    expect(new Set(tail).size).toBe(4)

    const bogus = expandDrawOrder([99, -5, 0], [0, 0, 0], 3)
    expect(bogus).toEqual([0, 1, 2])
  })
})

describe('Spine 贝塞尔 curve 的坐标系（≥4.2 是绝对坐标，不是归一化控制点）', () => {
  const ATLAS = ['body.png', 'size: 16,16', 'filter: Linear,Linear', 'body', '  bounds: 0, 0, 10, 10', ''].join('\n')

  /**
   * `arm` 的 scale 从 0.5 补间到 1.0，curve 给的是 **(时间, 值) 空间的绝对控制点**
   * `(0.5, 0.6)` / `(0.5, 0.8)` —— 四个分量都落在 [0,1] 内。
   *
   * 这正是「按数值区间猜格式」会翻车的情形：它会被当成已归一化的控制点原样使用，
   * 而正确做法是按帧区间归一化（贝塞尔对仿射变换不变，形状等价于官方）。
   */
  const JSON_42 = {
    skeleton: { spine: '4.2.0', fps: 30 },
    bones: [{ name: 'root' }, { name: 'arm', parent: 'root' }],
    slots: [{ name: 'body', bone: 'arm' }],
    skins: [
      { name: 'default', attachments: { body: { body: { type: 'region', path: 'body', width: 10, height: 10 } } } }
    ],
    animations: {
      ease: {
        bones: {
          arm: {
            scale: [
              { time: 0, x: 0.5, y: 0.5, curve: [0.5, 0.6, 0.5, 0.8] },
              { time: 1, x: 1, y: 1 }
            ]
          }
        }
      }
    }
  }

  it('4.2+：绝对控制点按帧区间归一化（段 0.5→1.0 时 y 应压到 0.2 / 0.6）', () => {
    const asset = importSpine({ json: JSON_42 as never, regions: [], pageSizes: {} }).asset
    const key = asset.animations[0].bones[0].scale[0]
    expect(key.easing).toBe(Easing.Bezier)
    expect(key.curve).not.toBeNull()
    // x：段从 t=0 起、时长 1 → 归一化是恒等
    expect(key.curve![0]).toBeCloseTo(0.5, 6)
    expect(key.curve![2]).toBeCloseTo(0.5, 6)
    // y：(0.6 - 0.5) / (1.0 - 0.5) = 0.2、(0.8 - 0.5) / 0.5 = 0.6
    expect(key.curve![1]).toBeCloseTo(0.2, 6)
    expect(key.curve![3]).toBeCloseTo(0.6, 6)
  })

  it('≤4.1：curve 本来就是归一化控制点，原样使用', () => {
    const json = {
      ...JSON_42,
      skeleton: { spine: '3.8.75', fps: 30 },
      animations: {
        ease: {
          bones: {
            arm: {
              scale: [
                { time: 0, x: 0.5, y: 0.5, curve: [0.25, 0.1, 0.75, 0.9] },
                { time: 1, x: 1, y: 1 }
              ]
            }
          }
        }
      }
    }
    const asset = importSpine({ json: json as never, regions: [], pageSizes: {} }).asset
    const key = asset.animations[0].bones[0].scale[0]
    expect(key.easing).toBe(Easing.Bezier)
    expect(key.curve).toEqual([0.25, 0.1, 0.75, 0.9])
  })
})
