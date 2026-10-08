/** DragonBones JSON 的最小结构描述（兼容 5.x 导出） */

export interface DbTransformJson {
  x?: number
  y?: number
  skX?: number
  skY?: number
  scX?: number
  scY?: number
}

export interface DbBoneJson {
  name: string
  parent?: string
  length?: number
  inheritRotation?: boolean
  inheritScale?: boolean
  transform?: DbTransformJson
}

export interface DbColorJson {
  aM?: number
  rM?: number
  gM?: number
  bM?: number
  aO?: number
  rO?: number
  gO?: number
  bO?: number
}

export interface DbSlotJson {
  name: string
  parent?: string
  displayIndex?: number
  blendMode?: number | string
  color?: DbColorJson
  z?: number
}

export interface DbDisplayJson {
  type?: string
  name?: string
  path?: string
  transform?: DbTransformJson
  width?: number
  height?: number

  // mesh
  vertices?: number[]
  uvs?: number[]
  triangles?: number[]
  /** 每顶点 [boneCount, (boneIdx, weight) × n] */
  weights?: number[]
  slotPose?: number[]
  edges?: number[]
  userEdges?: number[]
  hull?: number
}

export interface DbSkinSlotJson {
  name?: string
  display?: DbDisplayJson[]
}

export interface DbSkinJson {
  name?: string
  slot?: DbSkinSlotJson[]
}

export interface DbIkJson {
  name?: string
  /** 末端骨骼 */
  bone?: string
  target?: string
  /** 末端之外还要向上追溯的骨骼数（chain:1 即「父 + 末端」两骨链） */
  chain?: number
  bendPositive?: boolean
  weight?: number
}

/**
 * 帧的缓动：`tweenEasing` 缺省 / null 表示**线性补间**（DB 导出时"线性"常常直接省略该字段），
 * 有 `curve` 数组时按贝塞尔处理。数值型的缓动类型本转换器统一按线性近似。
 */
export interface DbFrameEasingJson {
  duration?: number
  tweenEasing?: number | null
  curve?: number[]
}

export interface DbBoneFrameJson extends DbFrameEasingJson {
  transform?: DbTransformJson
}

/**
 * 5.x 起骨骼动画按通道拆帧：每帧只给本通道的增量值，`duration` 是「这一帧持续多少帧」。
 * translate → x/y、rotate → rotate、scale → x/y。
 */
export interface DbChannelFrameJson extends DbFrameEasingJson {
  x?: number
  y?: number
  rotate?: number
}

export interface DbBoneTrackJson {
  name?: string
  /** 5.5 之前的旧格式：每帧带完整 transform */
  frame?: DbBoneFrameJson[]
  /** 5.x 新格式：三条通道各自成帧 */
  translateFrame?: DbChannelFrameJson[]
  rotateFrame?: DbChannelFrameJson[]
  scaleFrame?: DbChannelFrameJson[]
}

export interface DbSlotFrameJson extends DbFrameEasingJson {
  displayIndex?: number
  color?: DbColorJson
}

export interface DbSlotTrackJson {
  name?: string
  frame?: DbSlotFrameJson[]
}

export interface DbFfdFrameJson extends DbFrameEasingJson {
  offset?: number
  vertices?: number[]
}

export interface DbFfdTrackJson {
  slot?: string
  name?: string
  frame?: DbFfdFrameJson[]
}

export interface DbZOrderFrameJson {
  duration?: number
  zOrder?: number[]
}

export interface DbEventFrameJson {
  duration?: number
  event?: { name?: string; data?: { int?: number; float?: number; string?: string } }
  action?: { name?: string; data?: { int?: number; float?: number; string?: string } }
}

export interface DbIkTrackJson {
  name?: string
  frame?: Array<{ duration?: number; weight?: number }>
}

export interface DbAnimationJson {
  name?: string
  duration?: number
  playTimes?: number
  frameRate?: number
  bone?: DbBoneTrackJson[]
  slot?: DbSlotTrackJson[]
  ffd?: DbFfdTrackJson[]
  zOrder?: { frame?: DbZOrderFrameJson[] }
  frame?: DbEventFrameJson[]
  ik?: DbIkTrackJson[]
}

export interface DbArmatureJson {
  type?: string
  name?: string
  frameRate?: number
  bone?: DbBoneJson[]
  slot?: DbSlotJson[]
  skin?: DbSkinJson[]
  ik?: DbIkJson[]
  animation?: DbAnimationJson[]
}

export interface DbJson {
  frameRate?: number
  name?: string
  version?: string
  armature?: DbArmatureJson[]
}
