import type { Vec2 } from '../math/matrix'
import type { RGBA } from './types'
import { BlendMode } from './types'
import type { IkConstraint, PathConstraint, PhysicsConstraint, TransformConstraint } from './constraints'
import type {
  ColorKeyframe,
  ConstraintAnim,
  DeformKeyframe,
  EventKeyframe,
  Float2Keyframe,
  FloatKeyframe,
  IntKeyframe
} from './animation'

/**
 * 编辑期（Authoring）模型：面向用户与工程文件，所有引用都用**名字**而不是下标，
 * 这样重排骨骼 / 改皮肤不会让动画数据错位。
 * 渲染与导出前由 `core/codec/compile.ts` 编译成 Runtime 模型。
 */

/** 名字引用：把 Runtime 约束里的下标字段换成名字 */
type NameRefs<T> = Omit<T, 'boneIndices' | 'targetBoneIndex'>
export type AuthoringIkConstraint = NameRefs<IkConstraint> & { bones: string[]; target: string }
export type AuthoringTransformConstraint = NameRefs<TransformConstraint> & { bones: string[]; target: string }
export type AuthoringPathConstraint = NameRefs<PathConstraint> & { bones: string[]; target: string }
export type AuthoringPhysicsConstraint = NameRefs<PhysicsConstraint> & { bones: string[]; target: string }
export type AuthoringConstraint =
  | AuthoringIkConstraint
  | AuthoringTransformConstraint
  | AuthoringPathConstraint
  | AuthoringPhysicsConstraint

export interface AuthoringBone {
  name: string
  /** 父骨骼名，空串 = 根 */
  parent: string
  localPosition: Vec2
  /** 度 */
  rotation: number
  localScale: Vec2
  localShear: Vec2
  inheritRotation: boolean
  inheritScale: boolean
  /** 长度，供骨架显示与 IK 求解 */
  length: number
  /** 编辑器辅助 */
  color: string
  locked: boolean
  /** 骨骼显示为空心（只描边不填充），默认 false = 实心 */
  hollow?: boolean
}

export interface AuthoringWeight {
  bone: string
  weight: number
}

/** 顶点存放在**附件显示空间**（与 Region/Mesh 的 vertices 同空间），权重按骨骼名稀疏存储 */
export interface AuthoringVertex {
  x: number
  y: number
  weights: AuthoringWeight[]
}

export type AuthoringAttachmentType = 'region' | 'mesh' | 'linkedmesh' | 'boundingbox'

export interface AuthoringAttachment {
  name: string
  type: AuthoringAttachmentType
  /** 图集页 / 图片名 */
  image: string
  position: Vec2
  /** 度 */
  rotation: number
  scale: Vec2
  /** Region 显示尺寸 */
  size: Vec2
  color: string
  /** Mesh 顶点（含权重）；Region 为空 */
  vertices: AuthoringVertex[]
  /** UV（归一化 0..1，v 已翻转）；Region 为 4 组 */
  uvs: number[]
  triangles: number[]
  edges: number[]
  hull: number
  /**
   * FFD 偏移所处空间（与 Runtime 语义一致）：
   * - false（编辑器新建的附件默认）：偏移在附件显示空间，加权蒙皮时先经 bindpose 做方向变换
   * - true：偏移已是骨内坐标（Spine 导入的附件）
   */
  ffdInBoneSpace: boolean
  linkedMeshSkin: string
  linkedMeshAttachment: string
  /**
   * 由 Region 转来的 Mesh 会保留源 Region 的显示信息，
   * 「还原为 Region」靠它恢复原尺寸与原 UV；没有快照（如导入的网格）只能按顶点包围盒近似。
   */
  regionSnapshot?: { size: Vec2; uvs: number[] }
  /**
   * 该网格**绑定**的骨骼（权重骨骼列表）：检查器里逐根添加 / 移除，
   * 「自动计算权重」只对这些骨骼生效（不会把别处的权重算进来）。
   * 空 / 未设置时按「顶点权重里出现过的骨骼」推断，兼容老工程与手动刷过权重的网格。
   */
  bones?: string[]
}

export interface AuthoringSkinSlot {
  slot: string
  attachments: AuthoringAttachment[]
}

export interface AuthoringSkin {
  name: string
  slots: AuthoringSkinSlot[]
}

export interface AuthoringSlot {
  name: string
  bone: string
  color: string
  blendMode: BlendMode
  /** 绘制层序（越小越先绘制） */
  zOrder: number
  z: number
  /** setup pose 显示的附件名，空串 = 不显示 */
  attachment: string
  visible: boolean
}

export interface AuthoringImage {
  name: string
  path: string
  width: number
  height: number
  /** 是否为独立碎图（需要在导出时打包进图集） */
  loose: boolean
}

// ---------------- 动画（名字引用） ----------------

export interface AuthoringBoneAnim {
  bone: string
  translate: Float2Keyframe[]
  rotate: FloatKeyframe[]
  scale: Float2Keyframe[]
  shear: Float2Keyframe[]
}

export interface AuthoringSlotAnim {
  slot: string
  color: ColorKeyframe[]
  displayIndex: IntKeyframe[]
  displayAttachment: string[]
  visible: IntKeyframe[]
}

export interface AuthoringDeformAnim {
  slot: string
  attachment: string
  frames: DeformKeyframe[]
}

export interface AuthoringDrawOrderKeyframe {
  time: number
  /** 该时刻完整的插槽绘制顺序（插槽名） */
  order: string[]
}

export interface AuthoringConstraintAnim {
  constraint: string
  mix: FloatKeyframe[]
  mixRotate: FloatKeyframe[]
  mixX: FloatKeyframe[]
  mixY: FloatKeyframe[]
  mixScaleX: FloatKeyframe[]
  mixScaleY: FloatKeyframe[]
  mixShearY: FloatKeyframe[]
  offsetRotate: FloatKeyframe[]
  offsetX: FloatKeyframe[]
  offsetY: FloatKeyframe[]
  offsetScaleX: FloatKeyframe[]
  offsetScaleY: FloatKeyframe[]
  offsetShearY: FloatKeyframe[]
  position: FloatKeyframe[]
  spacing: FloatKeyframe[]
  rotateMix: FloatKeyframe[]
  translateMix: FloatKeyframe[]
}

export interface AuthoringAnimData {
  name: string
  /** 秒 */
  duration: number
  bones: AuthoringBoneAnim[]
  slots: AuthoringSlotAnim[]
  deforms: AuthoringDeformAnim[]
  drawOrder: AuthoringDrawOrderKeyframe[]
  events: EventKeyframe[]
  constraints: AuthoringConstraintAnim[]
}

export interface EditorMeta {
  /** 停靠面板尺寸（按布局 key） */
  layout: Record<string, number>
  viewport: { x: number; y: number; zoom: number }
  activeSkin: string
  activeAnimation: string
  /** 视口叠加层开关（无「网格」：网格显示由选中项驱动） */
  overlay: { bones: boolean; weight: boolean; ffd: boolean; constraints: boolean }
  /** 权重画笔参数 */
  brush: { radius: number; strength: number; mode: 'add' | 'subtract' | 'replace' }
}

export const CURRENT_SCHEMA_VERSION = 1

export interface EditorDocument {
  schemaVersion: number
  armatureName: string
  frameRate: number
  /**
   * 运行期是否跑 IK 求解。
   * 导入 Spine 逐帧烘焙资源时为 false（IK 已反算进骨骼轨道）。
   */
  runtimeIK: boolean
  bones: AuthoringBone[]
  slots: AuthoringSlot[]
  skins: AuthoringSkin[]
  constraints: AuthoringConstraint[]
  animations: AuthoringAnimData[]
  images: AuthoringImage[]
  editorMeta: EditorMeta
}

// ---------------- 工厂 ----------------

export function createDefaultMeta(): EditorMeta {
  return {
    layout: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    activeSkin: '',
    activeAnimation: '',
    overlay: { bones: true, weight: false, ffd: false, constraints: true },
    brush: { radius: 40, strength: 0.5, mode: 'add' }
  }
}

export function createAuthoringBone(partial?: Partial<AuthoringBone>): AuthoringBone {
  return {
    name: 'bone',
    parent: '',
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 20,
    color: '#F97316',
    locked: false,
    hollow: false,
    ...partial
  }
}

export function createAuthoringSlot(partial?: Partial<AuthoringSlot>): AuthoringSlot {
  return {
    name: 'slot',
    bone: '',
    color: '#FFFFFFFF',
    blendMode: BlendMode.Normal,
    zOrder: 0,
    z: 0,
    attachment: '',
    visible: true,
    ...partial
  }
}

export function createAuthoringAttachment(partial?: Partial<AuthoringAttachment>): AuthoringAttachment {
  return {
    name: 'attachment',
    type: 'region',
    image: '',
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    size: { x: 100, y: 100 },
    color: '#FFFFFFFF',
    vertices: [],
    uvs: [],
    triangles: [],
    edges: [],
    hull: 0,
    ffdInBoneSpace: false,
    linkedMeshSkin: '',
    linkedMeshAttachment: '',
    ...partial
  }
}

/**
 * 动画里最晚的关键帧时间（只读，不改动数据）：骨骼 / 插槽 / deform / 约束 / 绘制顺序 / 事件。
 *
 * **播放长度与导出时长都按它算**（见 AnimationPlayer / compileAnimations）；
 * `duration` 字段是「可编辑范围」（留着往后继续加帧），不能短于它，否则末尾帧会被裁掉。
 */
export function lastKeyTime(animation: AuthoringAnimData): number {
  let last = 0
  const consider = (frames: ReadonlyArray<{ time: number }>): void => {
    for (const frame of frames) if (frame.time > last) last = frame.time
  }
  for (const track of animation.bones) {
    consider(track.translate)
    consider(track.rotate)
    consider(track.scale)
    consider(track.shear)
  }
  for (const track of animation.slots) {
    consider(track.color)
    consider(track.displayIndex)
    consider(track.visible)
  }
  for (const track of animation.deforms) consider(track.frames)
  for (const track of animation.constraints) {
    for (const list of Object.values(track)) {
      if (Array.isArray(list)) consider(list as ReadonlyArray<{ time: number }>)
    }
  }
  consider(animation.drawOrder)
  consider(animation.events)
  return last
}

export function createAuthoringAnim(name: string, duration = 1): AuthoringAnimData {
  return {
    name,
    duration,
    bones: [],
    slots: [],
    deforms: [],
    drawOrder: [],
    events: [],
    constraints: []
  }
}

export function createEmptyDocument(armatureName = 'armature'): EditorDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    armatureName,
    frameRate: 30,
    runtimeIK: true,
    bones: [],
    slots: [],
    skins: [{ name: 'default', slots: [] }],
    constraints: [],
    animations: [],
    images: [],
    editorMeta: createDefaultMeta()
  }
}

export type { ConstraintAnim, DeformKeyframe, EventKeyframe, RGBA }
