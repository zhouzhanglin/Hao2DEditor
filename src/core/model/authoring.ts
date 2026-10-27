import type { Vec2 } from '../math/matrix'
import type { RGBA, ImageAtlasRegion } from './types'
import { BlendMode } from './types'
import type { IkConstraint, PathConstraint, PhysicsConstraint, TransformConstraint } from './constraints'
import type {
  ColorKeyframe,
  ConstraintAnim,
  DeformKeyframe,
  EventKeyframe,
  Float2Keyframe,
  FloatKeyframe,
  IntKeyframe,
  SubArmatureKeyframe
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

export type AuthoringAttachmentType = 'region' | 'mesh' | 'linkedmesh' | 'boundingbox' | 'clipping' | 'armature'

export interface AuthoringAttachment {
  name: string
  type: AuthoringAttachmentType
  /** 图集页 / 图片名 */
  image: string
  /** 导出 Spine 用：附件在图集里的区域名（= sprite 名，可能带皮肤前缀） */
  regionName?: string
  position: Vec2
  /** 度 */
  rotation: number
  scale: Vec2
  /** Region 显示尺寸（内容四边形） */
  size: Vec2
  /**
   * 未裁剪原图尺寸（DB 的 frame / Spine 的 orig）；`x <= 0` = 没裁剪过。
   *
   * 被裁剪的图（图集里只存有像素的那块）在编辑器里按**原图**画框 / 命中，渲染仍按 `size`（内容）。
   * 见 `core/model/types.ts` 的 `AttachmentData.frameSize`。
   */
  frameSize: Vec2
  /**
   * 内容中心相对附件原点（= 原图中心）的位移，**在附件自身坐标轴里**；未裁剪为 0。
   * 渲染时在局部坐标里偏移（`meshBuilder.emitRegion`），不能加进 `position`（那会被骨骼旋转带偏）。
   */
  contentOffset: Vec2
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
   * - false：偏移在附件**显示空间**，加权蒙皮时先经 bindpose 做方向变换 ——
   *   编辑器新建的附件、以及 spine / DragonBones 导入的数据都是这一种；
   * - true：偏移已是**骨内坐标**，直接叠加。正常编辑流程不会产生它，
   *   只有手动开关或旧工程 / 外部数据会标成 true（导出时会被换算回显示空间并清零）。
   */
  ffdInBoneSpace: boolean
  linkedMeshSkin: string
  linkedMeshAttachment: string
  /**
   * 遮罩结束插槽名（仅 `type === 'clipping'`）。空串 = 裁到绘制顺序末尾。
   * 与 Spine 的 clipping.end 一致：结束插槽自身不被裁剪。
   */
  clipEndSlot: string
  /** 反向遮罩（仅 clipping）；Spine 要求此时多边形为凸，UI 会联动勾选 convex */
  clipInverse: boolean
  /** 凸多边形标记（仅 clipping） */
  clipConvex: boolean
  /**
   * 嵌套骨架（仅 `type === 'armature'`）：被引用的骨架名（= 同工程 `skeletons[].armatureName`）。
   * 空串 = 引用缺失，运行期不渲染。图形字段对该类型不参与渲染。
   */
  subArmature: string
  /** setup 默认子动画名（空串 = 停在子骨架 setup 姿态） */
  subAnimation: string
  /** setup 默认播放次数：0 或负数 = 循环（每轮从 subOffset 起播），n > 0 = 播 n 次后定格末帧 */
  subPlayTimes: number
  /** setup 默认起始偏移（秒） */
  subOffset: number
  /** setup 默认倍速（1 = 原速） */
  subSpeed: number
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
  /**
   * 锁定：视口里**点不中**它（与骨骼锁一致，属于绑定期的防误操作开关）。
   * 层级树里仍然可以选中 / 改属性 / 解锁 —— 锁住的只是「在视口里随手点选」这条路径。
   */
  locked: boolean
}

export interface AuthoringImage {
  name: string
  path: string
  width: number
  height: number
  /**
   * 是否为独立碎图。
   *
   * - `true`：散图（「导入图片」进来的），导出时打包进新图集；
   * - `false`：已经是图集页（导入 Spine / DragonBones 带进来的），导出时整页复制、不重打包。
   *
   * 老工程文件没有这个字段 → 解析时按 `true` 处理（那时导出是一律重打包的）。
   */
  loose: boolean
  /**
   * 本来就是图集的页（`loose === false`）导入时保留下来的**各个子区域**。
   * 导出时按这些区域写图集，而不是把整页当一块。散图（loose 为真）没有它。
   */
  regions?: ImageAtlasRegion[]
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
  /** 子骨架动画控制（该插槽挂有 armature display 时才有意义） */
  subArmature: SubArmatureKeyframe[]
}

export interface AuthoringDeformAnim {
  slot: string
  attachment: string
  /**
   * 轨道归属的皮肤名（Spine 4.2+ 的 `attachments.<skin>...` / 3.x 的皮肤层）。
   * 缺省 = 与皮肤无关的老式插槽层轨道。工程 JSON 会原样保存，编译时写回运行期轨道。
   */
  skin?: string
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
  /** 视口叠加层开关（只留骨架与约束：网格 / FFD / 权重都由选中项与工具驱动） */
  overlay: { bones: boolean; constraints: boolean }
  /**
   * 权重画笔参数（Mode / Size / Strength / Feather / Normalize，笔刷语义对齐 Spine 的 Weights）：
   * - `strength`：一笔内能刷到的权重上限（0..100，100 = 一次刷满）；
   * - `feather`：边缘衰减占半径的百分比（0 = 硬边，100 = 从中心开始衰减）。
   */
  brush: {
    mode: 'addSubtract' | 'growShrink' | 'smooth'
    size: number
    strength: number
    feather: number
    normalize: boolean
  }
  /** 上次导出的图集缩放（有存档时持久化进工程文件，下次导出默认沿用）；未设置按 1 处理 */
  exportScale?: number
  /**
   * 舞台参考图：铺在角色**后面**的背景图（构图 / 姿态参照），null = 没设置。
   * 只活在编辑器里 —— 运行时导出完全不读它；图片文件存在工程目录的 `stage/` 下随工程走。
   */
  stage: StageImage | null
}

/**
 * 舞台参考图的配置。图片文件本体不进工程 JSON（只有这份描述进），
 * 文件存 `<工程目录>/stage/<file>`，位置 / 大小都用世界单位（与附件同一把尺：1 单位 = PPU 像素）。
 */
export interface StageImage {
  /** 图片文件名（相对工程目录的 stage/ 文件夹） */
  file: string
  /** 图片中心点的世界坐标（y 轴向上） */
  x: number
  y: number
  /** 显示尺寸（世界单位） */
  width: number
  height: number
  /** 不透明度 0..1（参考图要压暗，别喧宾夺主） */
  opacity: number
}

/**
 * 工程文件版本。
 *
 * - **1**：初始版本；
 * - **2**：`BlendMode` 移除 `Mask` 并重排（Below 6→5、None 7→6）。
 *   读取 v1 时把旧的 5（Mask）迁移成 Normal、6/7 映射到新值（见 projectJson 的迁移）。
 * - **3**：新增骨架嵌套：附件类型 `'armature'`（`subArmature/subAnimation/subPlayTimes/subOffset/subSpeed`）
 *   与插槽动画的 `subArmature` 通道。只新增字段，老工程缺字段按默认值兜底、无需改写。
 */
export const CURRENT_SCHEMA_VERSION = 3

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
    overlay: { bones: true, constraints: true },
    brush: { mode: 'addSubtract', size: 40, strength: 40, feather: 50, normalize: true },
    stage: null
  }
}

/**
 * 层级根骨骼的约定名：**唯一一根顶层骨骼**（`parent === ''`），其他骨骼 / 插槽都挂在它之下。
 *
 * 它是一根普通骨骼（能选中、能加关键帧），但结构上是整棵层级树的根：
 * 新建项目时自动补一根（见 projectStore 的 `withDefaultRoot`），别处都别再建第二根顶层骨骼 ——
 * 新建骨骼 / 拖图进视口 / 层级拖动落空处，统一用它兜底（见 `rootBoneName`）。
 */
export const ROOT_BONE_NAME = 'root'

/**
 * 取层级根骨骼名：优先「顶层且名为 root」的那根，其次任意顶层骨骼，最后退回第一根骨骼；
 * 空骨架返回空串（调用方据此提示「先建一根骨骼」）。老工程里根骨骼被改过名也能找到。
 */
export function rootBoneName(bones: readonly AuthoringBone[]): string {
  const named = bones.find((bone) => bone.name === ROOT_BONE_NAME && !bone.parent)
  if (named) return named.name
  const top = bones.find((bone) => !bone.parent)
  return top?.name ?? bones[0]?.name ?? ''
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
    locked: false,
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
    // 0 = 没被裁剪过（框就是 size）
    frameSize: { x: 0, y: 0 },
    contentOffset: { x: 0, y: 0 },
    color: '#FFFFFFFF',
    vertices: [],
    uvs: [],
    triangles: [],
    edges: [],
    hull: 0,
    ffdInBoneSpace: false,
    linkedMeshSkin: '',
    linkedMeshAttachment: '',
    clipEndSlot: '',
    clipInverse: false,
    clipConvex: false,
    subArmature: '',
    subAnimation: '',
    subPlayTimes: 0,
    subOffset: 0,
    subSpeed: 1,
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
    if (track.subArmature) consider(track.subArmature)
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
