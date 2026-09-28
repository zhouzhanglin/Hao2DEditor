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
  /** Spine 4.x：normal / onlyTranslation / noRotationOrReflection / noScale / noScaleOrReflection */
  transform?: string
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
  target: string
  mixRotate?: number
  mixX?: number
  mixY?: number
  mixScaleX?: number
  mixScaleY?: number
  mixShearY?: number
  rotate?: number
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  shearY?: number
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

  // linkedmesh
  skin?: string
  parent?: string
}

export interface SpineSkinJson {
  name?: string
  attachments?: Record<string, Record<string, SpineAttachmentJson>>
}

export interface SpineCurveKeyframe {
  time: number
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
  color?: SpineCurveKeyframe[]
  attachment?: SpineCurveKeyframe[]
  twoColor?: SpineCurveKeyframe[]
}

export interface SpineAnimationJson {
  bones?: Record<string, SpineBoneTimelineJson>
  slots?: Record<string, SpineSlotTimelineJson>
  /** 3.x：slot → attachment → 帧；4.x：skin → slot → attachment → 帧 */
  deform?: Record<string, Record<string, SpineCurveKeyframe[]>>
  drawOrder?: SpineCurveKeyframe[]
  events?: SpineCurveKeyframe[]
  ik?: Record<string, SpineCurveKeyframe[]>
  transform?: Record<string, SpineCurveKeyframe[]>
  path?: Record<string, SpineCurveKeyframe[]>
}

export interface SpineJson {
  skeleton?: { spine?: string; fps?: number; hash?: string; images?: string }
  bones?: SpineBoneJson[]
  slots?: SpineSlotJson[]
  ik?: SpineIkJson[]
  transform?: SpineTransformConstraintJson[]
  path?: SpinePathConstraintJson[]
  physics?: SpinePhysicsConstraintJson[]
  skins?: SpineSkinJson[] | Record<string, Record<string, Record<string, SpineAttachmentJson>>>
  animations?: Record<string, SpineAnimationJson>
}
