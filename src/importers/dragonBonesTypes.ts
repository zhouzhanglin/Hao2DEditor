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

/**
 * DragonBones 的「动作」（`actions` 数组里的一项）。
 *
 * 实际只用到 `gotoAndPlay` / `gotoAndStop`：它们挂在**嵌套骨架 display 所在插槽**上，
 * 用来指定子骨架播哪个动画。`playTimes` 在部分导出器里会带（0 = 循环）。
 */
export interface DbActionJson {
  gotoAndPlay?: string
  gotoAndStop?: string
  playTimes?: number
}

export interface DbSlotJson {
  name: string
  parent?: string
  displayIndex?: number
  blendMode?: number | string
  color?: DbColorJson
  z?: number
  /** 插槽级默认动作（嵌套骨架的 setup 默认动画） */
  actions?: DbActionJson[]
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
  /** display 级动作（优先级最高：skin slot → slot → display） */
  actions?: DbActionJson[]
}

export interface DbSkinSlotJson {
  name?: string
  display?: DbDisplayJson[]
  /** 皮肤插槽级默认动作（嵌套骨架的 setup 默认动画） */
  actions?: DbActionJson[]
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
  /** 该帧的子骨架动作（`gotoAndPlay` → 「子骨架」通道关键帧） */
  actions?: DbActionJson[]
  /**
   * 层级键（DB 4.5+）：插槽绘制顺序的排序键，升序绘制、同 z 保持静态顺序。
   * 动画重新给插槽赋 z 就是「层级变化动画」（Demon 的每个动画都用它）。
   */
  z?: number
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
  /** 骨架级默认动作（类似 Unity Animator 的默认状态） */
  defaultActions?: DbActionJson[]
}

export interface DbJson {
  frameRate?: number
  name?: string
  version?: string
  armature?: DbArmatureJson[]
}
