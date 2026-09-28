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
  bone?: string
  target?: string
  bendPositive?: boolean
  weight?: number
}

export interface DbBoneFrameJson {
  duration?: number
  tweenEasing?: number | null
  transform?: DbTransformJson
}

export interface DbBoneTrackJson {
  name?: string
  frame?: DbBoneFrameJson[]
}

export interface DbSlotFrameJson {
  duration?: number
  tweenEasing?: number | null
  displayIndex?: number
  color?: DbColorJson
}

export interface DbSlotTrackJson {
  name?: string
  frame?: DbSlotFrameJson[]
}

export interface DbFfdFrameJson {
  duration?: number
  tweenEasing?: number | null
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
