import { BlendMode } from './model/types'
import {
  createAuthoringAnim,
  createAuthoringAttachment,
  createAuthoringBone,
  createAuthoringSlot,
  createEmptyDocument
} from './model/authoring'
import type { AuthoringAnimData, AuthoringAttachment, AuthoringVertex, EditorDocument } from './model/authoring'

/**
 * 示例工程 fixture：躯干（带权重蒙皮）+ 头 + 双臂 + 双腿的简笔角色。
 *
 * 注意：**不再在启动时自动载入**（启动改为自动打开上次的工程），
 * 现在只作为单元测试 / 冒烟验证的数据来源。
 *
 * 约定：附件顶点一律写在**骨骼局部空间**，沿骨骼的 +X 方向延伸，
 * 这样骨骼旋转后肢体方向自然正确（这也是编辑器新建网格时的默认约定）。
 * 不依赖任何外部图片：图集页为空时渲染为纯色块。
 */
export function createSampleDocument(): EditorDocument {
  const doc = createEmptyDocument('sample-hero')
  doc.frameRate = 30

  doc.bones = [
    // 躯干：从髋部指向上方
    createAuthoringBone({ name: 'root', parent: '', rotation: 90, length: 0.55, color: '#8B5CF6' }),
    createAuthoringBone({ name: 'chest', parent: 'root', localPosition: { x: 0.55, y: 0 }, rotation: 0, length: 0.35, color: '#F97316' }),
    createAuthoringBone({ name: 'head', parent: 'chest', localPosition: { x: 0.35, y: 0 }, rotation: 0, length: 0.3, color: '#FBBF24' }),
    createAuthoringBone({ name: 'armL', parent: 'chest', localPosition: { x: 0.3, y: 0 }, rotation: 55, length: 0.5, color: '#0A84FF' }),
    createAuthoringBone({ name: 'armR', parent: 'chest', localPosition: { x: 0.3, y: 0 }, rotation: -55, length: 0.5, color: '#0A84FF' }),
    createAuthoringBone({ name: 'legL', parent: 'root', localPosition: { x: 0, y: 0 }, rotation: -70, length: 0.62, color: '#34D399' }),
    createAuthoringBone({ name: 'legR', parent: 'root', localPosition: { x: 0, y: 0 }, rotation: -110, length: 0.62, color: '#34D399' })
  ]

  doc.slots = [
    createAuthoringSlot({ name: 'legL', bone: 'legL', zOrder: 0, attachment: 'legL', color: '#34D399FF' }),
    createAuthoringSlot({ name: 'legR', bone: 'legR', zOrder: 1, attachment: 'legR', color: '#10B981FF', blendMode: BlendMode.Normal }),
    createAuthoringSlot({ name: 'torso', bone: 'root', zOrder: 2, attachment: 'torso', color: '#E8E8F2FF' }),
    createAuthoringSlot({ name: 'armL', bone: 'armL', zOrder: 3, attachment: 'armL', color: '#22D3EEFF' }),
    createAuthoringSlot({ name: 'armR', bone: 'armR', zOrder: 4, attachment: 'armR', color: '#0EA5E9FF' }),
    createAuthoringSlot({ name: 'head', bone: 'head', zOrder: 5, attachment: 'head', color: '#FBBF24FF' })
  ]

  doc.skins = [
    {
      name: 'default',
      slots: [
        { slot: 'legL', attachments: [limb('legL', 0.62, 0.13)] },
        { slot: 'legR', attachments: [limb('legR', 0.62, 0.13)] },
        { slot: 'torso', attachments: [createTorsoMesh(), limb('torsoRegion', 0.9, 0.18)] },
        { slot: 'armL', attachments: [limb('armL', 0.5, 0.11)] },
        { slot: 'armR', attachments: [limb('armR', 0.5, 0.11)] },
        { slot: 'head', attachments: [limb('head', 0.3, 0.3)] }
      ]
    }
  ]

  doc.animations.push(createIdleAnimation())
  doc.animations.push(createSwapAnimation())

  return doc
}

/** 沿骨骼 +X 方向、以骨骼原点为起点的一段肢体 */
function limb(name: string, length: number, thickness: number): AuthoringAttachment {
  return createAuthoringAttachment({
    name,
    type: 'region',
    size: { x: length, y: thickness },
    position: { x: length * 0.5, y: 0 }
  })
}

/**
 * 躯干网格：三段脊柱分别绑到 root / 混合 / chest，
 * 用于演示加权蒙皮（旋转 chest 时上半身会自然弯折）。
 */
function createTorsoMesh(): AuthoringAttachment {
  const w = 0.09
  const vertices: AuthoringVertex[] = [
    { x: 0, y: -w, weights: [{ bone: 'root', weight: 1 }] },
    { x: 0, y: w, weights: [{ bone: 'root', weight: 1 }] },
    { x: 0.55, y: w, weights: [{ bone: 'root', weight: 0.5 }, { bone: 'chest', weight: 0.5 }] },
    { x: 0.55, y: -w, weights: [{ bone: 'root', weight: 0.5 }, { bone: 'chest', weight: 0.5 }] },
    { x: 0.9, y: -w, weights: [{ bone: 'chest', weight: 1 }] },
    { x: 0.9, y: w, weights: [{ bone: 'chest', weight: 1 }] }
  ]
  return createAuthoringAttachment({
    name: 'torso',
    type: 'mesh',
    size: { x: 0.9, y: w * 2 },
    vertices,
    uvs: [0, 0.5, 0, 1, 0.6, 1, 0.6, 0.5, 1, 0.5, 1, 1],
    triangles: [0, 1, 2, 0, 2, 3, 3, 2, 4, 4, 2, 5]
  })
}

/** 摆臂 + 躯干颜色脉冲 + 一个帧事件 */
function createIdleAnimation(): AuthoringAnimData {
  const idle = createAuthoringAnim('idle', 1.5)
  const wave = (bone: string, from: number, to: number): void => {
    idle.bones.push({
      bone,
      translate: [],
      rotate: [
        { time: 0, value: from, easing: 0, curve: null },
        { time: 0.75, value: to, easing: 2, curve: [0.42, 0, 0.58, 1] },
        { time: 1.5, value: from, easing: 1, curve: null }
      ],
      scale: [],
      shear: []
    })
  }
  wave('armL', 55, 95)
  wave('armR', -55, -95)

  idle.slots.push({
    slot: 'torso',
    color: [
      { time: 0, value: { r: 1, g: 1, b: 1, a: 1 }, easing: 0, curve: null },
      { time: 0.75, value: { r: 0.55, g: 0.85, b: 1, a: 1 }, easing: 0, curve: null },
      { time: 1.5, value: { r: 1, g: 1, b: 1, a: 1 }, easing: 0, curve: null }
    ],
    displayIndex: [],
    displayAttachment: [],
    visible: []
  })
  idle.events.push({ time: 0.75, name: 'wavePeak', stringParam: 'wave', intParam: 1, floatParam: 1 })
  return idle
}

/** 只切附件的动画：演示 torso 插槽在网格与矩形之间切换 */
function createSwapAnimation(): AuthoringAnimData {
  const swap = createAuthoringAnim('swap', 1)
  swap.slots.push({
    slot: 'torso',
    color: [],
    displayIndex: [
      { time: 0, value: 0, easing: 1, curve: null },
      { time: 0.5, value: 1, easing: 1, curve: null }
    ],
    displayAttachment: ['torso', 'torsoRegion'],
    visible: []
  })
  return swap
}
