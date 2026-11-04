import { describe, expect, it } from 'vitest'
import { compileDocument } from '@core/codec/compile'
import { decompileAsset } from '@core/codec/decompile'
import { collectHao2dWarnings, HAO2D_MAGIC, HAO2D_VERSION, writeHao2d } from '@core/codec/hao2dWriter'
import { readHao2d } from '@core/codec/hao2dReader'
import { parseDocument, parseProject, serializeDocument, serializeProject } from '@core/codec/projectJson'
import { AttachmentType, BlendMode } from '@core/model/types'
import { createIkConstraint, createPathConstraint } from '@core/model/constraints'
import type { IkConstraint } from '@core/model/constraints'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from '@core/model/authoring'
import type { AuthoringIkConstraint, EditorDocument } from '@core/model/authoring'

/** 浮点经过 float32 往返后的期望值 */
function f32(value: number): number {
  return Math.fround(value)
}

function sampleDocument(): EditorDocument {
  const doc = createEmptyDocument('hero')
  doc.frameRate = 30

  // 故意乱序：子骨骼写在父骨骼之前，验证编译期拓扑排序
  doc.bones = [
    createAuthoringBone({ name: 'arm', parent: 'root', localPosition: { x: 40, y: 0 }, length: 40 }),
    createAuthoringBone({ name: 'root', parent: '', length: 40 })
  ]

  doc.slots = [
    createAuthoringSlot({ name: 'body', bone: 'root', zOrder: 0, attachment: 'body' }),
    createAuthoringSlot({ name: 'cape', bone: 'arm', zOrder: -1, attachment: 'cape' })
  ]

  doc.skins = [
    {
      name: 'default',
      slots: [
        {
          slot: 'body',
          attachments: [
            createAuthoringAttachment({ name: 'body', image: 'hero', size: { x: 80, y: 100 } }),
            createAuthoringAttachment({
              name: 'bodyMesh',
              type: 'mesh',
              image: 'hero',
              size: { x: 80, y: 100 },
              vertices: [
                { x: -40, y: -50, weights: [] },
                { x: 40, y: -50, weights: [] },
                {
                  x: 0,
                  y: 50,
                  weights: [
                    { bone: 'root', weight: 0.6 },
                    { bone: 'arm', weight: 0.4 }
                  ]
                }
              ],
              uvs: [0, 1, 1, 1, 0.5, 0],
              triangles: [0, 1, 2]
            })
          ]
        },
        {
          slot: 'cape',
          attachments: [
            createAuthoringAttachment({ name: 'cape', image: 'hero', size: { x: 40, y: 60 } })
          ]
        }
      ]
    }
  ]

  doc.constraints = [
    { ...createIkConstraint({ name: 'armIK', mix: 0.8 }), bones: ['root', 'arm'], target: 'arm' },
    { ...createPathConstraint({ name: 'capePath' }), bones: ['arm'], target: 'root' }
  ]

  const animation = createAuthoringAnim('idle', 1.5)
  animation.bones.push({
    bone: 'arm',
    translate: [],
    rotate: [
      { time: 0, value: 0, easing: 0, curve: null },
      { time: 1.5, value: 45, easing: 2, curve: [0.42, 0, 0.58, 1] }
    ],
    scale: [],
    shear: []
  })
  animation.slots.push({
    slot: 'body',
    color: [],
    displayIndex: [
      { time: 0, value: 1, easing: 1, curve: null },
      { time: 0.5, value: 0, easing: 1, curve: null }
    ],
    displayAttachment: ['bodyMesh', ''],
    visible: [],
    subArmature: []
  })
  animation.events.push({ time: 0.25, name: 'roar', stringParam: 's1', intParam: 7, floatParam: 1.5 })
  doc.animations.push(animation)

  doc.images = [{ name: 'hero', path: '/tmp/hero.png', width: 256, height: 256, loose: false }]
  return doc
}

function meshAttachmentOf(asset: ReturnType<typeof compileDocument>['asset']) {
  return asset.skins[0].slots[0].attachments[1]
}

describe('compileDocument', () => {
  it('骨骼按拓扑序排列，插槽按 zOrder 排列', () => {
    const { asset } = compileDocument(sampleDocument())
    expect(asset.bones.map((b) => b.name)).toEqual(['root', 'arm'])
    expect(asset.bones[1].parentIndex).toBe(0)
    expect(asset.slots.map((s) => s.name)).toEqual(['cape', 'body'])
    expect(asset.slots.map((s) => s.defaultZOrder)).toEqual([0, 1])
  })

  it('插槽的 setup 附件名与颜色被保留', () => {
    const { asset } = compileDocument(sampleDocument())
    const body = asset.slots.find((s) => s.name === 'body')
    expect(body?.setupAttachment).toBe('body')
    expect(body?.blendMode).toBe(BlendMode.Normal)
    expect(body?.color.r).toBeCloseTo(1, 5)
  })

  it('bindposes 数量等于骨骼数', () => {
    const { asset } = compileDocument(sampleDocument())
    expect(asset.bindposes.length).toBe(asset.bones.length * 16)
  })

  it('加权顶点被归并成 top-4 并归一化', () => {
    const mesh = meshAttachmentOf(compileDocument(sampleDocument()).asset)
    expect(mesh.type).toBe(AttachmentType.Mesh)
    expect(mesh.weights).toHaveLength(3)
    const w = mesh.weights[2]
    expect(w.w0 + w.w1).toBeCloseTo(1, 5)
    expect(Math.max(w.w0, w.w1)).toBeCloseTo(0.6, 4)
  })

  it('无权重顶点不产生权重数组（刚体路径）', () => {
    const { asset } = compileDocument(sampleDocument())
    const body = asset.skins[0].slots[0].attachments[0]
    expect(body.weights).toHaveLength(0)
    expect(body.vertices.length).toBe(0)
  })

  it('动画与约束的下标引用被正确换算', () => {
    const { asset } = compileDocument(sampleDocument())
    expect(asset.animations[0].bones[0].boneIndex).toBe(1)
    expect(asset.animations[0].slots[0].slotIndex).toBe(1)
    expect(asset.constraints[0].boneIndices).toEqual([0, 1])
    expect(asset.constraints[0].targetBoneIndex).toBe(1)
  })

  it('ik 约束的 mix 轨道同步产出 Unity 端 Hao2D 运行时风格的 iks 轨道', () => {
    const doc = sampleDocument()
    doc.animations[0].constraints.push({
      constraint: 'armIK',
      mix: [{ time: 0, value: 0, easing: 0, curve: null }],
      mixRotate: [],
      mixX: [],
      mixY: [],
      mixScaleX: [],
      mixScaleY: [],
      mixShearY: [],
      offsetRotate: [],
      offsetX: [],
      offsetY: [],
      offsetScaleX: [],
      offsetScaleY: [],
      offsetShearY: [],
      position: [],
      spacing: [],
      rotateMix: [],
      translateMix: [],
      inertia: [],
      strength: [],
      damping: [],
      mass: [],
      wind: [],
      gravity: [],
      reset: []
    })
    const { asset } = compileDocument(doc)
    expect(asset.animations[0].iks).toHaveLength(1)
    expect(asset.animations[0].iks[0].ikIndex).toBe(0)
  })

  it('缺失骨骼的引用被丢弃并给出告警', () => {
    const doc = sampleDocument()
    doc.constraints.push({ ...createIkConstraint({ name: 'ghost' }), bones: ['notExist'], target: '' })
    doc.animations[0].bones.push({ bone: 'ghost', translate: [], rotate: [], scale: [], shear: [] })
    const { asset, warnings } = compileDocument(doc)
    expect(asset.constraints.map((c) => c.name)).not.toContain('ghost')
    expect(asset.animations[0].bones).toHaveLength(1)
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true)
  })
})

describe('decompileAsset', () => {
  it('编译后再反编译，顶点回到附件显示空间', () => {
    const back = decompileAsset(compileDocument(sampleDocument()).asset)
    const mesh = back.skins[0].slots.find((s) => s.slot === 'body')?.attachments[1]
    expect(mesh?.vertices).toHaveLength(3)
    expect(mesh?.vertices[2].x).toBeCloseTo(0, 3)
    expect(mesh?.vertices[2].y).toBeCloseTo(50, 3)
    expect(mesh?.vertices[0].x).toBeCloseTo(-40, 3)
    expect(mesh?.vertices[0].y).toBeCloseTo(-50, 3)
    expect(mesh?.vertices[1].x).toBeCloseTo(40, 3)
  })

  it('权重按骨骼名还原', () => {
    const back = decompileAsset(compileDocument(sampleDocument()).asset)
    const mesh = back.skins[0].slots.find((s) => s.slot === 'body')?.attachments[1]
    const names = mesh?.vertices[2].weights.map((w) => w.bone).sort()
    expect(names).toEqual(['arm', 'root'])
  })

  it('骨骼父子关系与动画轨道名被还原', () => {
    const back = decompileAsset(compileDocument(sampleDocument()).asset)
    expect(back.bones.map((b) => b.name)).toEqual(['root', 'arm'])
    expect(back.bones[1].parent).toBe('root')
    expect(back.animations[0].bones[0].bone).toBe('arm')
    expect(back.animations[0].slots[0].slot).toBe('body')
  })

  it('约束还原为名字引用', () => {
    const back = decompileAsset(compileDocument(sampleDocument()).asset)
    const ik = back.constraints.find((c) => c.type === 'ik')
    expect(ik?.bones).toEqual(['root', 'arm'])
    expect(ik?.target).toBe('arm')
  })

  it('图集页信息被带入工程文档', () => {
    const back = decompileAsset(compileDocument(sampleDocument()).asset)
    expect(back.images.map((i) => i.name)).toEqual(['hero'])
  })
})

describe('.hao2d v5 二进制', () => {
  it('文件头为 MAGIC + VERSION', () => {
    const { asset } = compileDocument(sampleDocument())
    const bytes = writeHao2d(asset)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(HAO2D_MAGIC)
    expect(view.getUint16(4, true)).toBe(HAO2D_VERSION)
    expect(bytes[0]).toBe(0x48)
    expect(bytes[1]).toBe(0x4f)
  })

  it('写入后再读出，关键字段保持一致', () => {
    const { asset } = compileDocument(sampleDocument())
    const { asset: back } = readHao2d(writeHao2d(asset))

    expect(back.armatureName).toBe(asset.armatureName)
    expect(back.frameRate).toBeCloseTo(asset.frameRate, 5)
    expect(back.bones.map((b) => b.name)).toEqual(asset.bones.map((b) => b.name))
    expect(back.bones.map((b) => b.parentIndex)).toEqual(asset.bones.map((b) => b.parentIndex))
    expect(back.bones[1].localPosition.x).toBeCloseTo(40, 4)
    expect(back.bones[1].localShear.y).toBeCloseTo(asset.bones[1].localShear.y, 5)
    expect(back.slots.map((s) => s.name)).toEqual(asset.slots.map((s) => s.name))
    expect(back.slots.map((s) => s.setupAttachment)).toEqual(asset.slots.map((s) => s.setupAttachment))
    expect(back.textureNames).toEqual(asset.textureNames)
    expect(back.skins).toHaveLength(asset.skins.length)
    expect(back.defaultSkinIndex).toBe(asset.defaultSkinIndex)
    expect(back.bindposes.length).toBe(asset.bindposes.length)
  })

  it('附件的 UV / 顶点 / 三角形 / 权重往返一致', () => {
    const { asset } = compileDocument(sampleDocument())
    const { asset: back } = readHao2d(writeHao2d(asset))
    const original = meshAttachmentOf(asset)
    const roundTrip = meshAttachmentOf(back)

    expect(roundTrip.name).toBe(original.name)
    expect(roundTrip.type).toBe(original.type)
    expect(Array.from(roundTrip.uvs)).toEqual(Array.from(original.uvs))
    expect(Array.from(roundTrip.vertices)).toEqual(Array.from(original.vertices))
    expect(roundTrip.triangles).toEqual(original.triangles)
    expect(roundTrip.weights).toHaveLength(original.weights.length)
    for (let i = 0; i < original.weights.length; i++) {
      expect(roundTrip.weights[i].b0).toBe(original.weights[i].b0)
      expect(roundTrip.weights[i].lx0).toBeCloseTo(original.weights[i].lx0, 4)
      expect(roundTrip.weights[i].w0).toBeCloseTo(original.weights[i].w0, 5)
    }
  })

  it('动画关键帧（含 easing / curve）往返一致', () => {
    const { asset } = compileDocument(sampleDocument())
    const { asset: back } = readHao2d(writeHao2d(asset))
    const rotate = back.animations[0].bones[0].rotate
    expect(rotate).toHaveLength(2)
    expect(rotate[1].value).toBeCloseTo(45, 4)
    expect(rotate[1].easing).toBe(2)
    expect(rotate[1].curve).toEqual([0.42, 0, 0.58, 1].map(f32))
    expect(rotate[0].curve).toBeNull()
    expect(back.animations[0].events[0].name).toBe('roar')
    expect(back.animations[0].events[0].intParam).toBe(7)
    expect(back.animations[0].slots[0].displayAttachment).toEqual(['bodyMesh', ''])
  })

  it('IK 约束以 sbyte 写入 bendSign 且往返一致', () => {
    const doc = sampleDocument()
    const ik = doc.constraints[0] as AuthoringIkConstraint
    ik.bendSign = -1
    const { asset } = compileDocument(doc)
    const { asset: back } = readHao2d(writeHao2d(asset))
    expect(back.constraints).toHaveLength(1)
    const roundTrip = back.constraints[0] as IkConstraint
    expect(roundTrip.type).toBe('ik')
    expect(roundTrip.bendSign).toBe(-1)
  })

  it('bindposes 逐值往返一致', () => {
    const { asset } = compileDocument(sampleDocument())
    const { asset: back } = readHao2d(writeHao2d(asset))
    for (let i = 0; i < asset.bindposes.length; i++) {
      expect(back.bindposes[i]).toBeCloseTo(asset.bindposes[i], 5)
    }
  })

  it('版本号不匹配时抛出可读错误', () => {
    const { asset } = compileDocument(sampleDocument())
    const bytes = writeHao2d(asset)
    bytes[4] = 3
    bytes[5] = 0
    expect(() => readHao2d(bytes)).toThrow(/不支持的数据版本/)
  })

  it('文件头不匹配时抛出可读错误', () => {
    expect(() => readHao2d(new Uint8Array(32))).toThrow(/文件头不匹配/)
  })

  it('导出告警会列出被丢弃的非 IK 约束', () => {
    const { asset } = compileDocument(sampleDocument())
    const warnings = collectHao2dWarnings(asset)
    expect(warnings.some((w) => w.includes('只能表达 IK'))).toBe(true)
  })
})

describe('.hao2d 与 Unity 端 Hao2D 运行时的字节语义', () => {
  /** 一个含真网格（带顶点/UV/权重/三角形）的工程 */
  function docWithMesh(): EditorDocument {
    const doc = createEmptyDocument('t')
    doc.bones = [createAuthoringBone({ name: 'root', length: 1 })]
    doc.slots = [createAuthoringSlot({ name: 'body', bone: 'root', attachment: 'crown', zOrder: 0 })]
    const mesh = createAuthoringAttachment({ name: 'crown', type: 'mesh', image: 'crown.png', size: { x: 2, y: 2 } })
    // 顶点值取成便于在字节里定位的特殊序列（0.125 是 2 的负幂，float32 精确表示）
    const verts = [
      { x: 0.125, y: -0.25, weights: [{ bone: 'root', weight: 1 }] },
      { x: 0.375, y: -0.5, weights: [{ bone: 'root', weight: 1 }] },
      { x: 0.625, y: -0.75, weights: [{ bone: 'root', weight: 1 }] }
    ]
    mesh.vertices = verts
    mesh.uvs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    mesh.triangles = [0, 1, 2]
    mesh.edges = [0, 1, 2]
    mesh.hull = 3
    doc.skins = [{ name: 'default', slots: [{ slot: 'body', attachments: [mesh] }] }]
    return doc
  }

  /** 在字节里定位某个 float32 值（小端）首次出现的位置 */
  function findFloat32(bytes: Uint8Array, value: number): number {
    const needle = new Uint8Array(new Float32Array([value]).buffer)
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === needle[0] && bytes[i + 1] === needle[1] && bytes[i + 2] === needle[2] && bytes[i + 3] === needle[3]) {
        return i
      }
    }
    return -1
  }

  it('vertices 写的是「float2 元素个数」而不是 float 总数（否则 Unity 会多读一倍并错位）', () => {
    const doc = docWithMesh()
    const { asset } = compileDocument(doc)
    const bytes = writeHao2d(asset)

    const firstVertexAt = findFloat32(bytes, 0.125)
    expect(firstVertexAt).toBeGreaterThan(4)

    // 顶点数据前面紧挨着的就是长度字段：Unity 端 Hao2D 运行时用 ReadFloat2Array（按 float2 个数读）
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt32(firstVertexAt - 4, true)).toBe(3)

    // 同样地，uvs 段也是元素个数（本来就对，这里一起锁住）
    const uvAt = findFloat32(bytes, 0.1)
    expect(view.getInt32(uvAt - 4, true)).toBe(3)
  })

  it('导出的文件能被「Unity 端 Hao2D 运行时语义」完整解析到底（附件段不越界）', () => {
    const doc = docWithMesh()
    const { asset } = compileDocument(doc)
    const bytes = writeHao2d(asset)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    // 完全按 Hao2DCodec.Read 的字段顺序与语义（uvs/vertices 都是 float2 元素个数）
    let p = 0
    const i32 = (): number => {
      const n = view.getInt32(p, true)
      p += 4
      return n
    }
    const f32 = (): void => {
      p += 4
    }
    const bool = (): void => {
      p += 1
    }
    const str = (): void => {
      const n = i32()
      p += Math.max(0, n)
    }
    const f2 = (): number => {
      const n = i32()
      p += n * 8
      return n
    }
    const iArr = (): void => {
      const n = i32()
      p += n * 4
    }
    const weights = (): void => {
      const n = i32()
      p += n * 64 // 4×int32 + 12×float32
    }
    const attachment = (): void => {
      str() // name
      i32() // type
      f32()
      f32() // position
      f32() // rotation
      f32()
      f32() // scale
      f32()
      f32() // size
      // v6 新增：contentOffset（2 个 float）。附件段只写 Unity 端 Hao2D 运行时认识的字段，
      // 多写一个字段后面全部错位（Unity 侧即 EndOfStreamException）。
      f32()
      f32() // contentOffset
      f32()
      f32()
      f32()
      f32() // color
      str() // textureName
      f2() // uvs：元素个数
      f2() // vertices：元素个数 ← 之前这里写成 float 总数导致 Unity 越界
      iArr() // triangles
      iArr() // edges
      i32() // hull
      weights()
      str() // linkedMeshSkin
      str() // linkedMeshAttachment
      bool() // ffdInBoneSpace
    }

    expect(i32()).toBe(HAO2D_MAGIC)
    expect(view.getUint16(p, true)).toBe(HAO2D_VERSION)
    p += 2
    str() // armatureName
    f32() // frameRate
    const boneCount = i32()
    for (let i = 0; i < boneCount; i++) {
      str() // name
      i32() // parentIndex
      f32()
      f32() // localPosition
      f32() // rotation
      f32()
      f32() // localScale
      f32()
      f32() // localShear
      bool() // inheritRotation
      bool() // inheritScale
      f32() // length
    }
    const slotCount = i32()
    for (let i = 0; i < slotCount; i++) {
      str()
      str()
      i32()
      f32()
      f32()
      f32()
      f32()
      i32()
      i32()
      i32()
      f32()
    }
    const skinCount = i32()
    for (let i = 0; i < skinCount; i++) {
      str()
      const skinSlotCount = i32()
      for (let j = 0; j < skinSlotCount; j++) {
        str()
        const attCount = i32()
        for (let k = 0; k < attCount; k++) attachment()
      }
    }

    // 关键：到此为止必须完整落在文件范围内（此前越界正是 Unity 报 EndOfStreamException 的原因）
    expect(p).toBeLessThanOrEqual(bytes.length)
    // 附件段之后还有 iks / animations / bindposes 等，不能已经吃光整个文件
    expect(p).toBeLessThan(bytes.length)
  })

  it('网格附件的顶点/UV/三角形经读写往返完全一致（Unity 读法下不会错位）', () => {
    const doc = docWithMesh()
    const { asset } = compileDocument(doc)
    const read = readHao2d(writeHao2d(asset)) as unknown as { asset: typeof asset }
    const original = asset.skins[0].slots[0].attachments[0]
    const restored = read.asset.skins[0].slots[0].attachments[0]

    expect(restored.type).toBe(AttachmentType.Mesh)
    expect([...restored.vertices]).toEqual([...original.vertices])
    expect([...restored.uvs]).toEqual([...original.uvs])
    expect(restored.triangles).toEqual(original.triangles)
    expect(restored.edges).toEqual(original.edges)
    expect(restored.hull).toBe(original.hull)
    expect(restored.weights.length).toBe(original.weights.length)
  })
})

describe('工程 JSON', () => {
  it('序列化后解析回来保持等价', () => {
    const doc = sampleDocument()
    const { document: back, warnings } = parseDocument(serializeDocument(doc))
    expect(warnings).toEqual([])
    expect(back.armatureName).toBe('hero')
    expect(back.bones).toHaveLength(2)
    // 工程文件保留作者书写顺序（cape 的 zOrder 更小但写在后面）
    expect(back.bones[0].name).toBe('arm')
    expect(back.slots[0].name).toBe('body')
    expect(back.slots[1].name).toBe('cape')
    expect(back.skins[0].slots[0].attachments[1].type).toBe('mesh')
    expect(back.skins[0].slots[0].attachments[1].vertices[2].weights).toHaveLength(2)
    expect(back.constraints[0].bones).toEqual(['root', 'arm'])
    expect(back.animations[0].events[0].name).toBe('roar')
    expect(back.editorMeta.viewport.zoom).toBe(1)
    expect(back.runtimeIK).toBe(true)
  })

  it('缺字段的旧文件被补齐默认值', () => {
    const { document, warnings } = parseDocument('{"armatureName":"legacy","bones":[{"name":"b1"}]}')
    expect(document.bones).toHaveLength(1)
    expect(document.bones[0].localScale).toEqual({ x: 1, y: 1 })
    expect(document.bones[0].inheritRotation).toBe(true)
    expect(document.skins).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('皮肤')
  })

  it('笔刷参数按 Strength / Feather 读写（Mode / Size / Strength / Feather / Normalize）', () => {
    const { document } = parseDocument(
      JSON.stringify({
        armatureName: 'brush',
        editorMeta: { brush: { mode: 'smooth', size: 80, strength: 30, feather: 20, normalize: false } }
      })
    )
    expect(document.editorMeta.brush).toEqual({
      mode: 'smooth',
      size: 80,
      strength: 30,
      feather: 20,
      normalize: false
    })
  })

  it('旧工程的笔刷参数（radius / strength 0..1 / 方向模式）被读成新参数', () => {
    const { document } = parseDocument(
      JSON.stringify({
        armatureName: 'legacy-brush',
        editorMeta: { brush: { radius: 64, strength: 0.02, mode: 'subtract' } }
      })
    )
    // 老的 add / subtract / replace 都属于「影响周围所有顶点」→ addSubtract；strength 是 0..1 → ×100
    expect(document.editorMeta.brush).toEqual({
      mode: 'addSubtract',
      size: 64,
      strength: 2,
      feather: 50,
      normalize: true
    })
  })

  it('只有 hardness（每笔增量）的老工程：换不回上限语义，回退默认 Strength', () => {
    const { document } = parseDocument(
      JSON.stringify({
        armatureName: 'hardness-brush',
        editorMeta: { brush: { mode: 'smooth', size: 80, hardness: 30, normalize: false } }
      })
    )
    expect(document.editorMeta.brush).toEqual({
      mode: 'smooth',
      size: 80,
      strength: 40,
      feather: 50,
      normalize: false
    })
  })

  it('多骨架工程：骨架逐个写出、图片池只写一份、当前骨架下标保留', () => {
    const first = parseDocument(JSON.stringify({ armatureName: '骨架A', bones: [{ name: 'a' }] })).document
    const second = parseDocument(JSON.stringify({ armatureName: '骨架B', bones: [{ name: 'b' }] })).document
    const pool = [{ name: 'tex', path: '/p/tex.png', width: 8, height: 8, loose: false }]
    const text = serializeProject(
      [
        { ...first, images: pool },
        { ...second, images: pool }
      ],
      1
    )

    const raw = JSON.parse(text) as Record<string, unknown>
    // 顶层仍是「当前骨架」的扁平字段（老版本编辑器读到的就是它）
    expect(raw.armatureName).toBe('骨架B')
    expect(raw.activeSkeleton).toBe(1)
    expect(Array.isArray(raw.skeletons)).toBe(true)
    // 图片池只在顶层写一份：骨架部分不带 images
    expect((raw.skeletons as Array<Record<string, unknown>>)[0]).not.toHaveProperty('images')

    const parsed = parseProject(text)
    expect(parsed.activeSkeleton).toBe(1)
    expect(parsed.skeletons.map((skeleton) => skeleton.armatureName)).toEqual(['骨架A', '骨架B'])
    expect(parsed.skeletons[0].bones.map((bone) => bone.name)).toEqual(['a'])
    expect(parsed.skeletons[1].bones.map((bone) => bone.name)).toEqual(['b'])
    // 两个骨架共享同一份图片池
    expect(parsed.skeletons[0].images).toEqual(pool)
    expect(parsed.skeletons[1].images).toEqual(pool)
  })

  it('插槽锁定随工程存取：写出后能读回来，缺字段的老工程按未锁定处理', () => {
    const doc = parseDocument(
      JSON.stringify({
        armatureName: 'locked',
        bones: [{ name: 'root' }],
        slots: [{ name: 's1', bone: 'root' }]
      })
    ).document
    // 新字段默认未锁定
    expect(doc.slots[0].locked).toBe(false)

    doc.slots[0].locked = true
    const parsed = parseProject(serializeProject([doc], 0))
    expect(parsed.skeletons[0].slots[0].locked).toBe(true)

    // 老工程里没有这个字段 → 未锁定（不会把老工程的插槽误锁上）
    const legacy = parseProject(JSON.stringify({ armatureName: 'old', slots: [{ name: 's1' }] }))
    expect(legacy.skeletons[0].slots[0].locked).toBe(false)
  })

  it('单骨架工程写出的文件与老格式一致（不带 skeletons / activeSkeleton）', () => {
    const doc = parseDocument(JSON.stringify({ armatureName: 'solo', bones: [{ name: 'b1' }] })).document
    const raw = JSON.parse(serializeProject([doc], 0)) as Record<string, unknown>
    expect(raw.skeletons).toBeUndefined()
    expect(raw.activeSkeleton).toBeUndefined()
    expect(raw.armatureName).toBe('solo')
    expect(parseProject(serializeProject([doc], 0)).skeletons).toHaveLength(1)
  })

  it('老工程（顶层就是一份骨架）被读成「一个骨架」', () => {
    const parsed = parseProject(JSON.stringify({ armatureName: 'legacy', bones: [{ name: 'b1' }] }))
    expect(parsed.skeletons).toHaveLength(1)
    expect(parsed.skeletons[0].armatureName).toBe('legacy')
    expect(parsed.activeSkeleton).toBe(0)
  })

  it('非法内容被纠正并告警', () => {
    const { document, warnings } = parseDocument('"not an object"')
    expect(document.bones).toEqual([])
    expect(warnings.some((w) => w.includes('不是对象'))).toBe(true)
  })

  it('父骨骼缺失时给出告警', () => {
    const { warnings } = parseDocument('{"bones":[{"name":"child","parent":"missing"}]}')
    expect(warnings.some((w) => w.includes('missing'))).toBe(true)
  })

  it('约束缺字段时按类型补默认值', () => {
    const { document } = parseDocument('{"constraints":[{"type":"transform","name":"t"}]}')
    const constraint = document.constraints[0]
    expect(constraint.type).toBe('transform')
    if (constraint.type === 'transform') {
      expect(constraint.mixRotate).toBe(1)
      expect(constraint.inherit).toBe('normal')
    }
  })

  it('工程文档编译成 Runtime 后能再写读 .hao2d', () => {
    const { document } = parseDocument(serializeDocument(sampleDocument()))
    const { asset } = compileDocument(document)
    const { asset: roundTrip } = readHao2d(writeHao2d(asset))
    expect(roundTrip.bones.map((b) => b.name)).toEqual(['root', 'arm'])
    expect(roundTrip.animations[0].name).toBe('idle')
  })
})

describe('裁剪图的「原图尺寸」信息', () => {
  it('工程存盘往返不丢、编译进运行时带着（编辑器画框用）；.hao2d 只写 contentOffset', () => {
    const doc = createEmptyDocument('trim')
    doc.bones.push(createAuthoringBone({ name: 'root' }))
    doc.slots.push(createAuthoringSlot({ name: 'beak_lower', bone: 'root', attachment: 'beak_lower' }))
    // createEmptyDocument 已经带了一个空的 default 皮肤，往它里面塞
    doc.skins[0].slots.push({
      slot: 'beak_lower',
      attachments: [
        createAuthoringAttachment({
          name: 'beak_lower',
          image: 'p.png',
          // 内容 39×14（图集里有像素的那块），原图 73×53（含裁剪留白）
          position: { x: 0.260849, y: -0.129644 },
          rotation: -167,
          size: { x: 0.39, y: 0.14 },
          frameSize: { x: 0.73, y: 0.53 },
          contentOffset: { x: 0.07, y: -0.145 }
        })
      ]
    })

    const { document } = parseDocument(serializeDocument(doc))
    const att = document.skins[0].slots[0].attachments[0]
    expect(att.frameSize.x).toBeCloseTo(0.73, 5)
    expect(att.frameSize.y).toBeCloseTo(0.53, 5)
    expect(att.contentOffset.x).toBeCloseTo(0.07, 5)
    expect(att.contentOffset.y).toBeCloseTo(-0.145, 5)

    const { asset } = compileDocument(document)
    const runtimeAtt = asset.skins[0].slots[0].attachments[0]
    // 渲染四边形仍按内容尺寸；原图信息只是搭车过去给编辑器画框
    expect(runtimeAtt.size.x).toBeCloseTo(0.39, 5)
    expect(runtimeAtt.frameSize.x).toBeCloseTo(0.73, 5)
    expect(runtimeAtt.contentOffset.y).toBeCloseTo(-0.145, 5)

    /*
     * 导出侧：.hao2d（v6）必须带 `contentOffset` —— Unity 就靠它把裁剪块放回原位，丢了零件会错位。
     *
     * `frameSize` 是**编辑器内部**信息（检查器显示、选中框），**不进二进制**：Unity 端 Hao2D 运行时的
     * `AttachmentData` 没有这个字段，多写 8 字节会让读端从附件段开始整体错位，Unity 侧报
     * EndOfStreamException。展示用的原图尺寸请存工程 JSON。
     */
    const { asset: exported } = readHao2d(writeHao2d(asset))
    const exportedAtt = exported.skins[0].slots[0].attachments[0]
    expect(exportedAtt.size.x).toBeCloseTo(0.39, 5)
    expect(exportedAtt.contentOffset.x).toBeCloseTo(0.07, 5)
    expect(exportedAtt.contentOffset.y).toBeCloseTo(-0.145, 5)
    expect(exportedAtt.frameSize.x).toBe(0)
    expect(exportedAtt.frameSize.y).toBe(0)
  })
})
