import type { Vec2 } from '../math/matrix'

/** 资源来源。与 Unity 端 Hao2D 运行时 AnimType 一致：DragonBone = 1，Spine = 2。 */
export enum AnimType {
  DragonBone = 1,
  Spine = 2
}

export enum AttachmentType {
  Region = 0,
  Mesh = 1,
  LinkedMesh = 2,
  BoundingBox = 3,
  /**
   * 多边形遮罩（Spine 的 ClippingAttachment）。
   *
   * 它自身不渲染，只对**绘制顺序中位于它之后、结束插槽之前**的附件做裁剪。
   * 多边形顶点存放在 `vertices`（插槽骨骼局部空间，与 Spine 一致），
   * `clipEndSlot` 为空表示裁到绘制顺序末尾。
   */
  Clipping = 4,
  /**
   * 嵌套骨架（DragonBones 的 slot display `type:"armature"`）。
   *
   * 它自身不产生任何几何，只把一个**同工程内的骨架**挂到插槽上：
   * 运行期按「父插槽骨骼世界矩阵 × 附件 TRS」摆放子骨架，并可用插槽动画的
   * `subArmature` 通道控制子骨架播放哪个动画（见 `core/nesting`）。
   * 图形字段（`uvs/vertices/size/textureName`）对它是空的。
   */
  Armature = 5
}

/**
 * 混合模式并集（DragonBones 与 Spine）。不同 blend 不能合并到同一分组。
 *
 * 没有 `Mask`：遮罩由 `AttachmentType.Clipping` 的多边形裁剪实现（Spine 的
 * ClippingAttachment），混合模式里不存在“Mask”这种语义。旧工程里曾有
 * `Mask = 5`，读取时由 projectJson 迁移成 Normal（见 schema v1→v2）。
 */
export enum BlendMode {
  Normal = 0,
  Additive = 1,
  Multiply = 2,
  Screen = 3,
  Erase = 4,
  Below = 5,
  None = 6
}

export const BLEND_MODE_NAMES: Record<BlendMode, string> = {
  [BlendMode.Normal]: 'Normal',
  [BlendMode.Additive]: 'Additive',
  [BlendMode.Multiply]: 'Multiply',
  [BlendMode.Screen]: 'Screen',
  [BlendMode.Erase]: 'Erase',
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
  /**
   * setup pose 的可见性（层级树行首眼睛 / 属性面板「可见」开关）。
   *
   * 眼睛只改文档里的 AuthoringSlot.visible，编译产物必须把它带下来 —— 否则骨架
   * 无从得知「setup 时这根插槽是隐藏的」，切回 setup / Pose 或换肤后又显示出来
   * （Spine / DragonBones 没有插槽级可见性概念，导入器恒填 true）。
   */
  visible: boolean
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
  /** Region 的显示尺寸（宽, 高）—— 内容的四边形按它绘制 */
  size: Vec2
  /**
   * 未裁剪原图（DB 的 frame / Spine 的 orig）的尺寸；`x <= 0` 表示没被裁剪过（此时原图尺寸就是 `size`）。
   *
   * 为什么要有它：被裁剪的图（图集里只存了「有像素的那块」）在编辑器里应当**按原图尺寸画框 / 命中**——
   * 否则框会比图小一圈，看起来像「没算空白区域」。渲染仍然只按 `size`（内容）走，空白不会被画出来。
   *
   * `position` 指的就是**原图中心**（= DB 的显示变换），所以框以附件原点为中心。
   */
  frameSize: Vec2
  /**
   * 内容中心相对附件原点（= 原图中心）的位移，**在附件自身的坐标轴里**（y 向上）。
   *
   * 为什么强调「自身坐标轴」：这个位移来自裁剪（左/上裁掉多少），是**图片坐标轴**里的量。
   * 若把它加进 `position`，就会被**骨骼**的旋转带着转（实测 Rooster 的下嘴因此跑到上嘴上方 0.3）；
   * 正确做法是渲染四边形时在附件局部坐标里偏移（见 `meshBuilder.emitRegion`）。
   */
  contentOffset: Vec2

  color: RGBA
  /** 对应图集中的纹理名（= 图集页 png 名） */
  textureName: string
  /**
   * 导出 Spine 用：附件在图集里的**区域名**（= 原始图片名，passthrough 页即页名）。
   * 运行期渲染不依赖它（region 附件的 UV 由运行期按页重算、mesh 用页相对 UV），
   * 只在写出 Spine 骨架时作为附件的 `path` 指向图集区域。
   */
  regionName?: string

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

  /**
   * 遮罩结束插槽名（仅 Clipping 用）。空串 = 裁到绘制顺序末尾。
   *
   * 用名字而不是下标：插槽重排 / 新增不会让遮罩指向错误的插槽；重命名时由
   * `applyRename` 级联更新。
   */
  clipEndSlot: string
  /** 反向遮罩：只保留多边形外部（Spine 要求此时多边形为凸） */
  clipInverse: boolean
  /** 凸多边形标记（Spine 的 `convex`，仅影响裁剪算法的快慢与反向支持） */
  clipConvex: boolean

  /**
   * 嵌套骨架（仅 `type === AttachmentType.Armature`）：被引用的骨架名。
   *
   * 同工程 `skeletons[]` 里的 `armatureName`（不是下标 —— 骨架重排 / 改名不会错位）。
   * 空串 = 引用缺失（工程里找不到这个名字），此时不渲染并给出告警。
   */
  subArmature: string
  /** setup 默认播放的子骨架动画名；空串 = 停在子骨架的 setup 姿态 */
  subAnimation: string
  /** setup 默认播放次数：0 或负数 = 无限循环（每轮从 subOffset 起播），n > 0 = 播 n 次后定格末帧 */
  subPlayTimes: number
  /** setup 默认起始偏移（秒），用于「刀光晚 3 帧起播」这类效果 */
  subOffset: number
  /** setup 默认倍速，1 = 原速 */
  subSpeed: number
}

export interface SkinSlotData {
  slotName: string
  attachments: AttachmentData[]
}

export interface SkinData {
  name: string
  slots: SkinSlotData[]
}

/** 图集页里单个区域的几何（导入 Spine / DragonBones 图集时随页带进来，导出时用来还原图集里的各个 sprite）。 */
export interface ImageAtlasRegion {
  /** 区域名（= 图集 .atlas 里的 region 名，可能带皮肤前缀，如 `goblin/head`） */
  name: string
  x: number
  y: number
  width: number
  height: number
  /** 旋转角度（度，0/90/180/270）。Spine 的 `rotate: true` 即 90 */
  rotate?: number
  /** 未裁剪原始尺寸 */
  origWidth?: number
  origHeight?: number
  /** 裁剪偏移（图片坐标轴，向右 / 向下为正） */
  offsetX?: number
  offsetY?: number
}

/** 图集页 / 图片引用（编辑器扩展字段，Unity 端 Hao2D 运行时用 Texture2D 表达）。 */
export interface ImageRef {
  /** = AttachmentData.textureName */
  name: string
  /** 绝对路径（编辑器内）或打包后的页文件名 */
  path: string
  width: number
  height: number
  /**
   * 是否为独立碎图。
   *
   * - `true`：散图，导出时**打包进新图集**（UV 会被重映射）；
   * - `false`：已经是图集页（导入 Spine / DragonBones 带进来的那种），导出时**整页复制源文件**，
   *   不重打包也不重编码，UV 原样保留；
   * - 缺省：按 `true` 处理（老工程文件没有这个字段，当时导出是一律重打包的）。
   */
  loose?: boolean
  /**
   * 本来就是图集的页（`loose === false`）导入时保留下来的**各个子区域**。
   * 导出时按这些区域写图集，而不是把整页当一块 —— 否则图集里的 sprite 全部丢失，
   * 重新导入后每个附件都指向整页区域。散图（loose 为真）没有它。
   */
  regions?: ImageAtlasRegion[]
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
    frameSize: { x: 0, y: 0 },
    contentOffset: { x: 0, y: 0 },
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
 * 附件在**原图坐标系**里的框（局部坐标，以附件原点 = 原图中心为中心）：编辑器画选中轮廓、
 * 算包围盒、取景都按它。
 *
 * - 没被裁剪（`frameSize` 缺省 / 非正）：就是内容框（`size`）；
 * - 被裁剪：原图框（`frameSize`）—— 内容按 `contentOffset` 落在它内部的某处。
 *
 * 渲染不受影响：`meshBuilder.emitRegion` 只按 `size`（内容）画四边形，原图空白不会被画出来。
 */
export function attachmentFrameBox(attachment: {
  size: Vec2
  frameSize?: Vec2
}): { center: Vec2; size: Vec2 } {
  const frame = attachment.frameSize
  if (frame && frame.x > 1e-6 && frame.y > 1e-6) return { center: { x: 0, y: 0 }, size: frame }
  return { center: { x: 0, y: 0 }, size: attachment.size }
}
