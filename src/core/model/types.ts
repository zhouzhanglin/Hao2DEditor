import type { Vec2 } from '../math/matrix'

/** 资源来源。与参考库 AnimType 一致：DragonBone = 1，Spine = 2。 */
export enum AnimType {
  DragonBone = 1,
  Spine = 2
}

export enum AttachmentType {
  Region = 0,
  Mesh = 1,
  LinkedMesh = 2,
  BoundingBox = 3
}

/** 混合模式并集（DragonBones 与 Spine）。不同 blend 不能合并到同一分组。 */
export enum BlendMode {
  Normal = 0,
  Additive = 1,
  Multiply = 2,
  Screen = 3,
  Erase = 4,
  Mask = 5,
  Below = 6,
  None = 7
}

export const BLEND_MODE_NAMES: Record<BlendMode, string> = {
  [BlendMode.Normal]: 'Normal',
  [BlendMode.Additive]: 'Additive',
  [BlendMode.Multiply]: 'Multiply',
  [BlendMode.Screen]: 'Screen',
  [BlendMode.Erase]: 'Erase',
  [BlendMode.Mask]: 'Mask',
  [BlendMode.Below]: 'Below',
  [BlendMode.None]: 'None'
}

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export function rgba(r = 1, g = 1, b = 1, a = 1): RGBA {
  return { r, g, b, a }
}

export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 }

/** 骨骼静态数据（拓扑序：parentIndex < 自身下标）。 */
export interface BoneData {
  name: string
  parentIndex: number
  localPosition: Vec2
  /** 度 */
  rotation: number
  localScale: Vec2
  /** Spine 专属 shearX / shearY（度），其它来源恒为 0 */
  localShear: Vec2
  inheritRotation: boolean
  inheritScale: boolean
  /** 骨骼长度，用于调试画骨架与 IK 的 l1 计算 */
  length: number
}

export interface SlotData {
  name: string
  boneIndex: number
  color: RGBA
  blendMode: BlendMode
  defaultDisplayIndex: number
  defaultZOrder: number
  /** 非 UI 渲染路径的深度偏移 */
  z: number
  /**
   * setup pose 中该插槽显示的附件名。
   * 运行期在「当前合并皮肤」里按名解析默认显示下标；名字查不到才退回 defaultDisplayIndex。
   */
  setupAttachment: string
}

/**
 * 单顶点的骨骼权重（固定 4 骨骼，导入/编译期已取 top-4 并归一化）。
 * 每骨骼带各自的局部坐标：vertex = Σ worldMatrices[bk] · (lxk, lyk) · wk
 */
export interface VertexWeight {
  b0: number
  b1: number
  b2: number
  b3: number
  lx0: number
  ly0: number
  lx1: number
  ly1: number
  lx2: number
  ly2: number
  lx3: number
  ly3: number
  w0: number
  w1: number
  w2: number
  w3: number
}

export interface AttachmentData {
  name: string
  type: AttachmentType

  /** 相对挂载骨骼的局部偏移 */
  position: Vec2
  /** 度 */
  rotation: number
  scale: Vec2
  /** Region 的显示尺寸（宽, 高） */
  size: Vec2

  color: RGBA
  /** 对应图集中的纹理名（= 图集页 png 名） */
  textureName: string

  /** 顶点 UV，归一化到 0..1（v 已翻转，左下原点） */
  uvs: Float32Array
  /** Mesh 的局部顶点（Region 可为空） */
  vertices: Float32Array
  triangles: number[]
  edges: number[]
  /** 外环顶点数 */
  hull: number

  /** 每顶点权重（Mesh）；Region 为空 */
  weights: VertexWeight[]

  /**
   * FFD 偏移是否已是骨内坐标。
   *
   * 口径（与实现一致）：**导入器一律写 false** —— spine 与 DragonBones 的 deform 偏移都是
   * 「setup 姿态 / 显示空间」的位移，加权路径由运行期按 bindpose 做方向变换（见
   * meshBuilder.accumulateWeighted）。`true` 只可能来自手动开关或旧工程 / 外部数据，
   * 而且导出时会被 compile 的 normalizeBoneSpaceFfd 换算回显示空间并清零。
   */
  ffdInBoneSpace: boolean

  linkedMeshSkin: string
  linkedMeshAttachment: string
}

export interface SkinSlotData {
  slotName: string
  attachments: AttachmentData[]
}

export interface SkinData {
  name: string
  slots: SkinSlotData[]
}

/** 图集页 / 图片引用（编辑器扩展字段，参考库用 Texture2D 表达）。 */
export interface ImageRef {
  /** = AttachmentData.textureName */
  name: string
  /** 绝对路径（编辑器内）或打包后的页文件名 */
  path: string
  width: number
  height: number
  /** 是否为独立碎图（导出时需要打包进图集） */
  loose?: boolean
}

export function createBoneData(partial?: Partial<BoneData>): BoneData {
  return {
    name: 'bone',
    parentIndex: -1,
    localPosition: { x: 0, y: 0 },
    rotation: 0,
    localScale: { x: 1, y: 1 },
    localShear: { x: 0, y: 0 },
    inheritRotation: true,
    inheritScale: true,
    length: 0,
    ...partial
  }
}

export function createAttachmentData(partial?: Partial<AttachmentData>): AttachmentData {
  return {
    name: 'attachment',
    type: AttachmentType.Region,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    size: { x: 0, y: 0 },
    color: { ...WHITE },
    textureName: '',
    uvs: new Float32Array(8),
    vertices: new Float32Array(0),
    triangles: [],
    edges: [],
    hull: 0,
    weights: [],
    ffdInBoneSpace: false,
    linkedMeshSkin: '',
    linkedMeshAttachment: '',
    ...partial
  }
}
