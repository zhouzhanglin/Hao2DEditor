/** Spine JSON 的最小结构描述（只声明导入器真正读取的字段，全部可缺省以便兼容 3.3 ~ 4.x） */

export interface SpineBoneJson {
  name: string
  parent?: string
  length?: number
  x?: number
  y?: number
  rotation?: number
  scaleX?: number
  scaleY?: number
  shearX?: number
  shearY?: number
  inheritRotation?: boolean
  inheritScale?: boolean
  /** Spine 3.8–4.1 的继承枚举：normal / onlyTranslation / noRotationOrReflection / noScale / noScaleOrReflection */
  transform?: string
  /** Spine 4.2+ 改名的同一套枚举（早期只读了 transform，4.2+ 资源里的 inherit 会被忽略） */
  inherit?: string
}

export interface SpineSlotJson {
  name: string
  bone: string
  attachment?: string
  color?: string
  dark?: string
  blend?: string
}

export interface SpineIkJson {
  name: string
  order?: number
  bones: string[]
  target: string
  mix?: number
  bendPositive?: boolean
  compress?: boolean
  stretch?: boolean
  softness?: number
}

export interface SpineTransformConstraintJson {
  name: string
  order?: number
  bones: string[]
  target?: string
  /** 4.3 起 `target` 改名 `source`（同一含义：提供变换的源骨骼） */
  source?: string
  mixRotate?: number
  mixX?: number
  mixY?: number
  mixScaleX?: number
  mixScaleY?: number
  mixShearY?: number
  /**
   * 3.8–4.1 的混合系数名（4.0 起改叫 mixRotate / mixX …；translateMix 同时管 X 与 Y）
   */
  rotateMix?: number
  translateMix?: number
  scaleMix?: number
  shearMix?: number
  /** 3.8–4.1 的偏移字段名 */
  rotate?: number
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  shearY?: number
  /** 4.0+ 的偏移字段名（导出写的就是这套） */
  offsetRotation?: number
  offsetX?: number
  offsetY?: number
  offsetScaleX?: number
  offsetScaleY?: number
  offsetShearY?: number
  relative?: boolean
  local?: boolean
}

export interface SpinePathConstraintJson {
  name: string
  order?: number
  bones: string[]
  target: string
  position?: number
  spacing?: number
  rotateMix?: number
  translateMix?: number
  positionMode?: string
  spacingMode?: string
  rotateMode?: string
}

export interface SpinePhysicsConstraintJson {
  name: string
  order?: number
  bones?: string[]
  target?: string
  [key: string]: unknown
}

/**
 * 附件：region / mesh / linkedmesh / boundingbox / clipping / point / path 共用一个宽松结构，
 * 用 `type` 区分，只读取各自存在的字段。
 */
export interface SpineAttachmentJson {
  type?: string
  name?: string
  /** 引用的图集区域名（缺省时用附件名） */
  path?: string
  x?: number
  y?: number
  rotation?: number
  scaleX?: number
  scaleY?: number
  width?: number
  height?: number
  color?: string

  // mesh
  uvs?: number[]
  triangles?: number[]
  vertices?: number[]
  /** 权重：每顶点 [boneCount, (boneIdx, vx, vy, w) × n] */
  weights?: number[]
  edges?: number[]
  hull?: number

  // boundingbox / path
  polygons?: number[]

  // clipping / boundingbox / path
  /** Spine 4.x 在这些“只有多边形”的附件上显式写顶点数（加权时 vertices 会更长） */
  vertexCount?: number
  /** clipping：结束插槽名（空/缺省 = 裁到绘制顺序末尾） */
  end?: string
  /** clipping：反向遮罩 */
  inverse?: boolean
  /** clipping：凸多边形标记 */
  convex?: boolean

  // linkedmesh
  /** 源网格所在的皮肤（缺省 = 默认皮肤） */
  skin?: string
  /**
   * 源网格的附件名（**Spine 4.x 的字段名**）。
   * 官方读取顺序是 `source`；3.8 用的是 `parent`。两者都缺省时按官方语义
   * 取「同名附件」（见 SkeletonJson：`source` 缺失就退化成普通 mesh，
   * 但 3.x 的 linkedmesh 一定带 `parent`）。
   */
  source?: string
  /**
   * 3.8–4.1 的源网格附件名。
   * 注意：本编辑器只在**同一个槽位**里找源网格（Spine 4.x 允许用 `slot` 指向别的槽位，
   * 这种资源目前的导入会找不到父附件）。
   */
  parent?: string
  /** Spine 4.x：源网格所在槽位名（缺省 = 同槽位）—— 暂不支持，见 `parent` 的说明 */
  slot?: string
}

export interface SpineSkinJson {
  name?: string
  attachments?: Record<string, Record<string, SpineAttachmentJson>>
}

export interface SpineCurveKeyframe {
  time: number
  /**
   * 数值帧的值：3.x/4.1 的 rotate 用 `angle`，**4.2 起统一改名成 `value`**；
   * translate/scale/shear 一直是 `x` / `y`。
   */
  value?: number
  angle?: number
  x?: number
  y?: number
  curve?: number | number[] | string
  [key: string]: unknown
}

export interface SpineBoneTimelineJson {
  rotate?: SpineCurveKeyframe[]
  translate?: SpineCurveKeyframe[]
  scale?: SpineCurveKeyframe[]
  shear?: SpineCurveKeyframe[]
}

export interface SpineSlotTimelineJson {
  /** 槽位颜色通道：3.x 叫 `color`，4.x 叫 `rgba` */
  color?: SpineCurveKeyframe[]
  rgba?: SpineCurveKeyframe[]
  attachment?: SpineCurveKeyframe[]
  twoColor?: SpineCurveKeyframe[]
}

/** 附件级轨道组：`deform` 之外还有 `sequence`、`twoColor` 等 */
export interface SpineAttachmentTimelineJson {
  deform?: SpineCurveKeyframe[]
  [key: string]: unknown
}

export interface SpineAnimationJson {
  bones?: Record<string, SpineBoneTimelineJson>
  slots?: Record<string, SpineSlotTimelineJson>
  /** 3.x：slot → attachment → 帧；4.0~4.1：skin → slot → attachment → 帧 */
  /**
   * deform 轨道有两种层级，导入器两套都认（见 spineAnims 的 `collectDeforms`）：
   * - 3.x：`deform.<插槽>.<附件>` → 帧
   * - 4.x：`deform.<皮肤>.<插槽>.<附件>` → 帧
   */
  deform?: Record<
    string,
    Record<string, SpineCurveKeyframe[]> | Record<string, Record<string, SpineCurveKeyframe[]>>
  >
  /**
   * 4.2 起（spine-core 4.3 只认这里）：skin → slot → attachment → `{ deform: 帧 }`。
   * 写回这个层级才有效 —— 顶层 `deform` 会被官方运行库整段忽略。
   */
  attachments?: Record<string, Record<string, Record<string, SpineAttachmentTimelineJson>>>
  drawOrder?: SpineCurveKeyframe[]
  events?: SpineCurveKeyframe[]
  ik?: Record<string, SpineCurveKeyframe[]>
  transform?: Record<string, SpineCurveKeyframe[]>
  path?: Record<string, SpineCurveKeyframe[]>
}

export interface SpineJson {
  skeleton?: { spine?: string; fps?: number; hash?: string; images?: string; x?: number; y?: number; width?: number; height?: number }
  bones?: SpineBoneJson[]
  slots?: SpineSlotJson[]
  /**
   * 4.2+ 的约束统一放在顶层 `constraints` 数组里（每项带 `type`）：
   * 旧版（3.8–4.1）才按类型分在 `ik` / `transform` / `path` 三处。
   */
  constraints?: Array<SpineIkJson & Partial<SpineTransformConstraintJson> & { type?: string }>
  ik?: SpineIkJson[]
  transform?: SpineTransformConstraintJson[]
  path?: SpinePathConstraintJson[]
  physics?: SpinePhysicsConstraintJson[]
  skins?: SpineSkinJson[] | Record<string, Record<string, Record<string, SpineAttachmentJson>>>
  animations?: Record<string, SpineAnimationJson>
}
